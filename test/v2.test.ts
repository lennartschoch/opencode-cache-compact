import { test, beforeEach } from "node:test"
import assert from "node:assert/strict"

import { createV2 } from "../src/v2.ts"
import { __resetSharedState } from "../src/core.ts"

beforeEach(() => __resetSharedState())

const LIMIT = 10_000

type Call = { name: string; args?: any }

/** A minimal stand-in for the OpenCode 2 plugin Context. */
function makeCtx(calls: Call[]) {
  const contextHandlers: Array<(event: any) => void> = []
  const sessions = new Map<string, any[]>()
  const queue: any[] = []
  let wake: (() => void) | undefined

  const seeded = (sessionID: string, message: any) => {
    const list = sessions.get(sessionID) ?? []
    list.push(message)
    sessions.set(sessionID, list)
  }

  const ctx: any = {
    session: {
      async hook(name: string, cb: (event: any) => void) {
        calls.push({ name: "hook", args: name })
        if (name === "context") contextHandlers.push(cb)
        return { dispose: async () => {} }
      },
      async prompt(input: any) {
        calls.push({ name: "prompt", args: input })
        const list = sessions.get(input.sessionID) ?? []
        if (/handoff summary/i.test(input.text)) {
          list.push({ id: "sum_req", type: "user", text: input.text, time: { created: 0 } })
          list.push({
            id: "sum",
            type: "assistant",
            content: [{ type: "text", text: "MY SUMMARY" }],
            model: { providerID: "p", id: "m" },
            tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          })
        } else {
          list.push({ id: `u${list.length}`, type: "user", text: input.text, time: { created: 0 } })
        }
        sessions.set(input.sessionID, list)
        return { id: "inbox" }
      },
      async interrupt(input: any) {
        calls.push({ name: "interrupt", args: input })
      },
      async context(input: any) {
        return sessions.get(input.sessionID) ?? []
      },
    },
    model: {
      async list() {
        return {
          data: [
            {
              id: "m",
              modelID: "m",
              providerID: "p",
              limit: { context: LIMIT, output: 4096 },
            },
          ],
        }
      },
    },
    event: {
      subscribe() {
        return (async function* () {
          for (;;) {
            if (queue.length) {
              yield queue.shift()
              continue
            }
            await new Promise<void>((resolve) => (wake = resolve))
          }
        })()
      },
    },
  }

  const push = (event: any) => {
    queue.push(event)
    wake?.()
    wake = undefined
  }

  const emitContext = (event: any) => {
    for (const handler of contextHandlers) handler(event)
  }

  return { ctx, seeded, push, emitContext }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
const prompts = (calls: Call[]) => calls.filter((c) => c.name === "prompt")
const assistant = (sessionID: string, id: string, used: number) => ({
  id,
  type: "assistant" as const,
  content: [{ type: "text", text: "ok" }],
  model: { providerID: "p", id: "m" },
  tokens:
    used > 0
      ? { total: used, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
      : { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})

test("v2: summarizes on a crossing step, then cuts the outgoing messages", async () => {
  const calls: Call[] = []
  const { ctx, seeded, push, emitContext } = makeCtx(calls)
  const plugin = createV2({ threshold: 50, abortOnTrip: false, autoResume: false, abortSettleMs: 0, models: ["p/m"] })
  await plugin.setup(ctx)

  seeded("s1", assistant("s1", "a1", 8_000))
  push({ type: "session.execution.succeeded", data: { sessionID: "s1" } })
  await settle()

  assert.equal(prompts(calls).length, 1, "should request one summary")
  assert.match(prompts(calls)[0]!.args.text, /handoff summary/i)

  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "the original task" }] },
    { role: "user", content: [{ type: "text", text: prompts(calls)[0]!.args.text }] },
    { role: "assistant", content: [{ type: "text", text: "MY SUMMARY" }] },
    { role: "user", content: [{ type: "text", text: "continue" }] },
  ]
  emitContext({ sessionID: "s1", model: { providerID: "p", id: "m" }, messages })

  assert.equal(messages.length, 2, "old history and the summary reply are dropped")
  assert.equal(messages[0]!.content[0]!.text, "## Prior work summary\n\nMY SUMMARY")
  assert.equal(messages[1]!.content[0]!.text, "continue")
})

test("v2: does not re-summarize after a summary until the cut is observed", async () => {
  const realNow = Date.now
  let now = 1_000_000
  Date.now = () => now
  try {
    const calls: Call[] = []
    const { ctx, seeded, push } = makeCtx(calls)
    const plugin = createV2({ threshold: 50, abortOnTrip: false, autoResume: false, abortSettleMs: 0, models: ["p/m"] })
    await plugin.setup(ctx)

    seeded("s1", assistant("s1", "a1", 8_000))
    push({ type: "session.execution.succeeded", data: { sessionID: "s1" } })
    await settle()
    assert.equal(prompts(calls).length, 1)

    // A stale pre-cut completion, past the cooldown, must not re-summarize.
    now += 31_000
    seeded("s1", assistant("s1", "a2", 8_000))
    push({ type: "session.execution.succeeded", data: { sessionID: "s1" } })
    await settle()
    assert.equal(prompts(calls).length, 1)

    // Usage back under the threshold re-arms; a later crossing summarizes again.
    now += 31_000
    seeded("s1", assistant("s1", "a3", 1_000))
    push({ type: "session.execution.succeeded", data: { sessionID: "s1" } })
    await settle()
    seeded("s1", assistant("s1", "a4", 8_000))
    push({ type: "session.execution.succeeded", data: { sessionID: "s1" } })
    await settle()
    assert.equal(prompts(calls).length, 2)
  } finally {
    Date.now = realNow
  }
})
