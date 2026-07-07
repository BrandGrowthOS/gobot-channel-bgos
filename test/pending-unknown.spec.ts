/**
 * V1 regression: an unknown-assistant inbound must not be permanently lost when
 * a sibling KNOWN message advances the disk cursor past it (monotonic cursor
 * stranding the hole). The pending-unknown store clamps the cursor below the
 * lowest unconsumed unknown id so the inbound window stays re-fetchable until
 * the route heals; ProcessedIdsCache dedupes the already-consumed ids above the
 * hole so the re-fetch delivers the healed message exactly once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BgosApi } from "../src/bgos-api.js";
import { BgosOutbound } from "../src/outbound.js";
import { createInboundHandler } from "../src/inbound-handler.js";
import { loadLastId } from "../src/last-id-store.js";
import { loadPendingUnknown } from "../src/pending-unknown-store.js";
import type { InboundMessagePayload } from "../src/types.js";

function makeApi() {
  return new BgosApi({
    baseUrl: "http://127.0.0.1:1",
    pairingToken: "pair_" + "x".repeat(30),
    reconnect: { initialDelayMs: 100, maxDelayMs: 1000 },
  });
}

function inbound(
  over: Partial<InboundMessagePayload> = {},
): InboundMessagePayload {
  return {
    assistantId: 1,
    userId: "user_1",
    chatId: 200,
    messageId: 777,
    text: "hi",
    files: [],
    messageType: "standard",
    ...over,
  };
}

describe("pending-unknown durable clamp (silent-loss fix)", () => {
  let tempHome: string;
  const originalGobotHome = process.env.GOBOT_HOME;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "gobot-pending-unknown-"));
    process.env.GOBOT_HOME = tempHome;
  });
  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    if (originalGobotHome === undefined) delete process.env.GOBOT_HOME;
    else process.env.GOBOT_HOME = originalGobotHome;
  });

  it("re-fetches and delivers a stranded unknown message once after the route heals", async () => {
    // assistant 1 is bound; assistant 9 is not yet in the route map.
    const routes = new Map<number, string>([[1, "general"]]);
    const outbound = new BgosOutbound(makeApi());

    const dispatch1 = vi.fn(async () => {});
    const handler1 = createInboundHandler({
      outbound,
      getRouteForAssistant: (id) => routes.get(id) ?? null,
      getDispatch: () => dispatch1,
    });

    // Unknown msg 500 arrives first (assistant 9 unbound) -> left UNCONSUMED
    // and recorded pending. Sibling KNOWN msg 501 is consumed.
    await handler1(inbound({ assistantId: 9, messageId: 500 }));
    await handler1(inbound({ assistantId: 1, messageId: 501 }));

    expect(dispatch1).toHaveBeenCalledTimes(1); // only 501 dispatched
    expect(loadPendingUnknown().map((e) => e.id)).toContain(500);
    // Cursor CLAMPED just below the hole, NOT advanced to 501. Without the fix
    // it would be 501 and inboundSince(501) would never return 500 again.
    expect(loadLastId()).toBe(499);

    // ---- simulate a restart: fresh handler (empty dedupe cache), route heals.
    routes.set(9, "general");
    const dispatch2 = vi.fn(async () => {});
    const handler2 = createInboundHandler({
      outbound,
      getRouteForAssistant: (id) => routes.get(id) ?? null,
      getDispatch: () => dispatch2,
    });

    // Backfill re-fetches inboundSince(loadLastId()) -> the window [500, 501].
    const since = loadLastId();
    const window = [
      inbound({ assistantId: 9, messageId: 500 }),
      inbound({ assistantId: 1, messageId: 501 }),
    ].filter((m) => m.messageId > since);
    // Two poll ticks re-deliver the same window; the fresh dedupe cache
    // guarantees each is dispatched at most once this session.
    for (const m of window) await handler2(m);
    for (const m of window) await handler2(m);

    const dispatched500 = dispatch2.mock.calls.filter(
      (c) => c[0].messageId === 500,
    );
    expect(dispatched500).toHaveLength(1); // delivered EXACTLY once after heal
    expect(loadPendingUnknown()).toHaveLength(0); // hole cleared
    expect(loadLastId()).toBe(501); // cursor caught up past the healed hole
  });
});
