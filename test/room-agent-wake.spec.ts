/**
 * Another agent's message in a group or a channel wakes this agent, and the
 * agent's own message never does.
 *
 * The rows are shaped like the ones the BGOS backend sends, and each one goes
 * the whole way a real row goes: the socket's (or the poll's) normalizer,
 * then the inbound handler, then the dispatch to the agent.
 *
 *  - the live push (`inbound_message`): camelCase, `senderType: 'room_agent'`
 *    with the author's `senderAssistantId`, no human sender block, `userId`
 *    set to the RECEIVING agent's owner, and `groupContext.chatKind`;
 *  - the inbound poll (`GET /integrations/inbound`): snake_case keys with the
 *    same camelCase `senderType` and `senderAssistantId`, plus `chat_kind`.
 *
 * Each case runs on both lanes and in both a group (`room`) and a channel.
 * The own row case is the reply loop guard.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BgosApi } from "../src/bgos-api.js";
import { BgosWs } from "../src/bgos-ws.js";
import { BgosOutbound } from "../src/outbound.js";
import {
  createInboundHandler,
  type DispatchArgs,
} from "../src/inbound-handler.js";
import type { InboundMessagePayload } from "../src/types.js";
import { MockBgosServer } from "./mocks/mock-bgos-server.js";

const OWN_ASSISTANT_ID = 1;
const OTHER_ASSISTANT_ID = 42;
const CHAT_ID = 300;

const SERVER_FRAMED =
  "You are in the group Launch.\n" +
  "Ares, an agent seated here and not a person, wrote the message below.\n" +
  "@Echo can you check the build?";
const UNFRAMED = "@Echo can you check the build?";

type Lane = "push" | "poll";
type ChatKind = "room" | "channel";
const LANES: Lane[] = ["push", "poll"];
const CHAT_KINDS: ChatKind[] = ["room", "channel"];
const CASES = LANES.flatMap((lane) =>
  CHAT_KINDS.map((chatKind) => ({ lane, chatKind })),
);

function makeApi(baseUrl: string) {
  return new BgosApi({
    baseUrl,
    pairingToken: "pair_" + "x".repeat(30),
    reconnect: { initialDelayMs: 100, maxDelayMs: 1000 },
  });
}

function pushFrame(chatKind: ChatKind, extra: Record<string, unknown>) {
  return {
    assistantId: OWN_ASSISTANT_ID,
    userId: "owner_1",
    chatId: CHAT_ID,
    messageId: 901,
    text: SERVER_FRAMED,
    files: [],
    messageType: "standard",
    groupContext: { chatKind, chatTitle: "Launch" },
    ...extra,
  };
}

function pollRow(chatKind: ChatKind, extra: Record<string, unknown>) {
  return {
    id: 901,
    message_id: 901,
    chat_id: CHAT_ID,
    text: SERVER_FRAMED,
    files: [],
    chat_kind: chatKind,
    groupContext: { chatKind, chatTitle: "Launch" },
    message_type: "standard",
    command_name: null,
    command_args: null,
    created_at: "2026-11-09T08:00:00.000Z",
    assistant_id: OWN_ASSISTANT_ID,
    agent_route: "general",
    user_id: "owner_1",
    ...extra,
  };
}

function roomAgent(author: number | undefined): Record<string, unknown> {
  return author === undefined
    ? { senderType: "room_agent" }
    : { senderType: "room_agent", senderAssistantId: author };
}

describe("another agent's message in a group or channel wakes the agent", () => {
  let server: MockBgosServer;
  let baseUrl: string;
  let tempHome: string;
  const originalGobotHome = process.env.GOBOT_HOME;

  beforeEach(async () => {
    server = new MockBgosServer();
    baseUrl = await server.start();
    tempHome = mkdtempSync(join(tmpdir(), "gobot-room-agent-wake-"));
    process.env.GOBOT_HOME = tempHome;
  });
  afterEach(async () => {
    await server.stop();
    rmSync(tempHome, { recursive: true, force: true });
    if (originalGobotHome === undefined) delete process.env.GOBOT_HOME;
    else process.env.GOBOT_HOME = originalGobotHome;
  });

  /** Hand one row to the agent on the given lane, the way BGOS would. */
  async function deliver(
    lane: Lane,
    chatKind: ChatKind,
    extra: Record<string, unknown>,
  ): Promise<DispatchArgs[]> {
    const ws = new BgosWs({} as never, makeApi(baseUrl));
    const raw = lane === "push" ? pushFrame(chatKind, extra) : pollRow(chatKind, extra);
    const normalized = (ws as unknown as {
      normalizeInbound(r: unknown): InboundMessagePayload | null;
    }).normalizeInbound(raw);
    expect(normalized).not.toBeNull();
    const seen: DispatchArgs[] = [];
    const handler = createInboundHandler({
      outbound: new BgosOutbound(makeApi(baseUrl)),
      getRouteForAssistant: () => "general",
      getDispatch: () => async (args) => {
        seen.push(args);
      },
    });
    await handler(normalized!);
    return seen;
  }

  for (const { lane, chatKind } of CASES) {
    for (const [framing, text] of [
      ["framed", SERVER_FRAMED],
      ["unframed", UNFRAMED],
    ] as const) {
      it(`${lane}, ${chatKind}, ${framing}: another agent's message wakes the agent as another agent`, async () => {
        const seen = await deliver(lane, chatKind, {
          text,
          ...roomAgent(OTHER_ASSISTANT_ID),
        });
        expect(seen).toHaveLength(1);
        // The agent is told who wrote it: another agent, never its owner.
        expect(seen[0]!.senderType).toBe("room_agent");
        expect(seen[0]!.senderAssistantId).toBe(OTHER_ASSISTANT_ID);
        expect(seen[0]!.text).toMatch(/not a person/);
      });
    }

    it(`${lane}, ${chatKind}: the agent's own message does not wake it`, async () => {
      const seen = await deliver(lane, chatKind, roomAgent(OWN_ASSISTANT_ID));
      expect(seen).toHaveLength(0);
    });

    it(`${lane}, ${chatKind}: another agent's message with no author does not wake it`, async () => {
      // The marker without a readable author cannot be told apart from the
      // agent's own message, so it is not delivered (the Claude Code
      // plugin's rule, isOwnRoomAgentMessage). Waking on it could loop.
      const seen = await deliver(lane, chatKind, roomAgent(undefined));
      expect(seen).toHaveLength(0);
    });

    for (const [label, text] of [
      ["empty", ""],
      ["null", null],
    ] as const) {
      it(`${lane}, ${chatKind}: another agent's ${label} message does not wake it`, async () => {
        // The poll can hand over an agent's row before its first edit.
        // Nothing to read: the framing line alone must not wake the agent.
        const seen = await deliver(lane, chatKind, {
          text,
          ...roomAgent(OTHER_ASSISTANT_ID),
        });
        expect(seen).toHaveLength(0);
      });
    }

    it(`${lane}, ${chatKind}: a person's message wakes the agent unmarked`, async () => {
      const seen = await deliver(lane, chatKind, { text: "@Echo hi" });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.senderType).toBeUndefined();
      expect(seen[0]!.text).toBe("@Echo hi");
    });
  }
});
