/**
 * End-to-end tests for OpenCode 2: a real `opencode2 serve` process, the plugin
 * loaded from source, and a mock OpenAI-compatible model server that records the
 * exact HTTP request bodies.
 *
 * `opencode2 run` deadlocks in its private `serve --stdio` child on some builds,
 * so this drives a standalone `serve` over its HTTP API instead: read the URL and
 * password it prints, build a Basic-auth client, create a session, prompt.
 *
 * Opt-in: `npm run test:e2e:v2` (needs `opencode2` on PATH or OPENCODE2_BIN).
 */

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import fs from "node:fs"
import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"

import { OpenCode } from "@opencode/client"

const enabled = process.env.OPENCODE_E2E_V2 === "1"
const OPENCODE2 = process.env.OPENCODE2_BIN || "opencode2"
const here = path.dirname(fileURLToPath(import.meta.url))
// This OpenCode 2 build auto-discovers a plugin only from the global plugins
// dir. Point that at the package's real shared entrypoint so the e2e exercises
// the exact default export users install.
const pluginEntry = path.resolve(here, "../src/index.ts")

const SUMMARY_TEXT = "MOCK SUMMARY: objective, files changed, next steps."

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((p: any) => (typeof p === "string" ? p : (p?.text ?? ""))).join("\n")
      : ""
const allText = (messages: any[]): string =>
  (messages ?? []).map((m) => textOf(m?.content)).join("\n")

function startMockModel() {
  const requests: Array<{ body: any }> = []
  const server = http.createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ object: "list", data: [{ id: "test-model", object: "model" }] }))
        return
      }
      if (!(req.method === "POST" && req.url?.startsWith("/v1/chat/completions"))) {
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
      const usage = { prompt_tokens: 90_000, completion_tokens: 8, total_tokens: 90_008 }
      const model = body.model ?? "test-model"
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
      res.write(sse(chunk([{ index: 0, delta: { role: "assistant", content: SUMMARY_TEXT }, finish_reason: null }])))
      res.write(sse(chunk([{ index: 0, delta: {}, finish_reason: "stop" }], { usage })))
      res.write("data: [DONE]\n\n")
      res.end()
    })
  })
  return new Promise<{
    baseURL: string
    requests: Array<{ body: any }>
    close: () => void
  }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number }
      resolve({
        baseURL: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () => server.close(),
      })
    })
  })
}

const summaryFor = (mock: { requests: Array<{ body: any }> }) =>
  mock.requests.find((r) => /handoff summary/i.test(allText(r.body.messages)))
const count = (mock: { requests: Array<{ body: any }> }, re: RegExp) =>
  mock.requests
    .map((r) => (allText(r.body.messages).match(re) ?? []).length)
    .reduce((a, b) => a + b, 0)

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 60_000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = fn()
    if (value !== undefined) return value
    if (Date.now() > deadline) return undefined
    await new Promise((r) => setTimeout(r, 50))
  }
}

type Mock = Awaited<ReturnType<typeof startMockModel>>

let mock: Mock
let home: string
let child: ChildProcess
let client: ReturnType<typeof OpenCode.make>
let serverLog = ""

before(async () => {
  if (!enabled) return
  mock = await startMockModel()
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cache-compact-e2e-v2-"))
  fs.writeFileSync(path.join(home, "probe.txt"), "hello probe\n")

  const globalPlugins = path.join(home, "config", "opencode", "plugins")
  fs.mkdirSync(globalPlugins, { recursive: true })
  fs.writeFileSync(
    path.join(globalPlugins, "cache-compact.ts"),
    `export { default } from ${JSON.stringify(pluginEntry)}\n`,
  )

  const config = {
    $schema: "https://opencode.ai/config.json",
    model: "mock/test-model",
    compaction: { auto: false },
    providers: {
      mock: {
        package: "aisdk:@ai-sdk/openai-compatible",
        name: "Mock",
        settings: { baseURL: mock.baseURL, apiKey: "test" },
        models: {
          "test-model": {
            name: "Test Model",
            tool_call: true,
            limit: { context: 100_000, output: 4_096 },
          },
        },
      },
    },
    permission: { edit: "allow", bash: "allow" },
  }
  fs.writeFileSync(path.join(home, "opencode.json"), JSON.stringify(config, null, 2))

  const env = {
    ...process.env,
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_STATE_HOME: path.join(home, "state"),
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
  }

  child = spawn(OPENCODE2, ["serve", "--port", "0"], { cwd: home, env })
  child.stderr?.on("data", (d: Buffer) => (serverLog += d.toString()))
  child.stdout?.on("data", (d: Buffer) => (serverLog += d.toString()))
  const { url, password } = await new Promise<{ url: string; password: string }>(
    (resolve, reject) => {
      let buffer = ""
      const timer = setTimeout(() => reject(new Error("timed out waiting for opencode2 serve")), 90_000)
      const onData = (d: Buffer) => {
        buffer += d.toString()
        const u = buffer.match(/http:\/\/127\.0\.0\.1:\d+/)
        const p = buffer.match(/server password (\S+)/)
        if (u && p) {
          clearTimeout(timer)
          child.stdout?.off("data", onData)
          resolve({ url: u[0], password: p[1]! })
        }
      }
      child.stdout?.on("data", onData)
      child.once("exit", (code) => {
        clearTimeout(timer)
        reject(new Error(`opencode2 serve exited early (code ${code})`))
      })
    },
  )

  client = OpenCode.make({
    baseUrl: url,
    headers: {
      authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64"),
    },
  })
})

