/**
 * OpenCode 2 adapter.
 *
 * Same core state machine as the V1 adapter, wired to the OpenCode 2 plugin API
 * (`@opencode/plugin`): a default export `{ id, setup(ctx) }`, session hooks for
 * the request context, and an event subscription for usage.
 *
 * Deliberate differences from V1, all forced by the V2 API:
 *   - Usage is not pushed on an event. The plugin subscribes to session
 *     execution events and reads the last assistant message's `tokens` from
 *     `ctx.session.context()`.
 *   - `session.prompt` admits a turn; the assistant reply is read back from the
 *     session context, and the cut locates the boundary by the summary prompt
 *     text because V2's model-visible messages do not carry stable ids.
 *   - There is no `compaction.prune`; V2 uses checkpoint compaction. See README.
 *
 * Types are used where the published V2 types are usable; the generated client
 * request types are cast where the beta codegen is not.
 */

import type { Plugin as V2 } from "@opencode/plugin"
import { contentText, cutV2Messages, type AnyMessageV2 } from "./cut.ts"
import {
  createCore,
  tokenTotal,
  type CacheCompactOptions,
  type Host,
  type SummaryReply,
} from "./core.ts"

type Ctx = Parameters<V2.Plugin["setup"]>[0]

const promptText = (ctx: Ctx, sessionID: string, text: string): Promise<unknown> =>
  (ctx.session as any).prompt({ sessionID, text })

const readContext = async (ctx: Ctx, sessionID: string): Promise<any[]> => {
  const list = await (ctx.session as any).context({ sessionID })
  return Array.isArray(list) ? list : []
}

/**
 * `session.prompt` admits the summary turn; poll the session context until the
 * assistant reply lands so the core can capture the summary text and the ids V2
 * does expose.
 */
async function waitForSummary(
  ctx: Ctx,
  sessionID: string,
  prompt: string,
  timeoutMs = 120_000,
): Promise<SummaryReply> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const list = await readContext(ctx, sessionID)
      let boundary = -1
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i]?.type === "user" && list[i]?.text === prompt) {
          boundary = i
          break
        }
      }
      if (boundary >= 0) {
        for (let i = boundary + 1; i < list.length; i++) {
          const message = list[i]
          if (message?.type === "assistant") {
            const text = contentText(message)
            if (text) {
              return {
                boundaryUserID: list[boundary]?.id,
                summaryAssistantID: message?.id,
                text,
              }
            }
          }
        }
      }
    } catch {
      /* context not ready yet */
    }
    if (Date.now() > deadline) return {}
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

export function createV2(options: CacheCompactOptions = {}): V2.Plugin {
  return {
    id: "cache-compact",
    async setup(ctx: Ctx) {
      const debug = options.debug ?? false

      const host: Host = {
        log(level, message, extra = {}) {
          // Debug and info are opt-in; warnings and errors always surface.
          if ((level === "debug" || level === "info") && !debug) return
          // Never write to a terminal: it corrupts the interactive TUI.
          if (process.stderr.isTTY) return
          try {
            process.stderr.write(
              `[cache-compact] ${level} ${message} ${JSON.stringify(extra)}\n`,
            )
          } catch {
            /* never throw from logging */
          }
        },

        async summarize(sessionID, prompt) {
          await promptText(ctx, sessionID, prompt)
          return await waitForSummary(ctx, sessionID, prompt)
        },

        async sendText(sessionID, text) {
          await promptText(ctx, sessionID, text)
        },

        async abort(sessionID) {
          await (ctx.session as any).interrupt({ sessionID })
        },

        async contextLimit(providerID, modelID) {
          const fromRecord = (record: any): number => {
            const model =
              record?.models?.get?.(modelID) ?? record?.models?.[modelID]
            const context = model?.limit?.context
            return typeof context === "number" && context > 0 ? context : 0
          }
          // Prefer the catalog record if a build populates it...
          try {
            const found = fromRecord((ctx.model as any)?.provider?.get?.(providerID))
            if (found) return found
          } catch {
            /* fall through */
          }
          // ...otherwise `model.list` is the source that carries model windows
          // in this build.
          try {
            const listed: any = await (ctx.model as any)?.list?.({})
            const models: any[] = listed?.data ?? listed ?? []
            const model = models.find(
              (m: any) =>
                m?.providerID === providerID &&
                (m?.modelID === modelID || m?.id === modelID),
            )
            const context = model?.limit?.context
            if (typeof context === "number" && context > 0) return context
            if (debug) {
              process.stderr.write(
                `[cache-compact] debug no window for ${providerID}/${modelID} among ${models.length} models\n`,
              )
            }
          } catch (error) {
            if (debug) {
              process.stderr.write(
                `[cache-compact] debug contextLimit failed for ${providerID}/${modelID}: ${String(error)}\n`,
              )
            }
          }
          return 0
        },
      }

      const core = createCore(host, options)
      const controller = new AbortController()

      /** Feed the most recent assistant message's usage to the core. */
      const refresh = async (sessionID: string): Promise<void> => {
        try {
          const list = await readContext(ctx, sessionID)
          for (let i = list.length - 1; i >= 0; i--) {
            const message = list[i]
            if (message?.type === "assistant") {
              core.onAssistantMessage({
                sessionID,
                id: message.id,
                providerID: message.model?.providerID,
                modelID: message.model?.id,
                used: tokenTotal(message.tokens),
                ignore: Boolean(message.error),
              })
              return
            }
          }
        } catch {
          /* ignore transient context read failures */
        }
      }

      const registrations = [
        await ctx.session.hook("context", (event: any) => {
          const sessionID = event?.sessionID
          if (!sessionID) return
          core.captureModel(
            sessionID,
            event?.model?.providerID,
            event?.model?.id,
          )

          // While summarizing, keep the handoff short and cheap.
          if (core.isPending(sessionID)) {
            try {
              const opts: any = (event.options ??= {})
              if (
                typeof opts.maxTokens !== "number" ||
                opts.maxTokens > core.options.summaryMaxTokens
              ) {
                opts.maxTokens = core.options.summaryMaxTokens
              }
              opts.reasoningEffort ??= "low"
            } catch {
              /* options are best-effort */
            }
          }

          const info = core.cutInfo(sessionID)
          if (!info?.prompt || !info?.text) return
          const messages = event?.messages as AnyMessageV2[] | undefined
          if (Array.isArray(messages) && messages.length > 0) {
            cutV2Messages(messages, info.prompt, info.text)
          }
        }),
      ]

      // Usage is not pushed; refresh from the session whenever a step or turn
      // settles. `session.execution.*` gives mid-turn granularity.
      void (async () => {
        for await (const event of ctx.event.subscribe({
          signal: controller.signal,
        })) {
          const type = (event as any)?.type
          const data: any = (event as any)?.data ?? {}
          const sessionID: string | undefined = data?.sessionID
          if (!sessionID) continue
          if (
            type === "session.execution.succeeded" ||
            type === "session.execution.failed" ||
            type === "session.execution.interrupted"
          ) {
            await refresh(sessionID)
          } else if (type === "session.status") {
            if (data?.status?.type === "idle") core.onIdle(sessionID)
            else await refresh(sessionID)
          } else if (type === "session.idle") {
            core.onIdle(sessionID)
          } else if (type === "session.deleted") {
            core.onDeleted(data?.info?.id ?? sessionID)
          }
        }
      })().catch(() => {})

      return async () => {
        controller.abort()
        await Promise.all(
          registrations.map((registration) =>
            Promise.resolve(registration?.dispose?.()),
          ),
        )
      }
    },
  }
}

export default createV2
