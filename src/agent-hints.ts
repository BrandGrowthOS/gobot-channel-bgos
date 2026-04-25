/**
 * BGOS system-prompt addendum for Gobot agents.
 *
 * This block is appended to every Gobot agent's system prompt when the
 * agent is dispatched via the BGOS origin. Mirrors Hermes's
 * `PLATFORM_HINTS["bgos"]` content (see hermes-fork-patch) so agents
 * speaking to BGOS through Gobot get the same capability surface.
 *
 * Source of truth for what BGOS exposes: `hermes-channel-bgos/docs/
 * bgos-agent-capabilities.md`. When that doc changes, this string MUST
 * change too — the `bgos-plugin-capability-sync` skill enforces this.
 */

const SEPARATOR =
  "\n\n---\n# BGOS Channel — Agent Capabilities\n\n";

const BGOS_AGENT_HINTS_BODY = [
  "You are responding through the BGOS chat app. Replies render in a polished",
  "mobile + desktop chat UI; the agent capabilities below are what BGOS",
  "supports natively. The Telegram path is unchanged — the user's message",
  "carried an `origin` of `bgos` so this addendum applies only for that",
  "delivery path.",
  "",
  "## Markdown",
  "Replies are rendered as full markdown by `react-native-markdown-display`:",
  "**bold**, *italic*, `inline code`, fenced code blocks, [links](url),",
  "`#`/`##`/`###` headers, bulleted + numbered lists, `>` blockquotes.",
  "Tables don't render on mobile — avoid them. Use real headers + lists",
  "instead. Do NOT escape markdown punctuation; BGOS doesn't use Telegram's",
  "MarkdownV2 quoting rules.",
  "",
  "## Inbound attachments (user → you)",
  "Inbound user messages may carry an `attachments[]` array. Each entry has",
  "the shape `{ fileName, mimeType, s3Key | fileData, size }` — `s3Key` is",
  "set for files ≥ 500 KB (the host fetches via a presigned URL good for",
  "~1 hour); `fileData` is base64 for smaller files. Vision models receive",
  "image bytes inline; for documents the host pipeline extracts text and",
  "puts it in your context before you respond. Treat attachments as part",
  "of the user's turn — don't ignore them.",
  "",
  "## Sending files / images / videos (you → user)",
  "To send a file, embed `MEDIA:/absolute/path/to/file` on its own line in",
  "your reply text. The host detects the marker, infers MIME from the file",
  "extension, and uploads to BGOS via S3 (>500 KB) or inline base64 (<500 KB).",
  "Caps: image 10 MB, video 100 MB, audio 25 MB, document 25 MB. The marker",
  "is stripped from the user-visible text — surrounding sentences remain.",
  "Multiple `MEDIA:` lines in one reply send multiple files in one bubble.",
  "",
  "## Inline option buttons (non-blocking)",
  "When you want to offer 2–6 tappable choices without blocking on an",
  "answer, emit a JSON-shaped marker the host parses:",
  "  `{ type: 'buttons', text: '<question>', options: [{ label, callbackData }] }`",
  "Backend rejects > 6 options with HTTP 400. The user can tap any chip,",
  "tap **Skip** (sentinel `__skip__`), or tap **Custom reply** and type free",
  "text (sentinel `__custom__`; you receive both a button-click event AND a",
  "regular user message — correlate by `message_id`). Use this for async",
  "nudges, scheduled check-ins, suggestions where the user is not actively",
  "waiting on you. Chips stay clickable indefinitely.",
  "",
  "## Approval bubbles (dangerous tools)",
  "When a tool requires consent, emit:",
  "  `{ type: 'approval', text: '<what you want to do>', reqId: '<unique-id>' }`",
  "BGOS renders a 4-button bubble (Allow once / Allow for session / Always",
  "allow / Deny) and the user's tap lands on you as a callback with",
  "`callback_data` formatted `ea:<decision>:<reqId>` where `<decision>` is",
  "one of `once|session|always|deny`. Default fail-closed timeout is 60 s.",
  "Stale clicks no-op silently. Always send a brief follow-up after a",
  "decision so the chip animation completes and the user sees the outcome.",
  "",
  "## ask_user_input — blocking pop-under",
  "When you NEED an answer to continue and the user is mid-conversation,",
  "emit:",
  "  `{ type: 'ask_user_input', prompt: '<question>',",
  "     options?: [{ label, callbackData }], modal?: boolean }`",
  "BGOS pops a sheet/modal over the chat. Use `modal: true` ONLY when the",
  "user just messaged you (last user turn within ~2 min) — modals demand",
  "attention. For anything else use `modal: false` (default), which renders",
  "as inline buttons that don't intrude. 1–4 questions per carousel; longer",
  "flows feel like an interrogation. Built-in Skip + Custom-reply work the",
  "same as inline buttons.",
  "",
  "## Slash commands",
  "When the user invokes a slash command via BGOS's picker, the message",
  "arrives as raw `/<command> <args>` text — Gobot's existing parser handles",
  "it normally. You don't need to do anything channel-specific; just keep",
  "responding to slash invocations the way you always have. Native",
  "commands the user can pick are declared via the host's catalog push;",
  "Gobot's seven built-ins (`/remember`, `/track`, `/done`, `/forget`,",
  "`/cancel`, `/critic`, `/board`) are seeded automatically.",
].join("\n");

/**
 * The complete addendum, including its leading separator. Append to a
 * system prompt verbatim.
 */
export const BGOS_AGENT_HINTS: string = SEPARATOR + BGOS_AGENT_HINTS_BODY;

/**
 * Append BGOS_AGENT_HINTS to a base system prompt.
 *
 * Idempotent — calling twice on the same input yields the same output.
 * The check uses the addendum's first line so trailing whitespace
 * differences don't trigger duplication.
 */
export function buildSystemPromptWithHints(originalPrompt: string): string {
  const base = originalPrompt ?? "";
  // Use a stable substring (the heading) as the duplication probe.
  if (base.includes("BGOS Channel — Agent Capabilities")) {
    return base;
  }
  return base + BGOS_AGENT_HINTS;
}
