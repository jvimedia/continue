/**
 * Helpers for turning the `data.content` payload of `assistant_delta` /
 * `assistant_done` events into plain text.
 *
 * Per docs/guides/chat-streaming-api.mdx, `data.content` is a `ChatMessage`
 * or an array of them, matching Continue's internal streaming format. A
 * ChatMessage's own `content` field can in turn be a plain string or an
 * array of content parts. This module handles the common shapes:
 *   - content: "some text"
 *   - content: [{ role: "assistant", content: "some text" }, ...]
 *   - content: [{ type: "text", text: "some text" }, ...]  (part-style)
 *
 * Anything else is treated as unrepresentable-as-text and yields "".
 */

function partToText(part: unknown): string {
  if (typeof part === "string") {
    return part;
  }
  if (part && typeof part === "object") {
    const obj = part as Record<string, unknown>;
    if (typeof obj.content === "string") {
      return obj.content;
    }
    if (typeof obj.text === "string") {
      return obj.text;
    }
  }
  return "";
}

function chatMessageToText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map(partToText).join("");
  }
  return "";
}

/**
 * Extracts plain text from a `ChatMessage | ChatMessage[]` payload as found
 * in `assistant_delta`/`assistant_done` events' `data.content` field.
 */
export function extractText(content: unknown): string {
  const messages = Array.isArray(content) ? content : [content];
  return messages.map(chatMessageToText).join("");
}

/**
 * Resolves the final text for a turn from its `assistant_done` event.
 *
 * The Chat API server normalizes `assistant_done.data.content` to a single
 * `{ role: "assistant", content: string }` message holding the *full* reply
 * (derived from the completion, not accumulated from deltas) - see
 * docs/guides/chat-streaming-api.mdx. So it replaces the accumulated buffer
 * outright rather than being appended to it. If it's missing (e.g. the turn
 * ended in an error before any completion was produced), fall back to
 * whatever text was accumulated from `assistant_delta` events.
 */
export function mergeDoneText(
  accumulated: string,
  doneContent: unknown,
): string {
  const doneText = extractText(doneContent);
  return doneText.length > 0 ? doneText : accumulated;
}
