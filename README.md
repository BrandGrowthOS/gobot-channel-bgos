# gobot-channel-bgos

BGOS channel adapter for [Gobot](https://github.com/autonomee/gobot): Socket.IO + REST client, full outbound modality coverage (text, inline buttons, approvals, ask-user-input pop-under, files/images/videos, typing), and a pair-CLI for first-time setup.

The fork ([`BrandGrowthOS/gobot-bgos-fork`](https://github.com/BrandGrowthOS/gobot-bgos-fork), private) wires this package into Gobot's existing message pipeline. Telegram and BGOS run side-by-side; replies always return to whichever channel the user wrote in.

## One-paste setup (recommended)

On the host where you want Gobot to run, paste the command the BGOS app shows on the Gobot card:

```bash
bunx gobot-channel-bgos setup BGOS-XXXX-XX
```

That one command runs the whole integration: it detects the host, scans for a competing Telegram poller (the only y/n it may ask), clones the private `BrandGrowthOS/gobot-bgos-fork` checkout from its tracked `bgos-integration` branch with the BGOS hook already in history, installs this package, pairs against your BGOS account, writes the managed env block, installs a package-owned wrapper supervisor (launchd on macOS, systemd on Linux), and verifies the connection. It is idempotent: a re-run skips whatever is already done. A custom `--upstream-repo` remains supported; setup applies the public [`BrandGrowthOS/gobot-bgos-patch`](https://github.com/BrandGrowthOS/gobot-bgos-patch) only when the acquired checkout does not contain the hook.

Preview everything it would do without changing anything:

```bash
bunx gobot-channel-bgos setup BGOS-XXXX-XX --dry-run
```

Useful flags: `--install-dir PATH`, `--home-channel both|telegram|bgos`, `--agents route:Name,...`, `--poll-interval N`, `--device-label NAME`, `--yes` (never prompt; leave any competing poller running). The manual path below is still available for a host that already runs a customized Gobot fork.

## Install

```bash
npm i -g gobot-channel-bgos
```

The package is published to npm as `gobot-channel-bgos`. The fork lists it under `optionalDependencies`, so a stock Gobot install still runs without it (BGOS support stays inert until the package is present).

## Pair

After standing up Gobot on your host (Mac mini, VPS, whatever), generate a pair code in BGOS (Integrations screen → "Pair Gobot") and run:

```bash
gobot-pair-bgos BGOS-XXXX-YY --device-label mac-mini
```

This:

1. POSTs `/integrations/pair-exchange` with the code + your device label.
2. Writes the pairing token to `~/.gobot/secrets/bgos.json` (mode 0600).
3. Exits 0 on success, non-zero with a diagnostic on failure.

## Environment variables

The adapter resolves config in order: explicit constructor arg → env var → `~/.gobot/secrets/bgos.json`.

| Var | Default | Purpose |
|---|---|---|
| `BGOS_PAIRING_TOKEN` | _from secrets file_ | The token written by `gobot-pair-bgos`. |
| `BGOS_BASE_URL` | `https://api.brandgrowthos.ai` | BGOS backend root. |
| `GOBOT_HOME` | `~/.gobot` | Where the adapter persists state (`bgos_last_id` cursor + secrets dir). |
| `GOBOT_HOME_CHANNEL` | `both` | Destination for proactive (no-origin) messages: `telegram` \| `bgos` \| `both`. |
| `GOBOT_POLL_INTERVAL` | `5` (seconds) | REST backfill interval. Set to `0` to disable polling once the server-side WS push gap is fixed. |
| `GOBOT_MEDIA_ROOT` | `<cwd>/media` (else `<cwd>`) | **Security allowlist root for outbound files.** Every `sendFile`/`sendImage`/`sendVideo`/`uploadFile` path is realpath-resolved and must live under this root; traversal (`..`), escaping symlinks, and sensitive locations (`/etc`, `~/.ssh`, …) are rejected before any bytes are read. Set it to pin a narrow directory the agent is allowed to send from. |
| `GOBOT_ALLOW_INLINE_AGENT_NAME` | `false` | **Anti-spoof gate.** When off, the plugin drops any agent-supplied inline `fromAgent` display `name`/`avatarUrl`/`color` and forwards only resolvable handles (`peerId`/`assistantId`/`externalId`/`type`), letting the backend resolve identity. Set truthy (`1`/`true`) only when the matching backend per-user inline-identity toggle is on (e.g. Gobot `/board`). |
| `BGOS_OPENAI_API_KEY` | _(unset, voice off)_ | OpenAI API key with Realtime access, used ONLY to mint ephemeral client secrets for in-app voice calls (see the Voice section). Falls back to `OPENAI_API_KEY`. Without it, calls fail with a descriptive "voice not configured" error; chat is unaffected. |
| `BGOS_VOICE_MODEL` | `gpt-realtime-2` | Realtime model for voice calls. |
| `BGOS_VOICE_VOICE` | `marin` | Realtime voice name. |
| `BGOS_VOICE_PERSONA` | _(empty)_ | Extra persona text baked into the voice session instructions. |
| `GOBOT_BGOS_HEARTBEAT_INTERVAL` | `60` (seconds) | Cadence for the daemon heartbeat that reports `daemon_version` + last error to the backend (surfaced in the BGOS Integrations card). `0` disables the network heartbeat; a local `$GOBOT_HOME/bgos_heartbeat.json` is always written for the watchdog. |
| `BGOS_AUTO_UPDATE` | `off` | Exact value `on` opts the supervised Gobot checkout into same-major automatic updates. Exact value `off` is the hard kill switch. |
| `GOBOT_BGOS_BACKFILL_STORM_LIMIT` | `25` | If a single REST backfill returns more than this many messages, the cursor fast-forwards and dispatch is skipped (prevents a history-replay storm after a long outage). `0` disables the guard. |
| `GOBOT_BGOS_CHAT_ID` / `GOBOT_BGOS_CHAT_ID_<assistantId>` | _(auto)_ | **Rarely needed.** Proactive messages (check-ins, briefings) self-resolve their delivery chat via the backend, so you do not normally set this. Set it only to pin a specific chat. |

## Proactive delivery (check-ins, briefings): zero-config

Self-initiated messages (smart check-ins, morning briefings, watchdog alerts, async task pushes) reach BGOS with no extra setup as of **v0.11.1**:

- The proactive sender reads the pairing token from `~/.gobot/secrets/bgos.json` (written by `gobot-pair-bgos`) when it is not in the process env, so the separate check-in/briefing launchd jobs authenticate without a hand-set `GOBOT_PAIRING_TOKEN`.
- It self-resolves each assistant's delivery chat via `POST /api/v1/integrations/assistants/:id/primary-chat` (falling back to `GOBOT_BGOS_CHAT_ID` only if you set it), so you do not have to look up a numeric chat id.

The only knob you normally touch is `GOBOT_HOME_CHANNEL` (`telegram` | `bgos` | `both`, default `both`). Force a delivery test with `bun run briefing`.

## Re-pair (rotate the token without losing history)

If the pairing is revoked or you rotate the token from the BGOS Integrations card, apply the new token without exposing it on the command line:

```bash
bunx gobot-pair-bgos --token -   # reads the pairing token from stdin (paste it, then Ctrl-D)
```

The running daemon watches the secrets directory and re-authenticates the moment the new token lands, no restart required.

## Reliability

Inbound is deduplicated (a message is dispatched exactly once across the live WS push and the REST backfill), the cursor is durable, revocation surfaces as a visible error plus a recover-on-new-token state, and outbound sends retry the network-error class with a bounded on-disk spool. A `daemon_version` heartbeat keeps the Integrations card honest about what the host is running.

## Opt-in checkout updates

The recommended one-paste setup clones or reuses the private Gobot fork and installs this npm package into that checkout. It copies a small wrapper runtime to `$GOBOT_HOME/supervisor`, outside the checkout that updates, and points launchd or systemd at that stable wrapper. The wrapper records boot state before it starts `bun run src/bot.ts`. A fresh clone keeps `HEAD` aligned with its tracked upstream so fast-forward updates remain possible. Automatic update first proves that the working directory, or `GOBOT_INSTALL_DIR` when set, is a git checkout whose package name is `gobot`. Other install layouts are logged and skipped.

Set `BGOS_AUTO_UPDATE=on` to opt in. The default and every unrecognized value are off. An exact `BGOS_AUTO_UPDATE=off` prevents every update check, timer, and git command. A boot with `off` may write only the durable reset marker needed after an automatic rollback.

The private fork also contains an older host updater controlled by `GOBOT_AUTO_UPDATE_FORK`. That is a separate legacy lane and is not used by this adapter. Recommended setup persistently unloads both `com.go.telegram-relay` and `com.go.auto-update`, then loads the package-owned `ai.brandgrowthos.gobot` wrapper. This prevents duplicate Telegram pollers and keeps the legacy lane from changing the checkout when `BGOS_AUTO_UPDATE=off`. Existing private-fork hosts must rerun setup before relying on the new flag.

An opted-in daemon checks at boot, then every 24 hours plus a fresh random delay from zero through six hours. A scheduled check waits while message or spool replay work is active. Commands have a finite timeout and git prompts are disabled. The updater reads the exact latest `gobot-channel-bgos` version from official npm registry metadata and compares it with the running `daemonVersion`. The daemon package update path rejects malformed, cross-major, and constraint-incompatible candidates. A compatible fork-only fast-forward remains eligible when the registry daemon is already current. The registry version is data only and is passed to commands through fixed argument arrays after validation.

The checkout apply step is `git merge --ff-only <validated-target-sha>`. It never resets, forces, or rewrites local history. A merge that cannot fast-forward is logged and skipped. A fork-only update requires the running daemon to satisfy the dependency constraint in the fetched fork manifest. A changed `package.json` or supported tracked lockfile triggers a normal dependency install. The private fork intentionally ignores `bun.lock`, so the updater always follows with `bun install gobot-channel-bgos@<validated-exact-version> --no-save` and verifies the installed `node_modules` package version. This exact refresh also delivers a newer compatible daemon when the fork commit itself has not changed. Tracked dependency files are snapshotted and atomically restored around Bun commands so the updater does not dirty the checkout.

Before changing the checkout, the adapter stops accepting new BGOS work, disconnects its intake, and waits for active message processing, accepted voice dispatches, and outbound spool replay to finish. After a successful update it requests SIGTERM on the Gobot process. The fork's real shutdown handler stops Telegram, saves host state, removes `bot.lock`, stops the adapter, and exits with status 0 so launchd or systemd restarts it. Update check failures before mutation are logged and the daemon continues. A failure after mutation keeps intake stopped and requests supervised recovery.

Rollback state is stored at `$GOBOT_HOME/bgos_auto_update.json`, next to the heartbeat state. Tilde-valued `GOBOT_HOME` uses the same expansion for both files. The state records the previous checkout commit and exact previous daemon package version. The stable parent wrapper starts the 60-second health window before any host import. The child adapter owns the remaining health timer, while the parent owns clean supervisor signals. A child-originated exit is unclean even when its exit status is 0, and a clean supervisor shutdown resets the crash streak. After two consecutive short boots, the next wrapper launch restores the recorded commit and exact package version, then disables further automatic updates. A failed state read, state write, rollback, or verified target recovery prevents the wrapper from starting Gobot and retries under the supervisor. Malformed state also fails closed. In either case, run one supervised boot with `BGOS_AUTO_UPDATE=off`, then set it back to `on` and restart again to reset the latch or malformed state.

Legacy installs that applied the public hook as a local commit can be divergent from their tracked upstream. The updater reports `not-fast-forward` and leaves them unchanged. Move custom work onto the private fork or reconcile that history manually before opting in. The updater never resets or forces a legacy checkout.

The pre-import guarantee applies to the package-owned wrapper installed by recommended setup. A manual `bun run src/bot.ts` launch does not have the parent wrapper, so rerun setup after upgrading an existing host.

## Prerequisites

- The fork (`BrandGrowthOS/gobot-bgos-fork`) must be checked out and running on the host. The fork's loader auto-discovers `gobot-channel-bgos` and wires the adapter into Gobot's bootstrap.
- Bun 1.x (Gobot's runtime); npm-installed packages work fine.
- A reachable BGOS backend (production by default; point `BGOS_BASE_URL` elsewhere for testing).

## Architecture in one diagram

```
┌────────────────── Gobot host process (Bun) ───────────────────┐
│                                                               │
│  grammY Telegram handler ──┐                                  │
│                            ▼                                  │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ processMessageForAgent({ origin, agentRoute, text,       │ │
│  │                          attachments, replyHandle, ... })│ │
│  │ - fork-exported wrapper around Gobot's Claude pipeline   │ │
│  └──────────────────────────────────────────────────────────┘ │
│                            ▲                                  │
│                            │                                  │
│  ┌──────────────────── BGOSAdapter ───────────────────────┐  │
│  │ bgos-ws.ts (Socket.IO)  ◀── REST backfill cursor ◀──── │  │
│  │ bgos-api.ts (REST)                                     │  │
│  │ outbound.ts: sendText / sendButtons / sendApproval ... │  │
│  │ inbound-handler.ts: builds replyHandle, calls dispatch │  │
│  └────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
                                │
                                ▼
                       BGOS backend (api.brandgrowthos.ai)
```

## Agent-to-agent (a2a) peer replies

When another BGOS assistant (a Claude Code, Hermes, OpenClaw, or n8n peer) messages this bot, the backend delivers it as an inbound on an `a2a` side-thread chat, stamped with a `peerConversationId` on the WS `inbound_message` event. The adapter detects that marker and routes the agent's reply back **the same way the other channel plugins do**:

- the reply is posted via `POST /api/v1/send-message` (not `/messages`), the path the backend runs its peer-reply bridge on, and
- it is anchored to the inbound's message id via `reply_to_id`,

so the initiating peer's `wait_for_reply` resolves. This is fully automatic; the agent just calls `replyHandle.sendText(...)` as usual; no peer-specific code is needed in the fork. **Ordinary 1:1 user replies are unchanged** (still `POST /messages`, no `reply_to_id`). The dispatch also surfaces `peerConversationId` + `turnState` on `DispatchArgs` for awareness. No backend change is required; the a2a transport already serves the other plugins. See `hermes-channel-bgos/docs/bgos-agent-capabilities.md` §11 for the wire protocol.

## In-app voice calls (realtime, v0.9.0+)

The user can voice-call a Gobot agent from the BGOS app (assistant `voice_provider='realtime'`). The plugin implements the full `voice_rpc` control plane on the pairing WS lane:

- **mint**: the daemon mints an ephemeral client secret DIRECTLY against OpenAI (`POST /v1/realtime/client_secrets`, key from `BGOS_OPENAI_API_KEY`/`OPENAI_API_KEY`), baking the agent's name, `BGOS_VOICE_PERSONA`, the `gobot_agent_consult` tool, and the recent chat context into the session instructions (`contextInjected:true`). The app then talks WebRTC audio straight to OpenAI; the plugin never proxies audio.
- **Per-assistant voice settings (v0.10.0+)**: the BGOS app's agent voice menu can set a voice (OpenAI GA set), a speaking speed (0.25 to 1.5) and a voice persona per assistant; they arrive on the mint frame as `payload.voiceConfig` and OVERRIDE the env config (`BGOS_VOICE_VOICE` / `BGOS_VOICE_PERSONA` become the fallback only). The daemon sanitizes the wire values (junk voice → env fallback, out-of-range speed → clamped) and echoes the applied voice/speed in the mint result.
- **consult**: mid-call questions run a REAL turn on the Gobot brain through the fork's normal dispatch pipeline, with a capture `ReplyHandle`: the brain's first `sendText` is returned to the voice model (inner cap 38 s, under the backend's 45 s). The turn text is prefixed `[voice_consult]` and the system prompt tells the brain to answer in short speakable plain text.
- **dispatch**: "do real work" requests are ACCEPTED within the backend's 10 s window, then run detached (up to 10 min) through the same pipeline; the final reply text is posted to `POST /integrations/voice-tasks/:taskId/result` (retried once) and surfaces in the in-call Agent Work Stream.

No fork changes are required; the adapter wires everything through the already-registered `setDispatch` function. Enable voice by exporting `BGOS_OPENAI_API_KEY` in the Gobot daemon's environment and restarting it, then set the assistant's voice provider to **Native (realtime)** in the BGOS app.

## Troubleshooting

**No replies in BGOS, but Telegram works:**
- Tail `~/.gobot/logs/bgos-daemon.log` (the fork's loader writes here). Look for `whoami OK`, `connected`, `catalog pushed`.
- Confirm `~/.gobot/secrets/bgos.json` exists and is readable: `cat ~/.gobot/secrets/bgos.json | jq .pairingId`.
- Re-pair via the BGOS Integrations card if the pairing was revoked; adapter logs `PAIRING_REVOKED` on 401.

**Replies are duplicated after every restart:**
- The persisted cursor at `$GOBOT_HOME/bgos_last_id` failed to update. This file MUST advance with every processed message; if it stays at 0, every restart replays history.
- Reset cursor manually: `echo <max-message-id> > ~/.gobot/bgos_last_id`. Or `rm` it to start fresh (will replay everything once).

**Logs:** the fork pipes adapter output through Gobot's logger. On a default Mac install, look in `~/.gobot/logs/`.

**Reset everything:**
```bash
rm -rf ~/.gobot/secrets ~/.gobot/bgos_last_id
gobot-pair-bgos <NEW-CODE>
# restart Gobot
```

## What lives in this package

| Module | Role |
|---|---|
| `BGOSAdapter` (`src/adapter.ts`) | Lifecycle, route map, dispatch injection, poll loop |
| `BgosOutbound` (`src/outbound.ts`) | All outbound modalities |
| `inbound-handler.ts` | WS event → Gobot dispatch translator |
| `attachment-bridge.ts` | BGOS files ⇄ local file paths (S3 + base64) |
| `agent-hints.ts` | System-prompt addendum injected at dispatch |
| `default-commands.ts` | 7 seeded slash commands |
| `last-id-store.ts` | Persistent inbound cursor (CRITICAL, see source) |
| `voice-rpc.ts` | In-app voice control plane: mint (OpenAI direct) / consult / dispatch |
| `pair-cli.ts` | `gobot-pair-bgos` CLI |
| `home-channel.ts` | Resolves `GOBOT_HOME_CHANNEL` for proactive messages |

## Development

```bash
git clone https://github.com/BrandGrowthOS/gobot-channel-bgos
cd gobot-channel-bgos
npm install
npm test          # vitest
npm run build     # tsc + finalize-daemon
GOBOT_INSTALL_DIR=/path/to/gobot npm run self-update:dry-run  # fetch and inspect without applying
```

The package is also mirrored inside the BGOS monorepo at `gobot-channel-bgos/`; the public repo is the source of truth (matching the Hermes pattern).

## License

MIT.
