/**
 * a2a (agent-to-agent / peer) reply routing.
 *
 * Regression coverage for the GoBot↔peer-agent gap: when a peer agent
 * messages this bot, the reply MUST go back via `POST /send-message`
 * (the path the backend runs `bridgePeerReplyIfApplicable` on) carrying
 * `reply_to_id`, so the initiating peer's `wait_for_reply` resolves.
 * Normal user replies must be UNCHANGED — `POST /messages`, no
 * `reply_to_id` — so this is additive and cannot regress 1:1 chats.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BgosApi } from "../src/bgos-api.js";
import { BgosWs } from "../src/bgos-ws.js";
import { BgosOutbound } from "../src/outbound.js";
import { createInboundHandler } from "../src/inbound-handler.js";
import type { InboundMessagePayload } from "../src/types.js";
import { MockBgosServer } from "./mocks/mock-bgos-server.js";

function makeApi(baseUrl: string) {
  return new BgosApi({
    baseUrl,
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
    text: "Hi Echo, this is Mark.",
    files: [],
    messageType: "standard",
    ...over,
  };
}

describe("a2a peer-reply routing", () => {
  let server: MockBgosServer;
  let baseUrl: string;
  let tempHome: string;
  const originalGobotHome = process.env.GOBOT_HOME;

  beforeEach(async () => {
    server = new MockBgosServer();
    baseUrl = await server.start();
    tempHome = mkdtempSync(join(tmpdir(), "gobot-a2a-test-"));
    process.env.GOBOT_HOME = tempHome;
  });
  afterEach(async () => {
    await server.stop();
    rmSync(tempHome, { recursive: true, force: true });
    if (originalGobotHome === undefined) delete process.env.GOBOT_HOME;
    else process.env.GOBOT_HOME = originalGobotHome;
  });

  // --- normalizer ----------------------------------------------------

  it("normalizeInbound captures peerConversationId + turnState (camelCase)", () => {
    const ws = new BgosWs({} as never, makeApi(baseUrl));
    const msg = (ws as unknown as {
      normalizeInbound(r: unknown): InboundMessagePayload | null;
    }).normalizeInbound({
      assistantId: 1,
      chatId: 200,
      messageId: 777,
      userId: "u",
      text: "hi",
      peerConversationId: 555,
      turnState: "expecting_reply",
    });
    expect(msg?.peerConversationId).toBe(555);
    expect(msg?.turnState).toBe("expecting_reply");
  });

  it("normalizeInbound captures snake_case peer_conversation_id + turn_state", () => {
    const ws = new BgosWs({} as never, makeApi(baseUrl));
    const msg = (ws as unknown as {
      normalizeInbound(r: unknown): InboundMessagePayload | null;
    }).normalizeInbound({
      assistant_id: 1,
      chat_id: 200,
      message_id: 777,
      peer_conversation_id: 555,
      turn_state: "final",
    });
    expect(msg?.peerConversationId).toBe(555);
    expect(msg?.turnState).toBe("final");
  });

  it("normalizeInbound omits peer fields for an ordinary user message", () => {
    const ws = new BgosWs({} as never, makeApi(baseUrl));
    const msg = (ws as unknown as {
      normalizeInbound(r: unknown): InboundMessagePayload | null;
    }).normalizeInbound({
      assistantId: 1,
      chatId: 200,
      messageId: 777,
      text: "hi",
    });
    expect(msg?.peerConversationId).toBeUndefined();
    expect(msg?.turnState).toBeUndefined();
  });

  // --- outbound endpoint selection -----------------------------------

  it("outbound.sendText(replyVia=send-message) hits POST /send-message", async () => {
    server.stage("POST", "/api/v1/send-message", 200, { message: { id: 99 } });
    const out = new BgosOutbound(makeApi(baseUrl));
    const res = await out.sendText({
      assistantId: 1,
      chatId: 200,
      text: "reply",
      replyToId: 777,
      replyVia: "send-message",
    });
    const req = server.requests.at(-1)!;
    expect(req.url.split("?")[0]).toBe("/api/v1/send-message");
    expect(req.body).toMatchObject({ replyToId: 777, sender: "assistant" });
    // /send-message nests the id under `message` — outbound must unwrap it.
    expect(res.id).toBe(99);
  });

  it("outbound.sendText default still hits POST /messages (unchanged)", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 11 });
    const out = new BgosOutbound(makeApi(baseUrl));
    await out.sendText({ assistantId: 1, chatId: 200, text: "reply" });
    const req = server.requests.at(-1)!;
    expect(req.url.split("?")[0]).toBe("/api/v1/messages");
    expect((req.body as Record<string, unknown>).replyToId).toBeUndefined();
  });

  // --- inbound handler end-to-end ------------------------------------

  it("peer inbound → reply auto-routes to /send-message with reply_to_id", async () => {
    server.stage("POST", "/api/v1/send-message", 200, { message: { id: 99 } });
    const handler = createInboundHandler({
      outbound: new BgosOutbound(makeApi(baseUrl)),
      getRouteForAssistant: () => "general",
      getDispatch: () => async (args) => {
        await args.replyHandle.sendText("Hey Mark!");
      },
    });

    await handler(inbound({ peerConversationId: 555, turnState: "expecting_reply" }));

    const req = server.requests.at(-1)!;
    expect(req.url.split("?")[0]).toBe("/api/v1/send-message");
    expect(req.body).toMatchObject({
      chatId: 200,
      sender: "assistant",
      text: "Hey Mark!",
      replyToId: 777, // == the peer inbound's messageId
    });
  });

  it("ordinary user inbound → reply stays on /messages, no reply_to_id", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 11 });
    const handler = createInboundHandler({
      outbound: new BgosOutbound(makeApi(baseUrl)),
      getRouteForAssistant: () => "general",
      getDispatch: () => async (args) => {
        await args.replyHandle.sendText("Hello!");
      },
    });

    await handler(inbound()); // no peer markers

    const req = server.requests.at(-1)!;
    expect(req.url.split("?")[0]).toBe("/api/v1/messages");
    expect((req.body as Record<string, unknown>).replyToId).toBeUndefined();
  });

  it("a follow-up in a known a2a chat (no markers, e.g. REST poll) still routes to /send-message", async () => {
    server.stage("POST", "/api/v1/send-message", 200, { message: { id: 99 } });
    server.stage("POST", "/api/v1/send-message", 200, { message: { id: 100 } });
    const handler = createInboundHandler({
      outbound: new BgosOutbound(makeApi(baseUrl)),
      getRouteForAssistant: () => "general",
      getDispatch: () => async (args) => {
        await args.replyHandle.sendText("ack");
      },
    });

    // first message carries markers → chat is learned as a2a
    await handler(inbound({ messageId: 777, peerConversationId: 555 }));
    // second message in same chat arrives WITHOUT markers (poll backfill)
    await handler(inbound({ messageId: 778 }));

    const req = server.requests.at(-1)!;
    expect(req.url.split("?")[0]).toBe("/api/v1/send-message");
    expect(req.body).toMatchObject({ replyToId: 778 });
  });

  it("surfaces peerConversationId + messageId on DispatchArgs", async () => {
    server.stage("POST", "/api/v1/send-message", 200, { message: { id: 99 } });
    let seen: { peerConversationId?: number; messageId?: number } = {};
    const handler = createInboundHandler({
      outbound: new BgosOutbound(makeApi(baseUrl)),
      getRouteForAssistant: () => "general",
      getDispatch: () => async (args) => {
        seen = {
          peerConversationId: (args as { peerConversationId?: number })
            .peerConversationId,
          messageId: (args as { messageId?: number }).messageId,
        };
        await args.replyHandle.sendText("ok");
      },
    });
    await handler(inbound({ messageId: 777, peerConversationId: 555 }));
    expect(seen.peerConversationId).toBe(555);
    expect(seen.messageId).toBe(777);
  });
});
