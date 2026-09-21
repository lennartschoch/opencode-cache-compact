/**
 * opencode-cache-compact
 *
 * A cache-friendly replacement for OpenCode's built-in compaction.
 *
 * OpenCode compacts by rebuilding a brand-new request (empty system prompt, no
 * tools, the history re-serialized into one user message). On a locally hosted
 * model with prefix caching — and especially on hybrid/recurrent architectures
 * where only one context checkpoint is kept — that request can never reuse the
 * KV cache, so the whole conversation is re-prefilled. On a 100k-token session
 * at ~200 tok/s that is ~8 minutes of silence, which the TUI/tunnel will
 * usually time out.
 *
 * This plugin instead:
 *
 *   1. Watches token usage. As soon as a completed turn crosses the threshold
 *      it aborts the in-flight turn and appends a normal user turn asking the
 *      model to write a handoff summary. It aborts because OpenCode only emits
 *      `session.idle` at the end of a whole turn; a long agentic turn would
 *      otherwise run from the threshold all the way to the context limit before
 *      the plugin got a chance. Because the summary turn is a strict append, the
 *      provider reuses the cached prefix — the prefill is nearly free and only
 *      the summary is generated.
 *
 *   2. Once the summary exists, rewrites what the model sees on every later
 *      request to `[system][tools][summary][current turn...]` via the
 *      `experimental.chat.messages.transform` hook. The on-disk session is
 *      untouched, so the TUI history stays intact. Only the summary has to be
 *      prefilled once, after which turns append to that small prefix and are
 *      cached again.
 *
 *   3. Resumes with a short "continue" turn (unless `autoResume` is off) so the
 *      cut is applied immediately and work continues on the compacted context.
 *      Without it the cut only lands on the next message a human sends.
 *
 * The plugin never calls `session.summarize()`/OpenCode compaction, so it never
 * triggers the cold rebuild.
 */

import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import type { AssistantMessage, Event } from "@opencode-ai/sdk"
import { cutMessages, extractText } from "./cut.ts"

export type CacheCompactOptions = {
  /** Percent of the model's context that trips the summary. Default 68. */
  threshold?: number
  /** Hard cap on summary output tokens. Default 1200. */
  summaryMaxTokens?: number
  /** Fallback context window if the provider reports none. Default 131072. */
  contextLimit?: number
  /** Override the summary instruction sent as a user turn. */
  summaryPrompt?: string
  /** Only act on these models, as `providerID/modelID`. Empty = all models. */
  models?: string[]
  /**
   * After the summary is written, send a short user turn so the cut is applied
   * immediately and work continues on the compacted context. Without this the
   * cut only lands on the next message a human sends. Default true.
   */
  autoResume?: boolean
  /** The turn sent when `autoResume` fires. Default "Continue from where you left off." */
  resumePrompt?: string
  /**
   * Abort the in-flight turn when the threshold is crossed, so the summary is
   * written mid-run instead of waiting for a long agentic turn to end (which can
   * overshoot the limit). Default true.
   */
  abortOnTrip?: boolean
  /** Milliseconds to let an abort settle before summarizing. Default 300. */
  abortSettleMs?: number
  /** Turn off OpenCode's `compaction.prune` (it mutates history and breaks cache). Default true. */
  disablePrune?: boolean
  /** Verbose debug logging. Default false. */
  debug?: boolean
}

const DEFAULTS = {
  threshold: 68,
  summaryMaxTokens: 1200,
  contextLimit: 131072,
  autoResume: true,
  abortOnTrip: true,
  abortSettleMs: 300,
  disablePrune: true,
  debug: false,
} as const

const DEFAULT_RESUME_PROMPT = "Continue from where you left off."

const DEFAULT_SUMMARY_PROMPT = `You are about to run out of context. Stop working on the task and write a complete handoff summary of this session so work can continue seamlessly from it in a fresh context.

Do not call any tools. Do not ask questions. Reply with the summary only.

Capture, as compactly as possible while keeping every specific that matters:
- The user's objective and any stated constraints or preferences.
- Key decisions and the reasoning behind them.
- Files created or changed, with paths, and what changed.
- The current state of the work and what is in progress.
- Errors or dead ends encountered and how they were resolved.
- The precise next steps.

Prefer concrete details (paths, commands, identifiers, versions) over generalities.`

type SessionState = {
  /** A summary request is in flight; do not trip again. */
  pending: boolean
  /** The user turn that requested the summary (becomes the cut boundary). */
  boundaryUserID?: string
  /** The assistant message holding the summary. */
  summaryAssistantID?: string
  /** Suppress re-trips until this timestamp. */
  cooldownUntil: number
  /** Exact context size of the most recent normal step (provider usage). */
  lastUsed: number
  lastProviderID?: string
  lastModelID?: string
}

