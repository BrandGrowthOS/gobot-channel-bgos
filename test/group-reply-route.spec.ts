/**
 * EVERY REPLY INTO A GROUP OR A CHANNEL GOES THROUGH /send-message.
 *
 * POST /messages refuses an agent turn in a group (room) or a channel and
 * names /send-message. The inbound dispatch already routes its own reply
 * handle there; these are the other ways a Gobot agent writes into a chat it
 * was woken in:
 *
 *  - the reply handle the host gets after a button or question-card tap
 *    (`makeReplyHandle`, contract C6);
 *  - the reply handle of a boards result turn (`getTurnContext`);
 *  - the agent_error card posted when the dispatch throws.
 *
 * A direct chat with the owner keeps POST /messages.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BGOSAdapter } from "../src/adapter.js";
import type { BoardsOrchestratorDeps } from "../src/boards-orchestrator.js";
import type { BgosOutbound } from "../src/outbound.js";
import { createInboundHandler } from "../src/inbound-handler.js";
import type { InboundMessagePayload } from "../src/types.js";
import { MockBgosServer } from "./mocks/mock-bgos-server.js";

const TOKEN = "pair_" + "x".repeat(30);
const ASSISTANT_ID = 1;
const GROUP_CHAT = 300;
const DM_CHAT = 400;

function personRow(
  chatId: number,
  messageId: number,
  chatKind?: string,
): InboundMessagePayload {
  return {
    assistantId: ASSISTANT_ID,
    userId: "owner_1",
    chatId,
    messageId,
    text: "@Mockbot hi",
    files: [],
    messageType: "standard",
    ...(chatKind !== undefined ? { chatKind } : {}),
  };
}

describe("every reply into a group or a channel goes through /send-message", () => {
  let server: MockBgosServer;
  let baseUrl: string;
  let tempHome: string;
  let adapter: BGOSAdapter;
  const originalGobotHome = process.env.GOBOT_HOME;

  beforeEach(async () => {
    server = new MockBgosServer();
    baseUrl = await server.start();
    tempHome = mkdtempSync(join(tmpdir(), "gobot-group-reply-route-"));
    process.env.GOBOT_HOME = tempHome;
    adapter = new BGOSAdapter({ baseUrl, pairingToken: TOKEN });
  });
  afterEach(async () => {
    await server.stop();
    rmSync(tempHome, { recursive: true, force: true });
    if (originalGobotHome === undefined) delete process.env.GOBOT_HOME;
    else process.env.GOBOT_HOME = originalGobotHome;
  });

  /** The adapter's own outbound, as start() hands it to the inbound handler. */
  function adapterOutbound(): BgosOutbound {
    return (adapter as unknown as { outbound: BgosOutbound }).outbound;
  }

  /** Deliver one row through an inbound handler wired like the adapter's. */
  async function receive(
    row: InboundMessagePayload,
    dispatch: () => Promise<void> = async () => {},
  ): Promise<void> {
    const handler = createInboundHandler({
      outbound: adapterOutbound(),
      getRouteForAssistant: () => "general",
      getDispatch: () => dispatch,
    });
    await handler(row);
  }

  function stageBothRoutes(): void {
    server.stage("POST", "/api/v1/send-message", 200, { message: { id: 31 } });
    server.stage("POST", "/api/v1/messages", 201, { id: 32 });
  }

  function lastPostPath(): string | undefined {
    return server.requests
      .filter((r) => r.method === "POST")
      .at(-1)
      ?.url.split("?")[0];
  }

  it.each(["room", "channel"])(
    "the reply handle after a tap posts through /send-message in a %s",
    async (chatKind) => {
      await receive(personRow(GROUP_CHAT, 901, chatKind));
      stageBothRoutes();
      await adapter.makeReplyHandle(ASSISTANT_ID, GROUP_CHAT).sendText("Picked A.");
      expect(lastPostPath()).toBe("/api/v1/send-message");
    },
  );

  it("the tool progress card after a tap posts through /send-message in a group", async () => {
    await receive(personRow(GROUP_CHAT, 902, "room"));
    stageBothRoutes();
    server.stage("PATCH", "/api/v1/messages/31", 200, { id: 31 });
    await adapter.makeReplyHandle(ASSISTANT_ID, GROUP_CHAT).sendToolStart("Bash", "ls");
    expect(lastPostPath()).toBe("/api/v1/send-message");
  });

  it("the boards result turn's reply handle posts through /send-message in a group", async () => {
    adapter.setDispatch(async () => {});
    (adapter as unknown as {
      assistantToRoute: Map<number, string>;
    }).assistantToRoute.set(ASSISTANT_ID, "general");
    await receive(personRow(GROUP_CHAT, 903, "channel"));
    const deps = (adapter.boards as unknown as { deps: BoardsOrchestratorDeps }).deps;
    const ctx = deps.getTurnContext(ASSISTANT_ID, GROUP_CHAT);
    expect(ctx).not.toBeNull();
    stageBothRoutes();
    await ctx!.replyHandle.sendText("Board updated.");
    expect(lastPostPath()).toBe("/api/v1/send-message");
  });

  it("the agent_error card of a dispatch that throws posts through /send-message in a group", async () => {
    stageBothRoutes();
    await receive(personRow(GROUP_CHAT, 904, "room"), async () => {
      throw new Error("boom");
    });
    const post = server.requests.filter((r) => r.method === "POST").at(-1);
    expect(post?.url.split("?")[0]).toBe("/api/v1/send-message");
    expect(post?.body).toMatchObject({ messageType: "agent_error" });
  });

  it("after a restart (no row seen yet) a reply refused by /messages for a group is sent once through /send-message and the chat is remembered", async () => {
    // Nothing has arrived since the daemon started, so the outbound does not
    // know the chat is a group: the server's refusal tells it.
    server.stage("POST", "/api/v1/messages", 400, {
      statusCode: 400,
      message: "Agent messages into a group must use /send-message",
    });
    server.stage("POST", "/api/v1/send-message", 200, { message: { id: 41 } });
    server.stage("POST", "/api/v1/send-message", 200, { message: { id: 42 } });
    const handle = adapter.makeReplyHandle(ASSISTANT_ID, GROUP_CHAT);
    await handle.sendText("Picked A.");
    await handle.sendText("Done.");
    expect(
      server.requests.filter((r) => r.method === "POST").map((r) => r.url.split("?")[0]),
    ).toEqual(["/api/v1/messages", "/api/v1/send-message", "/api/v1/send-message"]);
  });

  it("another refusal from /messages is not resent through /send-message", async () => {
    server.stage("POST", "/api/v1/messages", 400, {
      statusCode: 400,
      message: "text must be shorter than or equal to 32000 characters",
    });
    await expect(
      adapter.makeReplyHandle(ASSISTANT_ID, DM_CHAT).sendText("x"),
    ).rejects.toBeTruthy();
    expect(
      server.requests.filter((r) => r.method === "POST").map((r) => r.url.split("?")[0]),
    ).toEqual(["/api/v1/messages"]);
  });

  it("a direct chat with the owner keeps POST /messages", async () => {
    await receive(personRow(DM_CHAT, 905));
    stageBothRoutes();
    await adapter.makeReplyHandle(ASSISTANT_ID, DM_CHAT).sendText("Hi.");
    expect(lastPostPath()).toBe("/api/v1/messages");
  });
});
