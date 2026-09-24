/**
 * Runtime-agnostic core of opencode-cache-compact.
 *
 * Both the V1 and V2 adapters drive the same state machine from here; the only
 * thing that differs between OpenCode versions is how you send a turn, abort a
 * turn, read the provider's context window, and slice the outgoing messages.
 * Everything that decides *when* to summarize and *whether* to summarize again
 * lives here so the two adapters cannot drift apart.
 *
 * The latch: a valid summary writes `armed = false`. It is only set again once a
 * step reports usage back under the threshold — i.e. once the cut demonstrably
 * landed. Without it, any high-usage completion after the cooldown re-summarizes,
 * which is exactly what `abortOnTrip: false` lets happen because the pre-cut turn
 * keeps running.
 */

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

export const DEFAULTS = {
  threshold: 68,
  summaryMaxTokens: 1200,
  contextLimit: 131072,
  autoResume: true,
  abortOnTrip: true,
  abortSettleMs: 300,
  disablePrune: true,
  debug: false,
} as const

export const DEFAULT_RESUME_PROMPT = "Continue from where you left off."

export const DEFAULT_SUMMARY_PROMPT = `You are about to run out of context. Stop working on the task and write a complete handoff summary of this session so work can continue seamlessly from it in a fresh context.

Do not call any tools. Do not ask questions. Reply with the summary only.

Capture, as compactly as possible while keeping every specific that matters:
- The user's objective and any stated constraints or preferences.
- Key decisions and the reasoning behind them.
- Files created or changed, with paths, and what changed.
- The current state of the work and what is in progress.
- Errors or dead ends encountered and how they were resolved.
- The precise next steps.

Prefer concrete details (paths, commands, identifiers, versions) over generalities.`

export type LogLevel = "debug" | "info" | "warn" | "error"

type SessionState = {
  /** A summary request is in flight; do not trip again. */
  pending: boolean
  /**
   * Whether a new summary may be requested. Cleared when a summary is written
   * and only set again once a step reports usage back under the threshold, i.e.
   * once the cut has demonstrably landed.
   */
  armed: boolean
  /** The user turn that requested the summary (becomes the cut boundary). */
  boundaryUserID?: string
  /** The assistant message holding the summary. */
  summaryAssistantID?: string
  /** Exact text of the summary request, so a version without message ids can find the boundary. */
  summaryPrompt?: string
  /** The summary text, so a version without message ids can locate the reply. */
  summaryText?: string
  /** Suppress re-trips until this timestamp. */
  cooldownUntil: number
  /** Exact context size of the most recent normal step (provider usage). */
  lastUsed: number
  lastProviderID?: string
  lastModelID?: string
}

/** The assistant reply a host produced for a summary request. */
export type SummaryReply = {
  /** User turn that requested the summary (the cut boundary). */
  boundaryUserID?: string
  /** Assistant message holding the summary. */
  summaryAssistantID?: string
  /** The summary text. */
  text?: string
}

export interface Host {
  log(
    level: LogLevel,
    message: string,
    extra?: Record<string, unknown>,
  ): void
  /** Append a user turn and resolve with the assistant reply that carried the summary. */
  summarize(sessionID: string, prompt: string): Promise<SummaryReply>
  /** Append a plain user turn (the resume prompt). */
  sendText(sessionID: string, text: string): Promise<void>
  /** Stop whatever turn is running. */
  abort(sessionID: string): Promise<void>
  /** Provider/model context window, or 0 when the provider reports none. */
  contextLimit(providerID: string, modelID: string): Promise<number>
}

