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
 * automatically by default, so a stale default never stomps a user's
 * edits. Set `GOBOT_BGOS_RESEED_COMMANDS=always` to force a reseed.
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
 * Seed-mode controls how aggressively the adapter reseeds the default
 * manifest at startup / on `assistant_bound`:
 *
 *   - `auto`   — seed only when `command_count === 0` (the safe default).
 *                When the backend doesn't tell us the count (older deploy,
 *                `command_count === undefined`), don't seed.
 *   - `safe`   — like `auto` but ALSO seeds when `command_count` is
 *                undefined. This unblocks older backends where the
 *                `whoami` payload omits the field. Reseeds are idempotent
 *                so this can't lose user edits the backend already knows
 *                about — at worst it overwrites a manifest that BGOS
 *                couldn't surface anyway.
 *   - `always` — always seed, regardless of `command_count`. Use this
 *                when you've seen the slash picker miss commands and need
 *                to force the manifest to match `DEFAULT_COMMANDS`.
 *                Idempotent.
 *   - `never`  — never auto-seed. Use only when the manifest is managed
 *                exclusively from the BGOS Integrations UI.
 *
 * Configure via the `GOBOT_BGOS_RESEED_COMMANDS` env var or by passing
 * `commandSeedMode` in `BgosConfig`.
 */
export type CommandSeedMode = "auto" | "safe" | "always" | "never";

const VALID_MODES: ReadonlyArray<CommandSeedMode> = [
  "auto",
  "safe",
  "always",
  "never",
];

/**
 * Read `GOBOT_BGOS_RESEED_COMMANDS` and return a normalized
 * `CommandSeedMode`. Empty / unset / invalid → `"auto"`.
 *
 * Resolves on every call so a host can change it without a restart.
 */
export function resolveCommandSeedMode(): CommandSeedMode {
  const raw = (process.env.GOBOT_BGOS_RESEED_COMMANDS ?? "")
    .trim()
    .toLowerCase();
  if (!raw) return "auto";
  if ((VALID_MODES as readonly string[]).includes(raw)) {
    return raw as CommandSeedMode;
  }
  // eslint-disable-next-line no-console
  console.warn(
    `[gobot-channel-bgos] GOBOT_BGOS_RESEED_COMMANDS=${JSON.stringify(raw)} ` +
      `is not a recognized value (expected one of ${VALID_MODES.join(", ")}). ` +
      `Falling back to "auto".`,
  );
  return "auto";
}

/**
 * Decide whether to seed the default manifest for an assistant given the
 * `command_count` reported by `whoami` and the current seed mode.
 *
 * Truth table:
 *   mode=auto:   count===0 ? seed : skip   (count===undefined → skip)
 *   mode=safe:   count===0 ? seed : skip   (count===undefined → seed)
 *   mode=always: seed unconditionally
 *   mode=never:  skip unconditionally
 *
 * Backwards-compat: callers who pass only `commandCount` (no mode) get
 * `auto` semantics — preserving the original `shouldSeedDefaults`
 * contract for tests + downstream integrations.
 */
export function shouldSeedDefaults(
  commandCount: number | undefined,
  mode: CommandSeedMode = "auto",
): boolean {
  if (mode === "never") return false;
  if (mode === "always") return true;
  if (commandCount === 0) return true;
  if (mode === "safe" && commandCount === undefined) return true;
  return false;
}