/**
 * OpenCode instantiates a plugin more than once in the same process (observed:
 * twice). If each copy kept its own state, both would trip on the same event and
 * write two summaries and two resumes. Share one registry across copies, keyed
 * by session id.
 */
const shared = {
  states: new Map<string, SessionState>(),
  limitCache: new Map<string, number>(),
  providerListPromise: undefined as Promise<any[]> | undefined,
}

/** Test-only: clear the cross-instance registry. */
export function __resetSharedState(): void {
  shared.states.clear()
  shared.limitCache.clear()
  shared.providerListPromise = undefined
}

let instanceCounter = 0

export const createServer = (
  input: PluginInput,
  options: CacheCompactOptions = {},
): Awaited<ReturnType<Plugin>> => {
  const cfg = { ...DEFAULTS, ...options }
  const { client } = input

  const instanceId = ++instanceCounter
  const states = shared.states
  const limitCache = shared.limitCache

  const log = (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    extra: Record<string, unknown> = {},
  ) => {
    if (level === "debug" && !cfg.debug) return
    try {
      // Also to stderr so it shows up in `docker logs paseo` when debugging.
      if (cfg.debug) {
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
  }

  log("debug", "plugin instance created", { instanceId })

  const ensureState = (sessionID: string): SessionState => {
    let state = states.get(sessionID)
    if (!state) {
      state = { pending: false, cooldownUntil: 0, lastUsed: 0 }
      states.set(sessionID, state)
    }
    return state
  }

  const resolveLimit = async (
    providerID: string,
    modelID: string,
  ): Promise<number> => {
    const key = `${providerID}/${modelID}`
    const cached = limitCache.get(key)
    if (cached) return cached
    if (!shared.providerListPromise) {
      shared.providerListPromise = Promise.resolve(client.provider.list())
        .then((res: any) => res?.data?.all ?? [])
        .catch(() => [])
    }
    const all = await shared.providerListPromise
    const provider = all.find((p: any) => p?.id === providerID)
    const context = provider?.models?.[modelID]?.limit?.context
    const limit =
      typeof context === "number" && context > 0 ? context : cfg.contextLimit
    limitCache.set(key, limit)
    return limit
  }

  /**
   * Exact context size from opencode: `tokens.total` is the provider's
   * `total_tokens` (prompt + completion) for the request. Fall back to the sum
   * of the parts only if a provider omits it.
   */
  const sumTokens = (t: any): number => {
    if (!t) return 0
    if (typeof t.total === "number" && t.total > 0) return t.total
    return (
      (t.input ?? 0) +
      (t.output ?? 0) +
      (t.reasoning ?? 0) +
      (t.cache?.read ?? 0) +
      (t.cache?.write ?? 0)
    )
  }

  /**
   * Exact context size from opencode: `tokens.total` is the provider's
   * `total_tokens` (prompt + completion) for the request. Fall back to summing
   * the parts only if a provider omits it.
   */
  const usedTokens = (info: AssistantMessage): number => sumTokens(info.tokens)

  const sendText = (sessionID: string, text: string): Promise<any> =>
    Promise.resolve(
      client.session.prompt({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text }] },
      }),
    )

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms))

  const modelAllowed = (providerID?: string, modelID?: string): boolean => {
    if (!cfg.models?.length) return true
    if (!providerID || !modelID) return false
    return cfg.models.includes(`${providerID}/${modelID}`)
  }

  /** Append the summary turn. Returns true when a usable summary was written. */
  const summarize = async (sessionID: string): Promise<boolean> => {
    const res: any = await sendText(
      sessionID,
      cfg.summaryPrompt ?? DEFAULT_SUMMARY_PROMPT,
    )
    const payload = res?.data ?? res
    const info = payload?.info as AssistantMessage | undefined
    const text = extractText(payload?.parts ?? [])
    if (info?.role === "assistant" && text && info.parentID) {
      const state = ensureState(sessionID)
      state.boundaryUserID = info.parentID
      state.summaryAssistantID = info.id
      log("info", "summary written; cutting context from now on", {
        sessionID,
        summaryChars: text.length,
      })
      return true
    }
    log("warn", "summary response was empty; not cutting", { sessionID })
    return false
  }

  /**
   * Stop whatever turn is running, take a summary, then resume. Aborting is what
   * lets this fire mid-run: OpenCode only emits `session.idle` at the end of a
   * whole turn, and a long agentic turn can otherwise run from 70% to 100%.
   */
  const trip = async (sessionID: string): Promise<void> => {
    const state = ensureState(sessionID)
    if (state.pending) return
    state.pending = true
    let ok = false
    try {
      if (cfg.abortOnTrip) {
        try {
          await client.session.abort({ path: { id: sessionID } })
        } catch {
          /* nothing running — fine */
        }
        if (cfg.abortSettleMs > 0) await sleep(cfg.abortSettleMs)
      }
      ok = await summarize(sessionID)
    } catch (error) {
      log("error", "summary request failed", { sessionID, error: String(error) })
    } finally {
      state.lastUsed = 0
      state.cooldownUntil = Date.now() + (ok ? 30_000 : 60_000)
      state.pending = false
    }
    if (ok && cfg.autoResume) {
      try {
        await sendText(sessionID, cfg.resumePrompt ?? DEFAULT_RESUME_PROMPT)
      } catch (error) {
        log("error", "resume prompt failed", { sessionID, error: String(error) })
      }
    }
  }

  const maybeTrip = (sessionID: string): void => {
    const state = states.get(sessionID)
    if (!state || state.pending) return
    if (Date.now() < state.cooldownUntil) return
    const { lastUsed, lastProviderID, lastModelID } = state
    if (lastUsed <= 0 || !lastProviderID || !lastModelID) return
    if (!modelAllowed(lastProviderID, lastModelID)) return
    void (async () => {
      const limit = await resolveLimit(lastProviderID, lastModelID)
      if (lastUsed < limit * (cfg.threshold / 100)) return
      const current = states.get(sessionID)
      if (!current || current.pending || Date.now() < current.cooldownUntil) return
      log("info", "context threshold reached; summarizing", {
        sessionID,
        used: lastUsed,
        limit,
        threshold: cfg.threshold,
      })
      await trip(sessionID)
    })()
  }

  const onAssistantMessage = (info: AssistantMessage): void => {
    // OpenCode's own compaction summaries and our summary reply both report the
    // pre-cut token count; never let them re-trip.
    if (info.summary || info.error) return
    // `time.completed` is only set when the *whole turn* ends, but a step's
    // usage lands at `step-finish`, which sets `finish`. Requiring `completed`
    // made the trigger wait for the turn to end — too late for a long agentic
    // turn, which can overflow the context before it ever idles.
    if (!info.finish && !info.time?.completed) return

    const state = ensureState(info.sessionID)
    if (state.pending || info.id === state.summaryAssistantID) return

    const used = usedTokens(info)
    if (used <= 0) return
    state.lastUsed = used
    state.lastProviderID = info.providerID
    state.lastModelID = info.modelID
    // Fire immediately: a long agentic turn never goes idle, so waiting for
    // `session.idle` lets the context overshoot the threshold.
    maybeTrip(info.sessionID)
  }

  /**
   * The reliable mid-turn signal: every step emits a `step-finish` part carrying
   * the exact usage. `message.updated` at step level does not always reach
   * plugins, but `message.part.updated` does.
   */
  const onStepFinish = (part: any): void => {
    const used = sumTokens(part?.tokens)
    if (used <= 0) return
    const state = ensureState(part.sessionID)
    if (state.pending || part.messageID === state.summaryAssistantID) return
    state.lastUsed = used
    log("debug", "step-finish", {
      sessionID: part.sessionID,
      used,
      reason: part.reason,
    })
    maybeTrip(part.sessionID)
  }

  const hooks: Awaited<ReturnType<Plugin>> = {
    config: async (config) => {
      if (!cfg.disablePrune) return
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
        maybeTrip(event.properties.sessionID)
        return
      }
      if (event.type === "session.deleted") {
        const id = (event.properties as any)?.info?.id
        if (id) states.delete(id)
      }
    },

    "chat.params": async (hookInput, output) => {
      const state = ensureState(hookInput.sessionID)
      // The step-finish part carries no provider/model; capture them here, on
      // every request, so the trip can resolve the model's context limit.
      if (hookInput.model?.providerID) state.lastProviderID = hookInput.model.providerID
      if (hookInput.model?.id) state.lastModelID = hookInput.model.id
      if (!state.pending) return
      const max = output.maxOutputTokens
      if (typeof max !== "number" || max > cfg.summaryMaxTokens) {
        output.maxOutputTokens = cfg.summaryMaxTokens
      }
      if (output.options && typeof output.options === "object") {
        output.options = {
          ...output.options,
          reasoningEffort: (output.options as any).reasoningEffort ?? "low",
        }
      }
    },

    "experimental.chat.messages.transform": async (_hookInput, output) => {
      const messages = output.messages as any[]
      if (!Array.isArray(messages) || messages.length === 0) return
      const sessionID = messages[0]?.info?.sessionID
      if (!sessionID) return
      const state = states.get(sessionID)
      if (!state?.boundaryUserID || !state.summaryAssistantID) return
      const removed = cutMessages(
        messages,
        state.boundaryUserID,
        state.summaryAssistantID,
      )
      if (removed > 0) {
        log("debug", "cut outgoing context", {
          sessionID,
          removed,
          remaining: messages.length,
        })
      }
    },
  }

  return hooks
}

export const CacheCompact: Plugin = async (input, options) =>
  createServer(input, (options ?? {}) as CacheCompactOptions)

export default CacheCompact
