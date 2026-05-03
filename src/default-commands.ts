import type { CommandManifestEntry } from "./types.js";

/**
 * Gobot's seven built-in user-invocable slash commands.
 *
 * These pre-populate BGOS's slash picker for a freshly bound assistant so
 * the user gets Gobot's full vocabulary without hand-typing each row.
 *
 * Names match `^[a-z0-9_]{1,32}$`. Descriptions ≤100 characters so they
 * fit BGOS's slash-picker chip.
 *
 * Source: extracted from Gobot's `src/bot.ts` text-prefix command parser
 * (see plan §2.3). When upstream Gobot adds or removes commands, update
 * this list — but only fresh manifests (`command_count === 0`) are seeded
 * automatically, so a stale default never stomps a user's edits.
 *
 * Order is the picker order — ordering by frequency-of-use rather than
 * alphabetical so the typical "remember/track" pair sits at the top.
 */
const _DEFAULT_COMMANDS: ReadonlyArray<{
  name: string;
  description: string;
}> = [
  { name: "remember", description: "Save a fact to memory" },
  { name: "track", description: "Track a new goal with optional deadline" },
  { name: "done", description: "Mark a goal as completed" },
  { name: "forget", description: "Forget a stored fact" },
  { name: "cancel", description: "Cancel an in-flight goal" },
  {
    name: "critic",
    description: "Ask the critic agent for a devil's advocate take",
  },
  { name: "board", description: "Run a multi-agent board meeting on a topic" },
] as const;

/**
 * Bridge-local slash commands handled directly by the BGOS adapter —
 * intercepted before they reach Gobot's command parser. Includes the
 * peer (a2a) commands from `bgos-agent-capabilities.md` §11.
 *
 * Listed AFTER Gobot's natives in the seeded manifest so the picker
 * surfaces familiar commands first.
 */
const _BRIDGE_LOCAL_COMMANDS: ReadonlyArray<{
  name: string;
  description: string;
}> = [
  { name: "new", description: "Start a fresh conversation in this chat (bridge)" },
  { name: "retry", description: "Resend the last message (bridge)" },
  { name: "status", description: "Show adapter health (bridge)" },
  { name: "peers", description: "List discoverable peer assistants (bridge)" },
  {
    name: "peer-status",
    description: "Check whether a peer is online (bridge)",
  },
  {
    name: "peer-send",
    description: "Send a one-shot message to a peer (bridge)",
  },
  {
    name: "peer-complete",
    description: "Close the most recent open peer conversation (bridge)",
  },
] as const;

/** Names of bridge-local commands the BGOS adapter intercepts. Lookup
 *  is case-insensitive on the leading `/` strip; entries are stored
 *  lowercase. */
export const BRIDGE_LOCAL_COMMAND_NAMES: ReadonlySet<string> = new Set(
  _BRIDGE_LOCAL_COMMANDS.map((c) => c.name),
);

/**
 * Manifest entries ready to PUT to `/api/v1/integrations/assistants/:id/commands`.
 *
 * `order_index` is set so the order seen above is preserved on the picker.
 */
export const DEFAULT_COMMANDS: ReadonlyArray<CommandManifestEntry> = [
  ..._DEFAULT_COMMANDS.map((c, i) => ({
    command: c.name,
    description: c.description,
    order_index: i,
  })),
  ..._BRIDGE_LOCAL_COMMANDS.map((c, i) => ({
    command: c.name,
    description: c.description,
    order_index: _DEFAULT_COMMANDS.length + i,
  })),
];

/**
 * Decide whether to seed the default manifest for an assistant.
 *
 * Rule: only seed when the assistant has zero commands. We never overwrite
 * a user's edits — once they've added or removed even a single command,
 * the manifest is theirs to manage.
 *
 * If the backend's whoami response omits `command_count` (older deploy),
 * pass `undefined` here — we return `false` to play it safe.
 */
export function shouldSeedDefaults(commandCount: number | undefined): boolean {
  return commandCount === 0;
}
