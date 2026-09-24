/**
 * Plugin entry point — one default export that both OpenCode runtimes accept.
 *
 * OpenCode treats *every function export* of the loaded file as a separate
 * plugin, so the object stays the module's only export; implementation lives in
 * `plugin.ts` (V1), `v2.ts` (V2) and the shared `core.ts`.
 *
 * V2 reads `id`/`setup` off the default export (via the shape of
 * `Plugin.define`). V1 (>= 1.18.29) reads `server()`. Each runtime ignores the
 * other's member; only the entrypoint is shared, the hook wiring is not.
 */

import { createServer } from "./plugin.ts"
import { createV2 } from "./v2.ts"

const plugin = {
  ...createV2(),
  async server(input: any, options: any) {
    return createServer(input, options ?? {})
  },
}

export default plugin
