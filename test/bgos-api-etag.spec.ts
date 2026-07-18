import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BgosApi } from "../src/bgos-api.js";
import { PairingRevokedError } from "../src/types.js";
import { MockBgosServer } from "./mocks/mock-bgos-server.js";

function makeApi(baseUrl: string): BgosApi {
  return new BgosApi({
    baseUrl,
    pairingToken: "pair_" + "g".repeat(30),
    reconnect: { initialDelayMs: 100, maxDelayMs: 1000 },
  });
}

async function waitForRequests(
  server: MockBgosServer,
  count: number,
): Promise<void> {
  const deadline = Date.now() + 1000;
  while (server.requests.length < count) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for request");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("BgosApi conditional GET cache (Gobot)", () => {
  let server: MockBgosServer;
  let baseUrl: string;

  beforeEach(async () => {
    server = new MockBgosServer();
    baseUrl = await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("reuses the cached inbound body after a 200 then 304", async () => {
    const body = { messages: [] };
    server
      .stage("GET", "/api/v1/integrations/inbound", 200, body, {
        ETag: 'W/"inbound-42"',
      })
      .stage("GET", "/api/v1/integrations/inbound", 304, undefined);

    const api = makeApi(baseUrl);
    const first = await api.inboundSince(42);
    const second = await api.inboundSince(42);

    expect(first).toEqual(body);
    expect(second).toEqual(body);
    expect(server.requests[0]!.headers["if-none-match"]).toBeUndefined();
    expect(server.requests[1]!.headers["if-none-match"]).toBe(
      'W/"inbound-42"',
    );
  });

  it("sends afterId and reuses cached getMessages rows on 304", async () => {
    const envelope = {
      messages: [
        {
          message: {
            id: 124,
            sender: "user",
            text: "delta",
            messageType: "standard",
            createdAt: "2026-07-17T00:00:00Z",
          },
        },
      ],
    };
    server
      .stage("GET", "/api/v1/chats/7/messages", 200, envelope, {
        ETag: 'W/"chat-7-after-123"',
      })
      .stage("GET", "/api/v1/chats/7/messages", 304, undefined);

    const api = makeApi(baseUrl);
    const first = await api.getMessages(7, "user_gobot", 123);
    const second = await api.getMessages(7, "user_gobot", 123);

    expect(first).toEqual(envelope.messages);
    expect(first[0]!.message.id).toBe(124);
    expect(second).toEqual(first);
    expect(server.requests[0]!.url).toContain("userId=user_gobot");
    expect(server.requests[0]!.url).toContain("afterId=123");
    expect(server.requests[0]!.url).toContain("limit=50");
    expect(server.requests[1]!.headers["if-none-match"]).toBe(
      'W/"chat-7-after-123"',
    );
  });

  it("keeps afterId optional and serializes a zero cursor", async () => {
    server
      .stage("GET", "/api/v1/chats/7/messages", 200, { messages: [] })
      .stage("GET", "/api/v1/chats/7/messages", 200, { messages: [] });

    const api = makeApi(baseUrl);
    await api.getMessages(7, "user_gobot");
    await api.getMessages(7, "user_gobot", 0);

    expect(server.requests[0]!.url).not.toContain("afterId=");
    expect(server.requests[1]!.url).toContain("afterId=0");
  });

  it("bounds entries at 50 and evicts the least recently used full URL", async () => {
    for (let cursor = 0; cursor < 50; cursor++) {
      server.stage(
        "GET",
        "/api/v1/integrations/inbound",
        200,
        { messages: [] },
        { ETag: `W/"cursor-${cursor}"` },
      );
    }

    const api = makeApi(baseUrl);
    for (let cursor = 0; cursor < 50; cursor++) {
      await api.inboundSince(cursor);
      expect(server.requests.at(-1)!.headers["if-none-match"]).toBeUndefined();
    }

    server.stage("GET", "/api/v1/integrations/inbound", 304, undefined);
    await api.inboundSince(0);
    expect(server.requests.at(-1)!.headers["if-none-match"]).toBe(
      'W/"cursor-0"',
    );

    server.stage(
      "GET",
      "/api/v1/integrations/inbound",
      200,
      { messages: [] },
      { ETag: 'W/"cursor-50"' },
    );
    await api.inboundSince(50);

    server.stage(
      "GET",
      "/api/v1/integrations/inbound",
      200,
      { messages: [] },
      { ETag: 'W/"cursor-1-new"' },
    );
    await api.inboundSince(1);
    expect(server.requests.at(-1)!.headers["if-none-match"]).toBeUndefined();

    server.stage("GET", "/api/v1/integrations/inbound", 304, undefined);
    await api.inboundSince(0);
    expect(server.requests.at(-1)!.headers["if-none-match"]).toBe(
      'W/"cursor-0"',
    );
  });

  it("clears a stale validator when a later 200 has no ETag", async () => {
    server
      .stage(
        "GET",
        "/api/v1/integrations/inbound",
        200,
        { messages: [{ messageId: 1 }] },
        { ETag: 'W/"with-validator"' },
      )
      .stage("GET", "/api/v1/integrations/inbound", 200, {
        messages: [{ messageId: 2 }],
      })
      .stage("GET", "/api/v1/integrations/inbound", 200, {
        messages: [{ messageId: 3 }],
      });

    const api = makeApi(baseUrl);
    expect((await api.inboundSince(1)).messages[0]!.messageId).toBe(1);
    expect((await api.inboundSince(1)).messages[0]!.messageId).toBe(2);
    expect(server.requests[1]!.headers["if-none-match"]).toBe(
      'W/"with-validator"',
    );
    expect((await api.inboundSince(1)).messages[0]!.messageId).toBe(3);
    expect(server.requests[2]!.headers["if-none-match"]).toBeUndefined();
  });

  it("does not let a delayed 304 replace a newer cached 200", async () => {
    server.stage(
      "GET",
      "/api/v1/integrations/inbound",
      200,
      { messages: [{ messageId: 1 }] },
      { ETag: 'W/"old"' },
    );
    const api = makeApi(baseUrl);
    await api.inboundSince(77);

    server
      .stage(
        "GET",
        "/api/v1/integrations/inbound",
        304,
        undefined,
        undefined,
        100,
      )
      .stage(
        "GET",
        "/api/v1/integrations/inbound",
        200,
        { messages: [{ messageId: 2 }] },
        { ETag: 'W/"new"' },
      );

    const delayed = api.inboundSince(77);
    await waitForRequests(server, 2);
    expect((await api.inboundSince(77)).messages[0]!.messageId).toBe(2);
    expect((await delayed).messages[0]!.messageId).toBe(1);

    server.stage("GET", "/api/v1/integrations/inbound", 304, undefined);
    expect((await api.inboundSince(77)).messages[0]!.messageId).toBe(2);
    expect(server.requests.at(-1)!.headers["if-none-match"]).toBe('W/"new"');
  });

  it("retries an unsolicited 304 once without a validator", async () => {
    server
      .stage("GET", "/api/v1/integrations/inbound", 304, undefined)
      .stage(
        "GET",
        "/api/v1/integrations/inbound",
        200,
        { messages: [{ messageId: 8 }] },
        { ETag: 'W/"recovered"' },
      );

    const api = makeApi(baseUrl);
    expect((await api.inboundSince(8)).messages[0]!.messageId).toBe(8);
    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]!.headers["if-none-match"]).toBeUndefined();
    expect(server.requests[1]!.headers["if-none-match"]).toBeUndefined();
  });

  it("still maps a conditional request 401 to PairingRevokedError", async () => {
    server
      .stage(
        "GET",
        "/api/v1/integrations/inbound",
        200,
        { messages: [] },
        { ETag: 'W/"still-authorized"' },
      )
      .stage("GET", "/api/v1/integrations/inbound", 401, {
        message: "pairing revoked",
      });

    const api = makeApi(baseUrl);
    await api.inboundSince(9);
    const error = await api.inboundSince(9).catch((caught) => caught);
    expect(error).toBeInstanceOf(PairingRevokedError);
    expect(error).toMatchObject({
      name: PairingRevokedError.name,
      message: "pairing revoked",
    });
  });
});
