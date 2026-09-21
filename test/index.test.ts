import { test, beforeEach } from "node:test"
import assert from "node:assert/strict"

import { createServer, __resetSharedState } from "../src/plugin.ts"

beforeEach(() => __resetSharedState())

type Call = { name: string; args: any }

function makeClient(calls: Call[], gate?: Promise<void>) {
  return {
    provider: {
      list: async () => ({
        data: { all: [{ id: "p", models: { m: { limit: { context: 10_000 } } } }] },
      }),
    },
    app: {
      log: async (input: any) => {
        calls.push({ name: "log", args: input })
      },
    },
    session: {
      abort: async (input: any) => {
        calls.push({ name: "abort", args: input })
      },
      prompt: async (input: any) => {
        calls.push({ name: "prompt", args: input })
        if (gate) await gate
        return {
          data: {
            info: {
              role: "assistant",
              id: "sum",
              parentID: "sum_req",
              providerID: "p",
              modelID: "m",
            },
            parts: [{ type: "text", text: "MY SUMMARY" }],
          },
        }
      },
    },
  }
}

const assistantTurn = (overrides: Record<string, unknown> = {}) => ({
  event: {
    type: "message.updated",
    properties: {
      info: {
        role: "assistant",
        sessionID: "s1",
        id: "a1",
        providerID: "p",
        modelID: "m",
        time: { completed: 1 },
        tokens: { input: 8_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        ...overrides,
      },
    },
  },
})

const idle = () => ({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
const settle = () => new Promise((resolve) => setTimeout(resolve, 10))
const prompts = (calls: Call[]) => calls.filter((c) => c.name === "prompt")

test("summarizes as soon as a completed turn crosses the threshold, then cuts", async () => {
  const calls: Call[] = []
  const hooks = createServer({ client: makeClient(calls) } as any, {
    threshold: 50,
    autoResume: false,
    abortSettleMs: 0,
  })

  await hooks.event!(assistantTurn() as any)
  await settle()

  assert.equal(calls.filter((c) => c.name === "abort").length, 1)
  assert.equal(prompts(calls).length, 1)
  assert.match(prompts(calls)[0]!.args.body.parts[0].text, /handoff summary/i)

  const messages: any[] = [
    { info: { id: "u1", role: "user", sessionID: "s1" }, parts: [{ type: "text", text: "task" }] },
    { info: { id: "sum_req", role: "user", sessionID: "s1" }, parts: [{ type: "text", text: "please summarize" }] },
    { info: { id: "sum", role: "assistant", sessionID: "s1" }, parts: [{ type: "text", text: "MY SUMMARY" }] },
    { info: { id: "u2", role: "user", sessionID: "s1" }, parts: [{ type: "text", text: "continue" }] },
  ]
  await hooks["experimental.chat.messages.transform"]!({}, { messages } as any)

  assert.deepEqual(
    messages.map((m) => m.info.id),
    ["sum_req", "u2"],
  )
  assert.equal(messages[0]!.parts[0]!.text, "## Prior work summary\n\nMY SUMMARY")
})

test("uses opencode's exact tokens.total (not the parts) when present", async () => {
  const calls: Call[] = []
  const hooks = createServer({ client: makeClient(calls) } as any, {
    threshold: 50,
    autoResume: false,
    abortSettleMs: 0,
  })

  // The part sums are zero; only `total` crosses 50% of the 10k limit.
  await hooks.event!(
    assistantTurn({
      tokens: { total: 8_000, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }) as any,
  )
  await settle()

  assert.equal(prompts(calls).length, 1)
})

test("trips on a step-finish part (the mid-turn signal)", async () => {
  const calls: Call[] = []
  const hooks = createServer({ client: makeClient(calls) } as any, {
    threshold: 50,
    autoResume: false,
    abortSettleMs: 0,
  })

  // Provider/model arrive on chat.params; the size arrives on the step-finish part.
  await hooks["chat.params"]!(
    { sessionID: "s1", model: { providerID: "p", id: "m" } } as any,
    { maxOutputTokens: undefined, options: {} } as any,
  )
  await hooks.event!({
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          type: "step-finish",
          sessionID: "s1",
          messageID: "a1",
          reason: "tool-calls",
          tokens: { total: 8_000, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    },
  } as any)
  await settle()

  assert.equal(prompts(calls).length, 1)
})

test("trips on a mid-turn step even though the turn is not completed", async () => {
  const calls: Call[] = []
  const hooks = createServer({ client: makeClient(calls) } as any, {
    threshold: 50,
    autoResume: false,
    abortSettleMs: 0,
  })

  // opencode sets `finish` at every step-finish but only sets `time.completed`
  // when the whole turn ends. A long agentic turn must trip mid-step.
  await hooks.event!(
    assistantTurn({ time: undefined, finish: "tool-calls" }) as any,
  )
  await settle()

  assert.equal(calls.filter((c) => c.name === "abort").length, 1)
  assert.equal(prompts(calls).length, 1)
})

test("auto-resumes after the summary so the cut lands immediately", async () => {
  const calls: Call[] = []
  const hooks = createServer({ client: makeClient(calls) } as any, {
    threshold: 50,
    autoResume: true,
    abortSettleMs: 0,
  })

  await hooks.event!(assistantTurn() as any)
  await settle()

  const sent = prompts(calls)
  assert.equal(sent.length, 2)
  assert.match(sent[1]!.args.body.parts[0].text, /continue/i)
})

test("does not summarize below the threshold", async () => {
  const calls: Call[] = []
  const hooks = createServer({ client: makeClient(calls) } as any, {
    threshold: 90,
    abortSettleMs: 0,
  })

  await hooks.event!(
    assistantTurn({
      tokens: { input: 5_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }) as any,
  )
  await hooks.event!(idle() as any)
  await settle()

  assert.equal(prompts(calls).length, 0)
})

test("does not cut before a summary exists", async () => {
  const calls: Call[] = []
  const hooks = createServer({ client: makeClient(calls) } as any, { threshold: 50 })

  const messages: any[] = [
    { info: { id: "u1", role: "user", sessionID: "s1" }, parts: [{ type: "text", text: "task" }] },
    { info: { id: "a1", role: "assistant", sessionID: "s1" }, parts: [{ type: "text", text: "ok" }] },
  ]
  await hooks["experimental.chat.messages.transform"]!({}, { messages } as any)
  assert.equal(messages.length, 2)
})

test("caps summary output and lowers reasoning effort while summarizing", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const calls: Call[] = []
  const hooks = createServer({ client: makeClient(calls, gate) } as any, {
    threshold: 50,
    summaryMaxTokens: 500,
    autoResume: false,
    abortSettleMs: 0,
  })

  await hooks.event!(assistantTurn() as any)
  // Let the detached trip() reach its `await session.prompt` (pending = true).
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  const output = { maxOutputTokens: 9999, options: {} as Record<string, any> }
  await hooks["chat.params"]!({ sessionID: "s1" } as any, output as any)
  assert.equal(output.maxOutputTokens, 500)
  assert.equal(output.options.reasoningEffort, "low")

  release()
  await settle()
})
