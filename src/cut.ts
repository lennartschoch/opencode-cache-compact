/**
 * Pure helpers for rewriting the message list sent to the model.
 *
 * `cutMessages` implements the core trick: after the assistant has written a
 * summary as a normal (cache-hit, append-only) turn, we drop everything from
 * the outgoing request except that summary and everything after it. The
 * on-disk session is untouched — only what the provider sees changes — so no
 * partial KV-cache rewind is ever needed.
 */

export type AnyPart = {
  type?: string
  text?: string
  ignored?: boolean
  id?: string
  sessionID?: string
  messageID?: string
  [key: string]: unknown
}

export type AnyMessage = {
  info: {
    id: string
    role: string
    sessionID?: string
    [key: string]: unknown
  }
  parts: AnyPart[]
}

export const SUMMARY_HEADING = "## Prior work summary"

/** Concatenate the visible text of a message's parts. */
export function extractText(parts: AnyPart[] | undefined): string {
  if (!Array.isArray(parts)) return ""
  return parts
    .filter(
      (part) =>
        part?.type === "text" &&
        typeof part.text === "string" &&
        part.ignored !== true,
    )
    .map((part) => part.text as string)
    .join("\n")
    .trim()
}

/**
 * Rewrite `messages` in place so the model only sees:
 *
 *   [ boundary user message, now carrying the summary ]
 *   [ every message that came after the summarizer's reply ]
 *
 * Returns the number of messages removed, or 0 if nothing was cut. The
 * boundary user message is kept (with its real id/role) so the provider gets a
 * valid, user-first conversation and OpenCode never sees a synthetic message.
 */
export function cutMessages(
  messages: AnyMessage[],
  boundaryID: string,
  summaryID: string,
): number {
  const boundaryIndex = messages.findIndex((m) => m?.info?.id === boundaryID)
  const summaryIndex = messages.findIndex((m) => m?.info?.id === summaryID)
  if (boundaryIndex < 0 || summaryIndex < 0 || summaryIndex < boundaryIndex) {
    return 0
  }

  const summaryText = extractText(messages[summaryIndex]?.parts)
  if (!summaryText) return 0

  const boundary = messages[boundaryIndex]
  const template = boundary.parts.find(
    (part) => part?.type === "text" && typeof part.text === "string",
  )
  const text = `${SUMMARY_HEADING}\n\n${summaryText}`
  const rewritten: AnyPart = template
    ? { ...template, text }
    : {
        type: "text",
        text,
        sessionID: boundary.info.sessionID,
        messageID: boundary.info.id,
      }
  boundary.parts = [rewritten]

  const dropped = summaryIndex
  // Drop from just after the boundary through the summarizer's own reply.
  messages.splice(boundaryIndex + 1, summaryIndex - boundaryIndex)
  // Drop everything before the boundary.
  messages.splice(0, boundaryIndex)

  return dropped
}