after(() => {
  if (!enabled) return
  child?.kill("SIGKILL")
  mock?.close()
  if (home) fs.rmSync(home, { recursive: true, force: true })
})

test(
  "v2: trips, summarizes, cuts the context, and resumes",
  { skip: enabled ? false : "set OPENCODE_E2E_V2=1 to run (spawns opencode2)", timeout: 180_000 },
  async () => {
    const session: any = await client.session.create({})
    const sessionID = session?.id ?? session?.data?.id
    assert.ok(sessionID, "no session created")

    await client.session
      .prompt({ sessionID, text: "hello from the v2 e2e test" } as any)
      .catch((error) => console.error(">> prompt failed:", String(error)))

    const summaryReq = await waitFor(() => summaryFor(mock))
    if (!summaryReq) {
      console.error(`>> model requests: ${mock.requests.length}`)
      console.error(
        ">> cache-compact logs:\n" +
          serverLog
            .split("\n")
            .filter((l) => l.includes("cache-compact"))
            .slice(-40)
            .join("\n"),
      )
      console.error(">> server log tail:\n" + serverLog.slice(-1500))
      try {
        const plugins: any = await client.plugin.list()
        const ids = (plugins?.data ?? []).map((p: any) => p.id)
        console.error(">> active plugins:", JSON.stringify(ids))
        console.error(">> cache-compact active:", ids.includes("cache-compact"))
      } catch (error) {
        console.error(">> plugin.list failed:", String(error))
      }
      try {
        const logDir = path.join(home, "data", "opencode", "log")
        for (const f of fs.existsSync(logDir) ? fs.readdirSync(logDir) : []) {
          const content = fs.readFileSync(path.join(logDir, f), "utf8")
          const lines = content
            .split("\n")
            .filter((l) => /cache-compact|plugin|error|Error|fail/i.test(l))
            .slice(-40)
          if (lines.length) console.error(`>> ${f}:\n${lines.join("\n")}`)
        }
      } catch (error) {
        console.error(">> log read failed:", String(error))
      }
      try {
        const ctx: any = await client.session.context({ sessionID } as any)
        console.error(">> session context:", JSON.stringify(ctx, null, 2).slice(0, 2000))
      } catch (error) {
        console.error(">> context read failed:", String(error))
      }
    }
    assert.ok(summaryReq, "plugin never sent the summary turn")

    const summaryIndex = mock.requests.indexOf(summaryReq!)
    const cutReq = await waitFor(() =>
      mock.requests
        .slice(summaryIndex + 1)
        .find((r) => /Prior work summary/i.test(allText(r.body.messages))),
    )
    assert.ok(cutReq, "no cut request after the summary")

    const before = allText(summaryReq!.body.messages)
    const afterText = allText(cutReq!.body.messages)
    assert.match(before, /hello from the v2 e2e test/)
    assert.match(before, /handoff summary/i)
    assert.doesNotMatch(afterText, /hello from the v2 e2e test/)
    assert.match(afterText, /Prior work summary/)
    assert.match(afterText, /MOCK SUMMARY/)
    assert.match(afterText, /continue from where you left off/i)

    assert.equal(
      mock.requests.filter((r) => /handoff summary/i.test(allText(r.body.messages))).length,
      1,
      "should summarize exactly once",
    )
    assert.equal(count(mock, /continue from where you left off/gi), 1, "should resume exactly once")
  },
)
