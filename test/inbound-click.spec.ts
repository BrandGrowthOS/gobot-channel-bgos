/**
 * inbound_click routing + approval precedence (contract C6). An approval-
 * consumed click (`ea:*` matching a pending approval) is NOT also forwarded to
 * onButtonClick; everything else is forwarded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BGOSAdapter, type ButtonClickInfo } from "../src/adapter.js";
import { ApprovalHandler } from "../src/approval-handler.js";
import { BgosOutbound } from "../src/outbound.js";
import type { BgosApi } from "../src/bgos-api.js";
import { MockBgosServer } from "./mocks/mock-bgos-server.js";

const TOKEN = "pair_" + "x".repeat(30);

describe("ApprovalHandler ea: prefix", () => {
  function makeHandler() {
    const out = new BgosOutbound({} as BgosApi);
    return new ApprovalHandler(out);
  }

  it("resolves ea:deny -> deny", async () => {
    const h = makeHandler();
    // seed a pending entry directly
    const p = new Promise<string>((resolve) => {
      (h as unknown as { pending: Map<string, unknown> }).pending.set("r1", {
        requestId: "r1",
        resolve,
        reject: () => {},
        timeout: setTimeout(() => {}, 0),
      });
    });
    expect(h.handleCallbackResult({ messageId: 1, optionId: 0, success: true, callbackData: "ea:deny:r1" })).toBe(true);
    expect(await p).toBe("deny");
  });

  it("resolves ea:once / ea:session / ea:always -> approve", async () => {
    for (const decision of ["once", "session", "always", "approve"]) {
      const h = makeHandler();
      const p = new Promise<string>((resolve) => {
        (h as unknown as { pending: Map<string, unknown> }).pending.set("r", {
          requestId: "r",
          resolve,
          reject: () => {},
          timeout: setTimeout(() => {}, 0),
        });
      });
      h.handleCallbackResult({ messageId: 1, optionId: 0, success: true, callbackData: `ea:${decision}:r` });
      expect(await p).toBe("approve");
    }
  });

  it("still accepts the legacy __approval__: prefix", () => {
    const h = makeHandler();
    (h as unknown as { pending: Map<string, unknown> }).pending.set("r", {
      requestId: "r",
      resolve: () => {},
      reject: () => {},
      timeout: setTimeout(() => {}, 0),
    });
    expect(h.handleCallbackResult({ messageId: 1, optionId: 0, success: true, callbackData: "__approval__:approve:r" })).toBe(true);
  });

  it("returns false for a non-approval callbackData", () => {
    const h = makeHandler();
    expect(h.handleCallbackResult({ messageId: 1, optionId: 0, success: true, callbackData: "atask:bgos:5:done" })).toBe(false);
  });
});

describe("BGOSAdapter inbound_click routing", () => {
  let server: MockBgosServer;
  let baseUrl: string;
  let clicks: ButtonClickInfo[];
  let adapter: BGOSAdapter;

  beforeEach(async () => {
    server = new MockBgosServer();
    baseUrl = await server.start();
    clicks = [];
    adapter = new BGOSAdapter({
      baseUrl,
      pairingToken: TOKEN,
      onButtonClick: (info) => void clicks.push(info),
    });
  });
  afterEach(async () => {
    await server.stop();
  });

  it("forwards a non-approval click to onButtonClick", () => {
    (adapter as unknown as {
      routeInboundClick: (c: unknown) => void;
    }).routeInboundClick({
      assistantId: 1,
      chatId: 2,
      messageId: 3,
      userId: "u",
      optionId: 0,
      callbackData: "atask:bgos:9:done",
    });
    expect(clicks).toEqual([
      { assistantId: 1, chatId: 2, callbackData: "atask:bgos:9:done", messageId: 3 },
    ]);
  });

  it("consumes an approval click and does NOT forward it", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 55 });
    const decision = adapter.approvals.requestApproval({
      assistantId: 1,
      chatId: 2,
      text: "run it?",
      meta: { tool: "shell", agent_route: "general", risk: "high", request_id: "req_1" },
    });
    // let the approval_request POST settle
    await new Promise((r) => setTimeout(r, 10));

    (adapter as unknown as {
      routeInboundClick: (c: unknown) => void;
    }).routeInboundClick({
      assistantId: 1,
      chatId: 2,
      messageId: 3,
      userId: "u",
      optionId: 0,
      callbackData: "ea:approve:req_1",
    });

    expect(await decision).toBe("approve");
    expect(clicks).toHaveLength(0); // precedence: not forwarded
  });
});
