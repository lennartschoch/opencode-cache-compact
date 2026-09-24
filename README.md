<div align="center">

# 🗜️ opencode-cache-compact

**Cache-friendly context compaction for [OpenCode](https://opencode.ai) V1 and V2.**

For locally hosted models, where prefilling a large context is the expensive part.

[Install](#-install) · [How it works](#-how-it-works) · [Options](#-options) · [Caveats](#-caveats) · [Develop](#-develop)

[![npm](https://img.shields.io/npm/v/opencode-cache-compact?color=8B5CF6&style=flat-square)](https://www.npmjs.com/package/opencode-cache-compact)
![tests](https://img.shields.io/badge/tests-19-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)

</div>

---

On a locally hosted model, prefilling a large context window is slow: the longer the conversation, the longer the wait before the first token. Compaction is meant to fix that, but most implementations **rebuild the prompt** in order to summarize it, so the model has to read the whole conversation again. On a server that keeps no caching checkpoints that is the worst case — there is nothing to reuse, so the entire prompt is re-processed from scratch, and the pause can outlast the client's patience.

This plugin keeps the work cache-friendly. It never rebuilds the prompt:

1. **Summarize by appending.** When the context approaches the model's limit, it appends an ordinary user turn asking for a handoff summary. Because that turn extends the existing conversation, the server serves the prefix from its cache and only generates the summary.
2. **Cut what the model sees.** From then on, outgoing requests are rewritten to the stable prefix plus the summary and the current turn. The cached prefix is reused, so only the small new tail is prefilled; later turns extend that and are cached again.
3. **Resume.** A short continue turn applies the cut and picks the work back up.

The on-disk session is never modified — only what is sent to the model changes — so the TUI keeps its full history. The plugin never calls OpenCode's own compaction.

## ✨ Features

- **🚀 Append, don't rebuild** — the summary is a cache hit, not a re-read of the conversation.
- **✂️ Non-destructive cut** — rewrites the outgoing request only; the session stays intact.
- **⏱ Fires mid-turn** — acts on each completed step and aborts the running turn, so a long agentic loop can't drift past the limit before it compacts.
- **▶️ Auto-resume** — continues on the compacted context without you typing anything.
- **🎯 Scoped by model** — act only on the models you list, leaving cloud sessions alone.

## 📦 Install

Works on OpenCode V1 and V2. Requires a model whose provider reports its context window. V1 needs the `experimental.chat.messages.transform` hook; V2 needs the `session.hook("context")` API (OpenCode 2 beta).

### V1

```jsonc
{
  "plugin": [
    ["opencode-cache-compact", { "threshold": 68 }]
  ]
}
```

### V2

```jsonc
{
  "plugins": [
    { "package": "opencode-cache-compact", "options": { "threshold": 68 } }
  ]
}
```

### From a local checkout

```jsonc
// V1
{ "plugin": [["file:///absolute/path/to/opencode-cache-compact/src/index.ts", { "threshold": 68 }]] }
```

V2 (beta) auto-discovers plugins from the global plugins directory and rejects
file paths in config in the current build, so drop a re-export there instead:

```ts
// ~/.config/opencode/plugins/cache-compact.ts
export { default } from "/absolute/path/to/opencode-cache-compact/src/index.ts"
```

Auto-discovered plugins get no options, so this form uses the defaults. Use the
npm form above when you need to pass options.

Set `compaction.auto` to `false` if you want this plugin to be the only compaction.

## ⚙️ Options

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `threshold` | number | `68` | Percent of the context window used that trips the summary. |
| `models` | string[] | `[]` (all) | Only act on these `providerID/modelID`s. Use it to scope to your local endpoint. |
| `summaryPrompt` | string | [see `src/plugin.ts`](src/plugin.ts) | Replace the summary instruction. |
| `summaryMaxTokens` | number | `1200` | Cap on the summary's output tokens. |
| `contextLimit` | number | `131072` | Fallback window if the provider reports none. |
| `autoResume` | boolean | `true` | Send a continue turn after the summary so the cut applies at once. Set `false` to wait for the next human message. |
| `resumePrompt` | string | `Continue from where you left off.` | The turn sent when `autoResume` fires. |
| `abortOnTrip` | boolean | `true` | Abort the running turn on trip so a long turn can't overshoot. |
| `abortSettleMs` | number | `300` | Delay after aborting before sending the summary. |
| `disablePrune` | boolean | `true` | Force `compaction.prune = false`. |
| `debug` | boolean | `false` | Verbose logging to OpenCode's log (`service: cache-compact`). |

## 🔧 How it works

The context size comes straight from OpenCode — each step's reported usage (`tokens.total`), compared against the model's `limit.context`. No client-side token counting.

When usage crosses `threshold`, the plugin:

1. **aborts the running turn** (OpenCode reports the end of a *turn* late, which is too late for a long agentic loop);
2. **appends the summary turn** as an ordinary user message, so the provider serves the prefix from cache;
3. remembers the boundary — the summary-request message and the reply that carries the summary;
4. **sends a resume turn**, after which every request is cut to `[system][tools][summary][…after]`.

The boundary message is reused as the carrier of the summary text, so the model always receives a valid, user-first conversation.

## 🧠 Caveats

- The first request after a cut still prefills the system prompt, tool schemas and summary, since that becomes the new shared prefix. Keep summaries short and tool sets lean.
- If the model returns no summary text, the plugin does not cut and retries after a cooldown rather than cutting to nothing.
- After a summary, the plugin does not summarize again until it observes usage drop back under the threshold — i.e. until the cut has landed. This is what stops the `abortOnTrip: false` repeat-summary loop.
- The cut boundary is kept in memory; restarting OpenCode simply means it won't cut until the next trip.
- **V1:** `experimental.chat.messages.transform` is an experimental OpenCode hook. The plugin forces `compaction.prune = false`.
- **V2 (beta):** uses `session.hook("context")` and the public event stream. `compaction.prune` no longer exists in V2, so `disablePrune` is a no-op there; V2's checkpoint compaction should be turned off (`compaction.auto: false`) or it can fire instead of this plugin. Usage is read by polling `session.context()` on session execution events rather than being pushed, so `abortSettleMs` and the trigger cadence differ slightly.

## 💻 Develop

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # unit tests (node --test; Node 24+ runs TypeScript directly)
npm run test:e2e    # end-to-end: real `opencode` V1 + a mock model server (opt-in)
npm run test:e2e:v2 # end-to-end: real `opencode2` + a mock model server (opt-in)
```

### Layout

```
src/
├── index.ts     # entry — one default export: V2 {id, setup} plus V1 server()
├── core.ts      # runtime-agnostic state machine (latch, trip, summarize, resume)
├── plugin.ts    # V1 adapter: OpenCode V1 hooks
├── v2.ts        # V2 adapter: OpenCode 2 session hooks + event stream
└── cut.ts       # pure: rewrite a message list down to the summary (V1 and V2 shapes)
test/
├── cut.test.ts     # the pure slicing logic, both message shapes
├── index.test.ts   # the plugin hooks with a mock client (V1)
├── v2.test.ts      # the V2 adapter with a mock context
└── e2e.test.ts     # real opencode + mock model (opt-in)
```

`src/index.ts` exports only the default plugin. OpenCode registers every function export of the loaded file as its own plugin, so additional exports make it instantiate the plugin more than once. The V1 and V2 hook wirings are intentionally separate — the shared behavior lives in `core.ts`.

## 🧪 Testing

`npm test` covers the pure cut logic and the plugin's full state machine with a mock client.

`npm run test:e2e` starts a real V1 `opencode serve` with the plugin loaded from source, plus a mock OpenAI-compatible model server that records the exact HTTP request bodies. It asserts that the plugin summarizes once, resumes once, and that the resume request was cut to `[summary][resume]` — including across a tool-call loop that never idles.

`npm run test:e2e:v2` does the same against `opencode2`: it starts a standalone `serve`, authenticates with the password it prints, creates a session over the V2 client, and asserts the same one-summary/one-resume/cut shape.

## 📄 License

[MIT](LICENSE).