/** Prefer the provider's reported total; otherwise sum the parts. */
export function tokenTotal(t: any): number {
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
 * OpenCode instantiates a plugin more than once in the same process (observed:
 * twice). If each copy kept its own state, both would trip on the same event and
 * write two summaries. Share one registry across copies, keyed by session id.
 */
const shared = {
  states: new Map<string, SessionState>(),
  limitCache: new Map<string, number>(),
}

/** Test-only: clear the cross-instance registry. */
export function __resetSharedState(): void {
  shared.states.clear()
  shared.limitCache.clear()
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

export type ResolvedOptions = {
  threshold: number
  summaryMaxTokens: number
  contextLimit: number
  summaryPrompt?: string
  models?: string[]
  autoResume: boolean
  resumePrompt?: string
  abortOnTrip: boolean
  abortSettleMs: number
  disablePrune: boolean
  debug: boolean
}

export type CutKeys = {
  /** The user turn that requested the summary (the cut boundary). */
  boundaryUserID?: string
  /** The assistant message holding the summary. */
  summaryAssistantID?: string
}

export type CutInfo = {
  /** The exact summary instruction sent, used to find the boundary by text. */
  prompt?: string
  /** The summary text, used to find and rewrite the reply. */
  text?: string
}

export type Core = {
  readonly options: ResolvedOptions
  /** The ids the V1 cut needs, if a summary exists. */
  cutKeys(sessionID: string): CutKeys | undefined
  /** The text the V2 cut needs, if a summary exists. */
  cutInfo(sessionID: string): CutInfo | undefined
  captureModel(sessionID: string, providerID?: string, modelID?: string): void
  onAssistantMessage(input: {
    sessionID: string
    id?: string
    providerID?: string
    modelID?: string
    used: number
    /** OpenCode's own compaction summary or an errored message: never trips. */
    ignore?: boolean
  }): void
  onStep(input: { sessionID: string; messageID?: string; used: number }): void
  onIdle(sessionID: string): void
  onDeleted(sessionID: string): void
  /** Whether a summary request is in flight, so the adapter can cap output tokens. */
  isPending(sessionID: string): boolean
}

export function createCore(
  host: Host,
  options: CacheCompactOptions = {},
): Core {
  const cfg = { ...DEFAULTS, ...options }
  const states = shared.states
  const limitCache = shared.limitCache

  const log: Host["log"] = (level, message, extra = {}) => {
    if (level === "debug" && !cfg.debug) return
    host.log(level, message, extra)
  }

  const ensureState = (sessionID: string): SessionState => {
    let state = states.get(sessionID)
    if (!state) {
      state = { pending: false, armed: true, cooldownUntil: 0, lastUsed: 0 }
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
    let reported = 0
    try {
      reported = await host.contextLimit(providerID, modelID)
    } catch {
      /* fall back to the configured limit */
    }
    if (typeof reported === "number" && reported > 0) {
      limitCache.set(key, reported)
      return reported
    }
    // The provider reported no window (yet). Use the fallback for this call but
    // do not cache it: a transient miss must not poison every later trip.
    return cfg.contextLimit
  }

  const modelAllowed = (providerID?: string, modelID?: string): boolean => {
    if (!cfg.models?.length) return true
    if (!providerID || !modelID) return false
    return cfg.models.includes(`${providerID}/${modelID}`)
  }

  /** Append the summary turn. Returns true when a usable summary was written. */
  const summarize = async (sessionID: string): Promise<boolean> => {
    const prompt = cfg.summaryPrompt ?? DEFAULT_SUMMARY_PROMPT
    const reply = await host.summarize(sessionID, prompt)
    const hasText = typeof reply?.text === "string" && reply.text.trim().length > 0
    const hasIDs = Boolean(reply?.summaryAssistantID)
    if (!hasText && !hasIDs) {
      log("warn", "summary response was empty; not cutting", { sessionID })
      return false
    }
    const state = ensureState(sessionID)
    state.boundaryUserID = reply.boundaryUserID
    state.summaryAssistantID = reply.summaryAssistantID
    state.summaryPrompt = prompt
    state.summaryText = reply.text
    // Disarm until the cut is observed to land. Prevents re-summarizing over and
    // over when the in-flight turn keeps reporting pre-cut usage.
    state.armed = false
    log("info", "summary written; cutting context from now on", {
      sessionID,
      summaryChars: reply.text?.length ?? 0,
    })
    return true
  }

  /**
   * Stop whatever turn is running, take a summary, then resume. Aborting is what
   * lets this fire mid-run: OpenCode only emits idle at the end of a whole turn,
   * and a long agentic turn can otherwise run from 70% to 100%.
   */
  const trip = async (sessionID: string): Promise<void> => {
    const state = ensureState(sessionID)
    if (state.pending) return
    state.pending = true
    let ok = false
    try {
      if (cfg.abortOnTrip) {
        try {
          await host.abort(sessionID)
        } catch {
          /* nothing running — fine */
        }
        if (cfg.abortSettleMs > 0) await sleep(cfg.abortSettleMs)
      }
      ok = await summarize(sessionID)
    } catch (error) {
      log("error", "summary request failed", {
        sessionID,
        error: String(error),
      })
    } finally {
      state.lastUsed = 0
      state.cooldownUntil = Date.now() + (ok ? 30_000 : 60_000)
      state.pending = false
    }
    if (ok && cfg.autoResume) {
      try {
        await host.sendText(sessionID, cfg.resumePrompt ?? DEFAULT_RESUME_PROMPT)
      } catch (error) {
        log("error", "resume prompt failed", {
          sessionID,
          error: String(error),
        })
      }
    }
  }

  const maybeTrip = (sessionID: string): void => {
    const state = states.get(sessionID)
    if (!state || state.pending) return
    const { lastUsed, lastProviderID, lastModelID } = state
    if (lastUsed <= 0 || !lastProviderID || !lastModelID) return
    if (!modelAllowed(lastProviderID, lastModelID)) return
    void (async () => {
      const limit = await resolveLimit(lastProviderID, lastModelID)
      const current = states.get(sessionID)
      if (!current || current.pending) return
      if (lastUsed < limit * (cfg.threshold / 100)) {
        // Back under the threshold: either a fresh session or the cut landed.
        // Re-arm so a later crossing can summarize again. This is the only way
        // the latch reopens, so a summary that never takes effect cannot loop.
        current.armed = true
        return
      }
      if (!current.armed) return
      if (Date.now() < current.cooldownUntil) return
      log("info", "context threshold reached; summarizing", {
        sessionID,
        used: lastUsed,
        limit,
        threshold: cfg.threshold,
      })
      await trip(sessionID)
    })()
  }

  const onAssistantMessage: Core["onAssistantMessage"] = (input) => {
    if (input.ignore) return
    const state = ensureState(input.sessionID)
    if (state.pending || input.id === state.summaryAssistantID) return
    if (input.used <= 0) return
    state.lastUsed = input.used
    if (input.providerID) state.lastProviderID = input.providerID
    if (input.modelID) state.lastModelID = input.modelID
    maybeTrip(input.sessionID)
  }

  const onStep: Core["onStep"] = (input) => {
    if (input.used <= 0) return
    const state = ensureState(input.sessionID)
    if (state.pending || input.messageID === state.summaryAssistantID) return
    state.lastUsed = input.used
    maybeTrip(input.sessionID)
  }

  return {
    options: cfg,
    cutKeys(sessionID) {
      const state = states.get(sessionID)
      if (!state) return undefined
      return {
        boundaryUserID: state.boundaryUserID,
        summaryAssistantID: state.summaryAssistantID,
      }
    },
    cutInfo(sessionID) {
      const state = states.get(sessionID)
      if (!state) return undefined
      return { prompt: state.summaryPrompt, text: state.summaryText }
    },
    captureModel(sessionID, providerID, modelID) {
      const state = ensureState(sessionID)
      if (providerID) state.lastProviderID = providerID
      if (modelID) state.lastModelID = modelID
    },
    onAssistantMessage,
    onStep,
    onIdle: maybeTrip,
    onDeleted(sessionID) {
      states.delete(sessionID)
    },
    isPending(sessionID) {
      return states.get(sessionID)?.pending ?? false
    },
  }
}
