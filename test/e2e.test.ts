/**
 * End-to-end tests: one real `opencode serve` process, the real plugin loaded
 * from source, and a mock OpenAI-compatible model server that records the exact
 * HTTP request bodies.
 *
 *   1. a plain turn — trips, summarizes, cuts, resumes;
 *   2. a tool-call loop that never idles — the trip must fire mid-turn, which is
 *      the regression that let a long agentic turn overflow before summarizing.
 *
 * One server is shared across both tests (startup ~0.6s); each test drives its
 * own session and resets the recorder. Opt-in: `npm run test:e2e`.
 *
 * The mock reports 70k prompt tokens on every response. With a 100k context and
 * threshold 50, that trips on the first step.
 */

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import fs from "node:fs"
import { fileURLToPath } from "node:url"

import { createOpencodeClient, createOpencodeServer } from "@opencode-ai/sdk"

const enabled = process.env.OPENCODE_E2E === "1"
const here = path.dirname(fileURLToPath(import.meta.url))
const pluginUrl = `file://${path.resolve(here, "../src/index.ts")}`

const SUMMARY_TEXT = "MOCK SUMMARY: objective, files changed, next steps."
const TOOL_MARKER = "TOOL_LOOP"

type Recorded = { body: any }

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content.map((p: any) => (typeof p === "string" ? p : (p?.text ?? ""))).join("\n")
  }
  return ""
}

function allText(messages: any[]): string {
  return (messages ?? []).map((m) => textOf(m?.content)).join("\n")
}

function startMockModel(readPath: string) {
  const requests: Recorded[] = []
  let toolCalls = 0

  const server = http.createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ object: "list", data: [{ id: "test-model", object: "model" }] }))
        return
      }
      if (req.method !== "POST" || !req.url?.startsWith("/v1/chat/completions")) {
        res.writeHead(404).end()
        return
      }

      let body: any = {}
      try {
        body = JSON.parse(raw || "{}")
      } catch {
        /* ignore */
      }
      requests.push({ body })

      const usage = { prompt_tokens: 70_000, completion_tokens: 8, total_tokens: 70_008 }
      const model = body.model ?? "test-model"
      const lastUser = [...(body.messages ?? [])].reverse().find((m: any) => m.role === "user")
      const lastUserText = textOf(lastUser?.content)
      const isSummary = /handoff summary/i.test(lastUserText)
      const isResume = /continue from where you left off/i.test(lastUserText)
      // Only the agent request carries tools; title/summary side-requests do not.
      const agentRequest = Array.isArray(body.tools) && body.tools.length > 0
      const wantToolCall =
        agentRequest &&
        !isSummary &&
        !isResume &&
        lastUserText.includes(TOOL_MARKER) &&
        toolCalls < 8

      const sse = (p: unknown) => `data: ${JSON.stringify(p)}\n\n`
      const chunk = (choices: any[], extra: any = {}) => ({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: Date.now(),
        model,
        choices,
        ...extra,
      })

      if (body.stream === false) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion",
            created: Date.now(),
            model,
            choices: [
              { index: 0, message: { role: "assistant", content: SUMMARY_TEXT }, finish_reason: "stop" },
            ],
            usage,
          }),
        )
        return
      }

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      })

      if (wantToolCall) {
        toolCalls++
        res.write(
          sse(
            chunk([
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_${toolCalls}`,
                      type: "function",
                      function: { name: "read", arguments: "" },
                    },
                  ],
                },
                finish_reason: null,
              },
            ]),
          ),
        )
        res.write(
          sse(
            chunk([
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 0, function: { arguments: JSON.stringify({ filePath: readPath }) } },
                  ],
                },
                finish_reason: null,
              },
            ]),
          ),
        )
        res.write(sse(chunk([{ index: 0, delta: {}, finish_reason: "tool_calls" }], { usage })))
        res.write("data: [DONE]\n\n")
        res.end()
        return
      }

      res.write(sse(chunk([{ index: 0, delta: { role: "assistant", content: SUMMARY_TEXT }, finish_reason: null }])))
      res.write(sse(chunk([{ index: 0, delta: {}, finish_reason: "stop" }], { usage })))
      res.write("data: [DONE]\n\n")
      res.end()
    })
  })

  return new Promise<{
    baseURL: string
    requests: Recorded[]
    reset: () => void
    close: () => void
  }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number }
      resolve({
        baseURL: `http://127.0.0.1:${port}/v1`,
        requests,
        reset: () => {
          requests.length = 0
          toolCalls = 0
        },
        close: () => server.close(),
      })
    })
  })
}

