/**
 * Plugin entry point.
 *
 * OpenCode treats *every function export* of the file it loads as a separate
 * plugin. This file therefore exports exactly one thing — the default plugin —
 * and all implementation lives in `plugin.ts`. (Shipping extra exports made
 * opencode instantiate the plugin two or three times, which wrote duplicate
 * summaries and, for non-plugin exports, crashed the hook dispatcher.)
 */
export { default } from "./plugin.ts"
