/**
 * OpenCode V1 adapter.
 *
 * Wire the OpenCode V1 hooks (`PluginInput` + returned hooks object) onto the
 * runtime-agnostic core. The interesting behaviour lives in `core.ts`; this file
 * only translates OpenCode's V1 API shapes (client calls, events, the
 * `{info, parts}` message list) into the host contract and core signals.
 */

import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import type { AssistantMessage, Event } from "@opencode-ai/sdk"
import { cutMessages, extractText, type AnyMessage } from "./cut.ts"
import {
  createCore,
  tokenTotal,
  __resetSharedState,
  type CacheCompactOptions,
  type Host,
  type LogLevel,
} from "./core.ts"

export type { CacheCompactOptions } from "./core.ts"
export { __resetSharedState }

export const createServer = (
  input: PluginInput,
  options: CacheCompactOptions = {},
): Awaited<ReturnType<Plugin>> => {
  const { client } = input
  const debug = options.debug ?? false

  const sendText = (sessionID: string, text: string): Promise<any> =>
    Promise.resolve(
      client.session.prompt({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text }] },
      }),
    )

  const host: Host = {
    log(level: LogLevel, message: string, extra: Record<string, unknown> = {}) {
      try {
        // Also to stderr so it shows up in `docker logs paseo` when debugging —
        // but never when stderr is a terminal, or it corrupts the TUI's input.
        if (debug && !process.stderr.isTTY) {
          process.stderr.write(
            `[cache-compact] ${level} ${message} ${JSON.stringify(extra)}\n`,
          )
        }
        client.app
          ?.log?.({ body: { service: "cache-compact", level, message, extra } })
          ?.catch?.(() => {})
      } catch {
        /* never throw from logging */
      }
    },

    async summarize(sessionID, prompt) {
      const res: any = await sendText(sessionID, prompt)
      const payload = res?.data ?? res
      const info = payload?.info as AssistantMessage | undefined
      const text = extractText(payload?.parts ?? [])
      if (info?.role === "assistant" && info.id) {
        return {
          boundaryUserID: info.parentID,
          summaryAssistantID: info.id,
          text,
        }
      }
      return { text }
    },

    async sendText(sessionID, text) {
      await sendText(sessionID, text)
    },

    async abort(sessionID) {
      await client.session.abort({ path: { id: sessionID } })
    },

    async contextLimit(providerID, modelID) {
      // No list cache here: the core caches resolved limits per model, and a
      // cached list could pin a transient miss. A failed lookup returns 0 and
      // is retried on the next trip.
      const res: any = await client.provider.list()
      const all = res?.data?.all ?? []
      const provider = all.find((p: any) => p?.id === providerID)
      const context = provider?.models?.[modelID]?.limit?.context
      return typeof context === "number" && context > 0 ? context : 0
    },
  }

  const core = createCore(host, options)

  const usedTokens = (info: AssistantMessage): number =>
    tokenTotal(info.tokens)

  const onAssistantMessage = (info: AssistantMessage): void => {
    // OpenCode's own compaction summaries and our summary reply both report the
    // pre-cut token count; never let them re-trip.
    if (info.summary || info.error) return
    // `time.completed` is only set when the *whole turn* ends, but a step's
    // usage lands at `step-finish`, which sets `finish`. Requiring `completed`
    // made the trigger wait for the turn to end — too late for a long agentic
    // turn, which can overflow the context before it ever idles.
    if (!info.finish && !info.time?.completed) return
    core.onAssistantMessage({
      sessionID: info.sessionID,
      id: info.id,
      providerID: info.providerID,
      modelID: info.modelID,
      used: usedTokens(info),
    })
  }

  /**
   * The reliable mid-turn signal: every step emits a `step-finish` part carrying
   * the exact usage. `message.updated` at step level does not always reach
   * plugins, but `message.part.updated` does.
   */
  const onStepFinish = (part: any): void => {
    core.onStep({
      sessionID: part?.sessionID,
      messageID: part?.messageID,
      used: tokenTotal(part?.tokens),
    })
  }

  const hooks: Awaited<ReturnType<Plugin>> = {
    config: async (config) => {
      if (!(options.disablePrune ?? true)) return
      const mutable = config as any
      const compaction: any = (mutable.compaction ??= {})
      if (compaction.prune === undefined) compaction.prune = false
    },

    event: async ({ event }: { event: Event }) => {
      if (event.type === "message.part.updated") {
        const part = (event.properties as any)?.part
        if (part?.type === "step-finish") onStepFinish(part)
        return
      }
      if (event.type === "message.updated") {
        const info = event.properties.info
        if (info.role === "assistant") onAssistantMessage(info)
        return
      }
      if (event.type === "session.idle") {
        // Fallback: message.updated already fires this, but idle catches the
        // case where the last assistant message never completed.
        core.onIdle(event.properties.sessionID)
        return
      }
      if (event.type === "session.deleted") {
        const id = (event.properties as any)?.info?.id
        if (id) core.onDeleted(id)
      }
    },

    "chat.params": async (hookInput, output) => {
      // The step-finish part carries no provider/model; capture them here, on
      // every request, so the trip can resolve the model's context limit.
      core.captureModel(
        hookInput.sessionID,
        hookInput.model?.providerID,
        hookInput.model?.id,
      )
      if (!core.isPending(hookInput.sessionID)) return
      const max = output.maxOutputTokens
      const cap = core.options.summaryMaxTokens
      if (typeof max !== "number" || max > cap) {
        output.maxOutputTokens = cap
      }
      if (output.options && typeof output.options === "object") {
        output.options = {
          ...output.options,
          reasoningEffort: (output.options as any).reasoningEffort ?? "low",
        }
      }
    },

    "experimental.chat.messages.transform": async (_hookInput, output) => {
      const messages = output.messages as unknown as AnyMessage[]
      if (!Array.isArray(messages) || messages.length === 0) return
      const sessionID = messages[0]?.info?.sessionID
      if (!sessionID) return
      const keys = core.cutKeys(sessionID)
      if (!keys?.boundaryUserID || !keys.summaryAssistantID) return
      cutMessages(messages, keys.boundaryUserID, keys.summaryAssistantID)
    },
  }

  return hooks
}

export const CacheCompact: Plugin = async (input, options) =>
  createServer(input, (options ?? {}) as CacheCompactOptions)

export default CacheCompact
