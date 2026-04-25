# gobot-channel-bgos

BGOS channel adapter for [Gobot](https://github.com/autonomee/gobot) — Socket.IO + REST client, full outbound modality coverage (text, inline buttons, approvals, ask-user-input pop-under, files/images/videos, typing), and a pair-CLI for first-time setup.

The fork ([`BrandGrowthOS/gobot-bgos-fork`](https://github.com/BrandGrowthOS/gobot-bgos-fork) — private) wires this package into Gobot's existing message pipeline. Telegram and BGOS run side-by-side; replies always return to whichever channel the user wrote in.

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

## Prerequisites

- The fork (`BrandGrowthOS/gobot-bgos-fork`) must be checked out and running on the host. The fork's loader auto-discovers `gobot-channel-bgos` and wires the adapter into Gobot's bootstrap.
- Bun 1.x (Gobot's runtime) — npm-installed packages work fine.
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
│  │ — fork-exported wrapper around Gobot's Claude pipeline   │ │
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

## Troubleshooting

**No replies in BGOS, but Telegram works:**
- Tail `~/.gobot/logs/bgos-daemon.log` (the fork's loader writes here). Look for `whoami OK`, `connected`, `catalog pushed`.
- Confirm `~/.gobot/secrets/bgos.json` exists and is readable: `cat ~/.gobot/secrets/bgos.json | jq .pairingId`.
- Re-pair via the BGOS Integrations card if the pairing was revoked — adapter logs `PAIRING_REVOKED` on 401.

**Replies are duplicated after every restart:**
- The persisted cursor at `$GOBOT_HOME/bgos_last_id` failed to update. This file MUST advance with every processed message — if it stays at 0, every restart replays history.
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
| `last-id-store.ts` | Persistent inbound cursor (CRITICAL — see source) |
| `pair-cli.ts` | `gobot-pair-bgos` CLI |
| `home-channel.ts` | Resolves `GOBOT_HOME_CHANNEL` for proactive messages |

## Development

```bash
git clone https://github.com/BrandGrowthOS/gobot-channel-bgos
cd gobot-channel-bgos
npm install
npm test          # vitest
npm run build     # tsc + finalize-daemon
```

The package is also mirrored inside the BGOS monorepo at `gobot-channel-bgos/` — the public repo is the source of truth (matching the Hermes pattern).

## License

MIT.
