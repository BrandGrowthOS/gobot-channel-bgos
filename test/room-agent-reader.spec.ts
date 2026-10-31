/**
 * ANOTHER AGENT'S GROUP ROW (senderType room_agent), 0.17.3.
 *
 * HOAI #3703 (2026-10-31): in a group or a channel an agent's @tag of another
 * seated agent wakes it, and the row is handed to the tagged agent marked
 * `senderType: 'room_agent'` with the author's `senderAssistantId`. The
 * backend withholds such rows from a connector that does not read the marker
 * (connector-reads-room-agent.ts), because it would take them as its OWNER
 * speaking. This plugin now reads it:
 *
 *  - the marker reaches the fork on DispatchArgs (senderType,
 *    senderAssistantId), from the live push and the poll alike;
 *  - the text always says another agent wrote it, never a person, even when
 *    the server's own framing line is missing;
 *  - it is never a slash command and never the agent's own row;
 *  - the reply answers the tag with reply_to_id set to its message.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BgosApi } from "../src/bgos-api.js";
import { BgosWs } from "../src/bgos-ws.js";
import { BgosOutbound } from "../src/outbound.js";
import { createAdapter, type ForkDispatchArgs } from "../src/create-adapter.js";
import {
  ROOM_AGENT_PROVENANCE_LINE,
  createInboundHandler,
  type DispatchArgs,
} from "../src/inbound-handler.js";
import type { InboundMessagePayload } from "../src/types.js";
import { MockBgosServer } from "./mocks/mock-bgos-server.js";

function makeApi(baseUrl: string) {
  return new BgosApi({
    baseUrl,
    pairingToken: "pair_" + "x".repeat(30),
    reconnect: { initialDelayMs: 100, maxDelayMs: 1000 },
  });
}

function normalize(baseUrl: string, raw: unknown) {
  const ws = new BgosWs({} as never, makeApi(baseUrl));
  return (ws as unknown as {
    normalizeInbound(r: unknown): InboundMessagePayload | null;
  }).normalizeInbound(raw);
}

function agentRow(
  over: Partial<InboundMessagePayload> = {},
): InboundMessagePayload {
  return {
    assistantId: 1,
    userId: "owner_1",
    chatId: 300,
    messageId: 901,
    text: "@Echo can you check the build?",
    files: [],
    messageType: "standard",
    senderType: "room_agent",
    senderAssistantId: 42,
    ...over,
  };
}

const SERVER_FRAMED =
  "You are in the group Launch.\n" +
  "Ares, an agent seated here and not a person, wrote the message below.\n" +
  "@Echo can you check the build?";

describe("room_agent rows (another agent's group message)", () => {
  let server: MockBgosServer;
  let baseUrl: string;
  let tempHome: string;
  const originalGobotHome = process.env.GOBOT_HOME;

  beforeEach(async () => {
    server = new MockBgosServer();
    baseUrl = await server.start();
    tempHome = mkdtempSync(join(tmpdir(), "gobot-room-agent-test-"));
    process.env.GOBOT_HOME = tempHome;
  });
  afterEach(async () => {
    await server.stop();
    rmSync(tempHome, { recursive: true, force: true });
    if (originalGobotHome === undefined) delete process.env.GOBOT_HOME;
    else process.env.GOBOT_HOME = originalGobotHome;
  });

  function handlerCapturing(seen: DispatchArgs[]) {
    return createInboundHandler({
      outbound: new BgosOutbound(makeApi(baseUrl)),
      getRouteForAssistant: () => "general",
      getDispatch: () => async (args) => {
        seen.push(args);
      },
    });
  }

  it("the normalizer keeps senderType and senderAssistantId (live push, camelCase)", () => {
    const m = normalize(baseUrl, {
      assistantId: 1,
      chatId: 300,
      messageId: 901,
      userId: "owner_1",
      text: "hi",
      senderType: "room_agent",
      senderAssistantId: 42,
    });
    expect(m?.senderType).toBe("room_agent");
    expect(m?.senderAssistantId).toBe(42);
  });

  it("the normalizer keeps them from a poll row (snake_case and camelCase mixed)", () => {
    const m = normalize(baseUrl, {
      assistant_id: 1,
      chat_id: 300,
      message_id: 901,
      user_id: "owner_1",
      text: "hi",
      sender_type: "room_agent",
      sender_assistant_id: "42",
    });
    expect(m?.senderType).toBe("room_agent");
    expect(m?.senderAssistantId).toBe(42);
  });

  it("an ordinary person's row carries no sender marker", () => {
    const m = normalize(baseUrl, {
      assistantId: 1,
      chatId: 300,
      messageId: 901,
      text: "hi",
    });
    expect(m?.senderType).toBeUndefined();
    expect(m?.senderAssistantId).toBeUndefined();
  });

  it("dispatches the marker to the fork", async () => {
    const seen: DispatchArgs[] = [];
    await handlerCapturing(seen)(agentRow({ text: SERVER_FRAMED }));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.senderType).toBe("room_agent");
    expect(seen[0]!.senderAssistantId).toBe(42);
  });

  it("keeps the server's framing as is when it already says an agent wrote it", async () => {
    const seen: DispatchArgs[] = [];
    await handlerCapturing(seen)(agentRow({ text: SERVER_FRAMED }));
    expect(seen[0]!.text).toBe(SERVER_FRAMED);
  });

  it("says another agent wrote it when the server's framing is missing", async () => {
    const seen: DispatchArgs[] = [];
    await handlerCapturing(seen)(agentRow());
    expect(seen[0]!.text.startsWith(ROOM_AGENT_PROVENANCE_LINE(42))).toBe(true);
    expect(seen[0]!.text).toContain("@Echo can you check the build?");
    expect(ROOM_AGENT_PROVENANCE_LINE(42)).toMatch(/not a person/);
    expect(ROOM_AGENT_PROVENANCE_LINE(42)).toMatch(/not your owner's instruction/);
  });

  it("is never a slash command", async () => {
    const seen: DispatchArgs[] = [];
    await handlerCapturing(seen)(
      agentRow({ messageType: "slash_command", commandName: "new", commandArgs: "" }),
    );
    expect(seen[0]!.command).toBeUndefined();
    expect(seen[0]!.messageType).toBe("standard");
  });

  it("never dispatches the agent's own row back to it", async () => {
    const seen: DispatchArgs[] = [];
    await handlerCapturing(seen)(agentRow({ senderAssistantId: 1 }));
    expect(seen).toHaveLength(0);
  });

  it("answers the tag with reply_to_id set to its message", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 12 });
    const handler = createInboundHandler({
      outbound: new BgosOutbound(makeApi(baseUrl)),
      getRouteForAssistant: () => "general",
      getDispatch: () => async (args) => {
        await args.replyHandle.sendText("On it.");
      },
    });
    await handler(agentRow());
    const req = server.requests.at(-1)!;
    expect(req.url.split("?")[0]).toBe("/api/v1/messages");
    expect(req.body).toMatchObject({ chatId: 300, replyToId: 901 });
  });

  it("a person's row is unchanged: no marker, no anchor, text as sent", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 13 });
    const seen: DispatchArgs[] = [];
    const handler = createInboundHandler({
      outbound: new BgosOutbound(makeApi(baseUrl)),
      getRouteForAssistant: () => "general",
      getDispatch: () => async (args) => {
        seen.push(args);
        await args.replyHandle.sendText("Hi.");
      },
    });
    await handler(
      agentRow({ senderType: undefined, senderAssistantId: undefined, text: "hello" }),
    );
    expect(seen[0]!.senderType).toBeUndefined();
    expect(seen[0]!.text).toBe("hello");
    const req = server.requests.at(-1)!;
    expect((req.body as Record<string, unknown>).replyToId).toBeUndefined();
  });

  it("a host loaded through createAdapter gets the marker in meta (review of 3b1e7a2)", async () => {
    const seen: ForkDispatchArgs[] = [];
    const created = createAdapter(
      { baseUrl, pairingToken: "pair_" + "x".repeat(30) },
      { dispatch: async (a) => void seen.push(a) },
    );
    const dispatch = (created.raw as unknown as {
      dispatch: (a: DispatchArgs) => Promise<void>;
    }).dispatch;
    const base = {
      origin: "bgos" as const,
      agentRoute: "general",
      assistantId: 1,
      chatId: 300,
      messageId: 901,
      userId: "owner_1",
      text: "x",
      attachments: [],
      systemPrompt: "",
      replyHandle: {} as DispatchArgs["replyHandle"],
      messageType: "standard" as const,
    };
    await dispatch({ ...base, senderType: "room_agent", senderAssistantId: 42 });
    await dispatch(base);
    expect(seen[0]!.meta).toMatchObject({
      senderType: "room_agent",
      senderAssistantId: 42,
    });
    expect(seen[1]!.meta).not.toHaveProperty("senderType");
    expect(seen[1]!.meta).not.toHaveProperty("senderAssistantId");
  });
});