const summaryFor = (mock: { requests: Recorded[] }) =>
  mock.requests.find((r) => /handoff summary/i.test(allText(r.body.messages)))

const countResumes = (mock: { requests: Recorded[] }) =>
  mock.requests
    .map((r) => (allText(r.body.messages).match(/continue from where you left off/gi) ?? []).length)
    .reduce((a, b) => a + b, 0)

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 30_000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = fn()
    if (value !== undefined) return value
    if (Date.now() > deadline) return undefined
    await new Promise((r) => setTimeout(r, 25))
  }
}

type Mock = Awaited<ReturnType<typeof startMockModel>>

let mock: Mock
let server: { url: string; close: () => void }
let client: ReturnType<typeof createOpencodeClient>
let home: string

before(async () => {
  if (!enabled) return
  // Keep opencode's startup off the network and the filesystem watcher.
  process.env.OPENCODE_DISABLE_MODELS_FETCH = "1"
  process.env.OPENCODE_DISABLE_AUTOUPDATE = "1"
  process.env.OPENCODE_DISABLE_LSP_DOWNLOAD = "1"
  process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = "1"
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cache-compact-e2e-"))
  process.env.XDG_DATA_HOME = path.join(home, "data")
  process.env.XDG_CONFIG_HOME = path.join(home, "config")
  process.env.XDG_CACHE_HOME = path.join(home, "cache")
  process.env.XDG_STATE_HOME = path.join(home, "state")

  fs.writeFileSync(path.join(home, "probe.txt"), "hello probe\n")
  // Run opencode inside the temp worktree so the `read` tool's relative path
  // resolves inside the project.
  process.chdir(home)
  mock = await startMockModel("probe.txt")

  const config: any = {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    model: "mock/test-model",
    small_model: "mock/test-model",
    plugin: [
      [
        pluginUrl,
        {
          threshold: 50,
          models: ["mock/test-model"],
          summaryMaxTokens: 200,
          abortSettleMs: 0,
        },
      ],
    ],
    compaction: { auto: false, prune: false },
    permission: { edit: "allow", bash: "allow", webfetch: "allow" },
    provider: {
      mock: {
        npm: "@ai-sdk/openai-compatible",
        name: "Mock",
        options: { baseURL: mock.baseURL, apiKey: "test" },
        models: {
          "test-model": {
            name: "Test Model",
            reasoning: false,
            tool_call: true,
            limit: { context: 100_000, output: 4_096 },
          },
        },
      },
    },
  }
  server = await createOpencodeServer({ config, timeout: 60_000 })
  client = createOpencodeClient({ baseUrl: server.url })
})

after(() => {
  if (!enabled) return
  server?.close()
  mock?.close()
  if (home) fs.rmSync(home, { recursive: true, force: true })
})

async function newSession(title: string, text: string): Promise<string> {
  mock.reset()
  const created: any = await client.session.create({ body: { title } })
  const session = created?.data ?? created
  // Fire-and-forget: in a tool-call loop the turn may not end for a while, and
  // we assert on what the mock received rather than on the prompt returning.
  client.session
    .prompt({
      path: { id: session.id },
      body: {
        model: { providerID: "mock", modelID: "test-model" },
        parts: [{ type: "text", text }],
      },
    })
    .catch(() => {})
  return session.id
}

