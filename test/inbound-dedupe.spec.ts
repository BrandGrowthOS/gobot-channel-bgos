/**
 * Route-gated dedupe + unknown-assistant recovery in the inbound handler
 * (contract C3). The ProcessedIdsCache is checked SYNCHRONOUSLY after the
 * route resolves; an unknown-assistant inbound stays UNCONSUMED (no dedupe
 * mark, no cursor save) so the poll can re-fetch it until identity heals.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BgosApi } from "../src/bgos-api.js";
import { BgosOutbound } from "../src/outbound.js";
import { createInboundHandler } from "../src/inbound-handler.js";
import { loadLastId } from "../src/last-id-store.js";
import type { InboundMessagePayload } from "../src/types.js";
import { MockBgosServer } from "./mocks/mock-bgos-server.js";

function makeApi(baseUrl: string) {
  return new BgosApi({
    baseUrl,
    pairingToken: "pair_" + "x".repeat(30),
    reconnect: { initialDelayMs: 100, maxDelayMs: 1000 },
  });
}

function inbound(over: Partial<InboundMessagePayload> = {}): InboundMessagePayload {
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

describe("inbound handler: dedupe + unknown-route recovery", () => {
  let server: MockBgosServer;
  let baseUrl: string;
  let tempHome: string;
  const originalGobotHome = process.env.GOBOT_HOME;

  beforeEach(async () => {
    server = new MockBgosServer();
    baseUrl = await server.start();
    tempHome = mkdtempSync(join(tmpdir(), "gobot-dedupe-test-"));
    process.env.GOBOT_HOME = tempHome;
  });
  afterEach(async () => {
    await server.stop();
    rmSync(tempHome, { recursive: true, force: true });
    if (originalGobotHome === undefined) delete process.env.GOBOT_HOME;
    else process.env.GOBOT_HOME = originalGobotHome;
  });

  it("dispatches a first-seen message and dedupes the duplicate", async () => {
    const dispatch = vi.fn(async () => {});
    const handler = createInboundHandler({
      outbound: new BgosOutbound(makeApi(baseUrl)),
      getRouteForAssistant: () => "general",
      getDispatch: () => dispatch,
    });

    await handler(inbound({ messageId: 500 }));
    await handler(inbound({ messageId: 500 })); // duplicate -> skipped

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(loadLastId()).toBe(500);
  });

  it("leaves an unknown-assistant message UNCONSUMED (no dispatch, no cursor save)", async () => {
    const dispatch = vi.fn(async () => {});
    const handler = createInboundHandler({
      outbound: new BgosOutbound(makeApi(baseUrl)),
      getRouteForAssistant: () => null, // never resolves
      getDispatch: () => dispatch,
    });

    await handler(inbound({ messageId: 999 }));

    expect(dispatch).not.toHaveBeenCalled();
    // Cursor NOT advanced -> the poll will re-fetch it.
    expect(loadLastId()).toBe(0);
  });

  it("recovers when onUnknownAssistant heals the route map, then dispatches", async () => {
    const dispatch = vi.fn(async () => {});
    const routes = new Map<number, string>();
    const onUnknownAssistant = vi.fn(async (id: number) => {
      routes.set(id, "general"); // simulate identity heal
    });
    const handler = createInboundHandler({
      outbound: new BgosOutbound(makeApi(baseUrl)),
      getRouteForAssistant: (id) => routes.get(id) ?? null,
      getDispatch: () => dispatch,
      onUnknownAssistant,
    });

    await handler(inbound({ assistantId: 7, messageId: 321 }));

    expect(onUnknownAssistant).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(loadLastId()).toBe(321);
  });

  it("stays unconsumed when onUnknownAssistant cannot heal the route", async () => {
    const dispatch = vi.fn(async () => {});
    const onUnknownAssistant = vi.fn(async () => {}); // never adds the route
    const handler = createInboundHandler({
      outbound: new BgosOutbound(makeApi(baseUrl)),
      getRouteForAssistant: () => null,
      getDispatch: () => dispatch,
      onUnknownAssistant,
    });

    await handler(inbound({ assistantId: 8, messageId: 654 }));

    expect(onUnknownAssistant).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(loadLastId()).toBe(0);
  });

  it("fires onInbound only for a consumed (dispatched) message", async () => {
    const onInbound = vi.fn();
    const handler = createInboundHandler({
      outbound: new BgosOutbound(makeApi(baseUrl)),
      getRouteForAssistant: (id) => (id === 1 ? "general" : null),
      getDispatch: () => async () => {},
      onInbound,
    });

    await handler(inbound({ assistantId: 1, messageId: 111 })); // known
    await handler(inbound({ assistantId: 2, messageId: 222 })); // unknown

    expect(onInbound).toHaveBeenCalledTimes(1);
  });
});
