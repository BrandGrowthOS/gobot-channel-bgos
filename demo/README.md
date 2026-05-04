# Gobot ↔ BGOS — visual demo (PR #3)

Interactive mock of the three fixes shipped in branch
`claude/fix-slash-commands-visibility-jPfgQ`.

Companion PRs
- `gobot-channel-bgos` — this repo, PR #3 (the API surface)
- `gobot-bgos-fork` — PR #3 (the fork uses the new helpers)

## Run locally (no build step)

```bash
cd demo && python3 -m http.server 4173
# open http://localhost:4173
```

Or open `demo/index.html` directly in a browser.

## Deploy to Vercel (one command)

```bash
# from the repo root
cd demo && npx vercel deploy --yes --prod
```

Vercel autodetects the static site (no framework, no build), uploads
the four files, and returns a `https://<project>-<hash>.vercel.app`
URL. The included `vercel.json` only sets cache + security headers.

## What it shows

1. **Slash picker** (`#fix-1`) — the seven Gobot defaults rendered in
   the BGOS composer dropdown (before / after).
2. **`/board` run** (`#fix-2`) — interactive playthrough of seven
   per-agent bubbles posted by a single bound assistant via
   `from_agent_inline`. Each bubble has its own name, accent color,
   and avatar initial; press **Play /board run** or wait for the
   auto-play.
3. **Proactive briefings** (`#fix-3`) — toggle
   `GOBOT_HOME_CHANNEL=telegram | both | bgos` to see how the same
   morning-briefing payload routes to one client or both.

## Stack

Static HTML + CSS + a single JS file. No build step. ~42 KB total.
