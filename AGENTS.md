# AGENTS.md

Guidance for agents working in this repo. Read [`README.md`](README.md) first for
what the plugin is and how it is installed.

## Hard rules

**Never run `git commit` or `git push`** unless explicitly asked in that message.
Write files, stage nothing, report what changed, and let the human commit.

**Conventional Commits**, title line only, imperative, lower case, no trailing
period: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `build:`,
`ci:`, `perf:`. Example: `fix: trip on completed turns instead of idle`.

**Semantic Versioning.** Bump `version` in `package.json` in the same commit:
`feat` → minor, `fix` → patch, breaking → major. `docs`/`test`/`chore` do not
need a bump unless they change published behaviour.

**No secrets, ever** — nothing here needs one.

## What this is

An OpenCode plugin that replaces built-in compaction with a cache-friendly flow:

> threshold crossed → abort the turn → append a summary turn (cache-hit) →
> cut outgoing requests to `[system][tools][summary][…]` → auto-resume.

The on-disk session is never rewritten; only the request sent to the model is.
See README → "How it works".

It runs on both OpenCode V1 and V2. The two hook wirings are separate adapters
over one shared core:

```
src/index.ts   # one default export: V2 {id, setup} + V1 server()
src/core.ts    # runtime-agnostic state machine (latch, trip, summarize, resume)
src/plugin.ts  # V1 adapter (client calls, events, {info,parts} messages)
src/v2.ts      # V2 adapter (session hooks, event stream, session.context usage)
src/cut.ts     # pure message slicing for both message shapes
```

It is consumed by `lennartschoch/raspi` as a git submodule
(`opencode-cache-compact/`, mounted into the paseo container). Bump that pointer
in the other repo; do not add deployment files here.

## Invariants — do not break these

| Thing | Why |
|---|---|
| `src/index.ts` exports **only** the default plugin | OpenCode registers every function export as its own plugin. Extra value exports duplicate the plugin; a non-plugin export crashes the hook dispatcher. |
| State lives in module scope (`shared` in `core.ts`) | OpenCode may instantiate the plugin more than once; copies must share one registry. `__resetSharedState()` exists for tests. |
| After a summary, disarm until usage drops below threshold | The latch in `core.ts` is the only thing stopping `abortOnTrip: false` from re-summarizing forever; the cooldown alone is not enough. |
| Never summarize twice for one boundary | A valid summary sets `armed = false`; only an observed below-threshold step re-arms it. |
| Trigger on completed assistant messages, and abort | V1 `session.idle` only fires at the end of a whole turn; a long agentic turn would overshoot. V2 reads usage on `session.execution.*` events. |
| The cut runs on the outgoing request only | V1 `experimental.chat.messages.transform`; V2 `session.hook("context")`. The session must not be mutated; the boundary user turn is rewritten to carry the summary. |
| Empty summary ⇒ no boundary, no resume | Never cut to nothing. |
| `disablePrune` defaults true | Pruning invalidates the cached prefix this plugin exists to keep. No-op on V2 (`compaction.prune` is gone). |

## Layout

```
src/index.ts     # shared entry: spread V2 createV2() + V1 server() — nothing else
src/core.ts      # options, shared state, trip/summarize/resume, the latch
src/plugin.ts    # V1 adapter
src/v2.ts        # V2 adapter
src/cut.ts       # pure message-list slicing (tested in isolation)
test/            # cut.test.ts, index.test.ts (V1), v2.test.ts (V2), e2e*.test.ts
```

## Commands

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # unit tests (node --test)
npm run test:e2e      # real V1 `opencode serve` + mock model server (opt-in)
npm run test:e2e:v2   # real `opencode2` + mock model server (opt-in)
```

Node 24+ — the repo runs TypeScript directly and uses `node --test`.

For the V2 e2e, install `opencode2` and (if the provider needs installing) `bun`.
Run `opencode2 run --standalone`, which deadlocks in its private `serve --stdio`
child on the current build, so the test drives a standalone `serve` over HTTP
instead. As of v2.0.16 that build also rejects file paths in config `plugins` and
auto-discovers only from `$XDG_CONFIG_HOME/opencode/plugins/`, which is where the
test drops its re-export.

## Verifying

- **Unit** (`npm test`) covers the pure cut (both message shapes) and the state
  machine + both adapters with mock hosts. Any change to the
  trip/summary/resume flow needs a matching test.
- **End-to-end** (`npm run test:e2e`, `npm run test:e2e:v2`) is what catches real
  OpenCode behaviour: it starts a real server with the plugin loaded from source
  and a mock model that records HTTP bodies, then asserts exactly one summary,
  one resume, and that the resume request was cut. Run it after touching the
  entry point, the hooks, or the trigger; it caught the double-instantiation, the
  idle-only-trigger, and the plugin-path bugs.
- The e2e confines opencode state with `XDG_*` temp dirs; keep it that way.
- Installing OpenCode 2 replaces the V1 `opencode` binary (they no longer install
  side by side), so run the V1 e2e before upgrading or keep a V1 binary around.

## Conventions

- `core.ts` owns behaviour; adapters only translate API shapes. `cut.ts` stays
  pure (no SDK, no I/O) so it can be unit-tested directly.
- Prefer explaining *why* in comments — especially around the invariants above.
- Keep the README's caveats table honest: if a workaround is removed, explain the
  cost in the same change.
