# P2P Discussion (Cross-channel agent-to-agent) — Gobot quickstart

This is the operator-facing runbook for upgrading a Gobot deployment to use the BGOS peer-to-peer (P2P) discussion feature. After applying these steps, every Gobot agent on a paired BGOS account can discover, message, and collaborate with the user's other BGOS assistants (Claude Code, Hermes, OpenClaw, n8n agents) live in the chat.

> **Source of truth:** `hermes-channel-bgos/docs/bgos-agent-capabilities.md` §11.

## What changed in this release

`gobot-channel-bgos@0.2.0` adds:

1. **Eight new methods on `BgosApi`** — `listPeers`, `peerStatus`, `sendToPeer`, `completePeerThread`, `completeSideThread`, `getSideThread`, `getPeerInbox`. All carry the new `X-Caller-Assistant-Id` header.
2. **A high-level `BgosPeerClient`** (`src/bgos-peer-client.ts`) that normalizes responses and exposes a typed surface.
3. **A `peers` namespace on every `ReplyHandle`** — Gobot agent code calls `replyHandle.peers.list()`, `peers.status({...})`, `peers.send({...})`, `peers.complete({...})` without ever touching HTTP. The caller assistant id is closure-captured.
4. **Four new bridge-local slash commands** intercepted by the adapter (never reach the Gobot agent):
   - `/peers` — list peers with introduced ✓/✗
   - `/peer-status <name|id>` — online state + open conversation
   - `/peer-send <name|id> <text> [--wait]` — send to peer with auto-anchor
   - `/peer-complete [<summary>]` — close the most recent open peer conversation
5. **Inline marker syntax** in `replyHandle.sendText(text)` — when the agent's reply text contains `[[BGOS_PEER_SEND name="..." text="..." wait="..." turn="..."]]` or `[[BGOS_PEER_COMPLETE summary="..."]]`, the adapter strips the markers from the user-visible text, posts the cleaned reply, and dispatches the parsed directives. Mirrors the Hermes `[[BGOS_PEER_*]]` syntax exactly so an agent author can target both with the same prompt template.
6. **Updated `BGOS_AGENT_HINTS`** addendum (`src/agent-hints.ts`) — appends a "Collaborating with other BGOS agents" section so the agent's system prompt documents the capability.

## How to upgrade a deployment

```bash
# In the Gobot fork's vendor dependency:
npm install gobot-channel-bgos@0.2.0
# Or, if the fork vendors from a local checkout, bump the version pin
# in fork's package.json and re-yarn.

# Restart the Gobot daemon
systemctl restart gobot
```

The four new bridge-locals appear automatically in the BGOS slash picker after restart (we extended `DEFAULT_COMMANDS` to include them; existing assistants with a non-empty manifest are unaffected since the adapter only seeds when the manifest is empty).

## Verification (5 minutes)

1. **Pair the daemon normally** with the Gobot pair-cli flow.
2. **Open the BGOS app** and start a chat with a Gobot-bound assistant.
3. **Type `/peers`** — expect a markdown list of every other assistant on your account with introduced ✗ markers.
4. **Open BGOS Settings → Agent Permissions** and enable the row from your Gobot assistant to one of the others.
5. **Type `/peers`** again — that row should now show ✓.
6. **Type `/peer-send <name> Hello peer!`** — expect:
   - A "Looping in <peer>…" reply.
   - A `<SideConversationCard>` rendered under that reply.
   - The peer assistant receives the message tagged with `fromAgent` (cyan bubble).
7. **Have the peer reply** (it must set `replyToId` to the inbound message id; this is automatic in matching channel-adapter versions).
8. **Type `/peer-complete Done.`** — the card flips to completed-collapsed with the summary.

## Agent-facing usage (programmatic)

In the Gobot fork's per-agent handler:

```typescript
async function handle(args: DispatchArgs): Promise<void> {
  const { replyHandle } = args;

  // Discover peers
  const peers = await replyHandle.peers.list();
  const hades = peers.find((p) => p.name === "Hades");
  if (!hades || !hades.introduced) {
    await replyHandle.sendText(
      "I'd hand this off to Hades but the user hasn't enabled that. Want me to ask?"
    );
    return;
  }

  // Anchor + send
  const anchor = await replyHandle.sendText(`Looping in ${hades.name}…`);
  const result = await replyHandle.peers.send({
    targetAssistantId: hades.assistantId,
    text: "Please create bgos-dev-uploads in us-east-1, public access blocked.",
    parentMessageId: anchor.id,
    waitForReply: true,
  });

  // Synthesize + close
  if (result.reply) {
    await replyHandle.sendText(`Hades confirmed: ${result.reply.text}`);
    await replyHandle.peers.complete({
      peerAssistantId: hades.assistantId,
      summary: `Hades created bgos-dev-uploads in us-east-1, public access blocked`,
    });
  }
}
```

## Agent-facing usage (inline markers)

For LLM-driven agents that don't have direct programmatic access to the
`peers` handle, use marker blocks in the reply text — the adapter parses
and dispatches them automatically:

```
Looping in Hades for the AWS bucket creation.

[[BGOS_PEER_SEND name="Hades" text="Please create bgos-dev-uploads in us-east-1 with public access blocked." wait="true"]]
```

When the peer responds and the work is complete:

```
Hades confirmed the bucket is up. You can upload to s3://bgos-dev-uploads/ now.

[[BGOS_PEER_COMPLETE summary="Hades created bgos-dev-uploads in us-east-1, public access blocked"]]
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `/peers` lists nothing | Single-assistant account | Create a second assistant via another channel |
| Every peer shows ✗ | No introductions enabled | BGOS Settings → Agent Permissions |
| `peers.send` returns `requires_introduction` | Same as above | Same fix |
| `waitForReply: true` times out | Peer adapter doesn't set `replyToId` | Upgrade peer adapter |
| Markers appear in user-visible text | Adapter version too old | Upgrade to `gobot-channel-bgos@0.2.0` and restart Gobot |
| Card doesn't render in BGOS | Frontend version too old | BGOS desktop ≥ 1.19.0 / mobile build ≥ 2026-04-30 |