test(
  "trips, summarizes, cuts the context, and resumes",
  { skip: enabled ? false : "set OPENCODE_E2E=1 to run (spawns opencode)", timeout: 120_000 },
  async () => {
    await newSession("e2e-plain", "hello from the e2e test")

    const summaryReq = await waitFor(() => summaryFor(mock))
    assert.ok(summaryReq, "plugin never sent the summary turn")
    const summaryIndex = mock.requests.indexOf(summaryReq!)
    const cutReq = await waitFor(() =>
      mock.requests
        .slice(summaryIndex + 1)
        .find((r) => /Prior work summary/i.test(allText(r.body.messages))),
    )
    assert.ok(cutReq, "no cut request after the summary")

    const before = allText(summaryReq!.body.messages)
    const after = allText(cutReq!.body.messages)
    assert.match(before, /hello from the e2e test/)
    assert.match(before, /handoff summary/i)
    assert.doesNotMatch(after, /hello from the e2e test/)
    assert.match(after, /Prior work summary/)
    assert.match(after, /MOCK SUMMARY/)
    assert.match(after, /continue from where you left off/i)

    assert.equal(
      mock.requests.filter((r) => /handoff summary/i.test(allText(r.body.messages))).length,
      1,
      "should summarize exactly once",
    )
    assert.equal(countResumes(mock), 1, "should resume exactly once")
  },
)

test(
  "trips mid-turn across a tool-call loop that never idles",
  { skip: enabled ? false : "set OPENCODE_E2E=1 to run (spawns opencode)", timeout: 120_000 },
  async () => {
    const sessionId = await newSession("e2e-tools", `${TOOL_MARKER}: read the probe file repeatedly`)

    const summaryReq = await waitFor(() => summaryFor(mock), 15_000)
    if (process.env.E2E_DEBUG) {
      console.error(
        `>> summary index=${summaryReq ? mock.requests.indexOf(summaryReq) : "none"} total=${mock.requests.length}`,
      )
      try {
        const msgs: any = await client.session.messages({ path: { id: sessionId } })
        const list = msgs?.data ?? msgs
        console.error(
          ">> session messages:",
          JSON.stringify(
            (list ?? []).map((m: any) => ({
              role: m.info?.role,
              error: m.info?.error,
              finish: m.info?.finish,
              tokens: m.info?.tokens,
              total: m.info?.tokens?.total,
              parts: (m.parts ?? []).map((p: any) => p.type),
            })),
            null,
            2,
          ),
        )
      } catch (e) {
        console.error(">> messages read failed", String(e))
      }
      console.error(`>> multi-step requests: ${mock.requests.length}`)
      for (const [i, r] of mock.requests.entries()) {
        console.error(
          `  #${i} msgs=${r.body.messages?.length} tools=${r.body.tools?.length} :: ${allText(r.body.messages).slice(0, 100).replace(/\n/g, " ")}`,
        )
      }
      try {
        const logDir = path.join(process.env.XDG_DATA_HOME!, "opencode", "log")
        for (const f of fs.existsSync(logDir) ? fs.readdirSync(logDir) : []) {
          const content = fs.readFileSync(path.join(logDir, f), "utf8")
          console.error(`>> ${f} tail:\n${content.split("\n").slice(-25).join("\n")}`)
        }
      } catch (e) {
        console.error(">> log read failed", String(e))
      }
    }
    assert.ok(summaryReq, "plugin never summarized the tool-call loop")

    // Must trip early, not after exhausting the tool rounds.
    const summaryIndex = mock.requests.indexOf(summaryReq!)
    assert.ok(
      summaryIndex < 4,
      `summary should land mid-turn (early), got request #${summaryIndex}`,
    )

    const cutReq = await waitFor(() =>
      mock.requests
        .slice(summaryIndex + 1)
        .find((r) => /Prior work summary/i.test(allText(r.body.messages))),
    )
    assert.ok(cutReq, "no cut request after the mid-turn summary")
    assert.doesNotMatch(allText(cutReq!.body.messages), /read the probe file repeatedly/)
    assert.equal(countResumes(mock), 1, "should resume exactly once")
  },
)
