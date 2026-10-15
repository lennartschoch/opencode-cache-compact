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

/**
 * Rebuild the V1 cut keys from the message list alone.
 *
 * The cut boundary normally lives only in memory, so a restart of OpenCode loses
 * it and the next request carries the whole uncut history. The session on disk
 * still holds the summary exchange, though: a user turn whose text is exactly the
 * summary instruction, answered by an assistant message with the summary text.
 * Find the most recent such pair so the cut can be re-applied.
 *
 * Returns undefined when no usable summary exists (never summarized, or the reply
 * was empty or errored).
 */
export function findSummaryKeys(
  messages: AnyMessage[],
  summaryPrompt: string,
): { boundaryUserID: string; summaryAssistantID: string; text: string } | undefined {
  if (!Array.isArray(messages) || !summaryPrompt) return undefined
  const wanted = summaryPrompt.trim()
  const byID = new Map<string, AnyMessage>()
  for (const m of messages) if (m?.info?.id) byID.set(m.info.id, m)

  for (let i = messages.length - 1; i >= 0; i--) {
    const reply = messages[i]
    if (reply?.info?.role !== "assistant" || reply.info.error) continue
    const text = extractText(reply.parts)
    if (!text) continue
    const parentID = reply.info.parentID
    if (typeof parentID !== "string") continue
    const boundary = byID.get(parentID)
    if (boundary?.info?.role !== "user") continue
    const boundaryText = extractText(boundary.parts)
    if (boundaryText !== wanted && !boundaryText.startsWith(SUMMARY_HEADING)) continue
    return { boundaryUserID: boundary.info.id, summaryAssistantID: reply.info.id, text }
  }
  return undefined
}

/**
 * V2 message shape: OpenCode 2 hands the transform hook AI-SDK-style messages
 * (`{ role, content: ContentPart[] }`) without the stable message ids V1 had.
 * Locate the boundary by the exact summary instruction we sent, and the reply by
 * the summary text we captured, then rewrite the boundary to carry the summary
 * and drop everything up to and including the reply.
 *
 * Mutates `messages` in place (V2 requires in-place mutation; reassigning the
 * array is a no-op). Returns the number of messages removed, or 0 if nothing cut.
 */
export function cutV2Messages(
  messages: AnyMessageV2[],
  summaryPrompt: string,
  summaryText: string,
): number {
  if (!Array.isArray(messages) || !summaryPrompt || !summaryText) return 0

  const boundaryIndex = messages.findIndex(
    (m) => m?.role === "user" && contentText(m) === summaryPrompt,
  )
  if (boundaryIndex < 0) return 0

  const summaryIndex = messages.findIndex(
    (m, i) => i > boundaryIndex && m?.role === "assistant" && contentText(m).includes(summaryText),
  )
  if (summaryIndex < 0) return 0

  const boundary = messages[boundaryIndex]
  boundary.content = [{ type: "text", text: `${SUMMARY_HEADING}\n\n${summaryText}` }]

  const dropped = summaryIndex
  messages.splice(boundaryIndex + 1, summaryIndex - boundaryIndex)
  messages.splice(0, boundaryIndex)
  return dropped
}

export type AnyMessageV2 = {
  role?: string
  content?: Array<{ type?: string; text?: string }>
  [key: string]: unknown
}

/** Concatenate the visible text of a V2 `content` array. */
export function contentText(message: AnyMessageV2 | undefined): string {
  if (!Array.isArray(message?.content)) return ""
  return message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .trim()
}
