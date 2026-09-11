import { expect, it, vi } from "vitest";
import { BgosApi } from "../src/bgos-api.js";
import { BgosOutbound } from "../src/outbound.js";
import { buildReplyHandle } from "../src/inbound-handler.js";
import { callContextFields } from "../src/call-context.js";
import { MockBgosServer } from "./mocks/mock-bgos-server.js";

it("sends the brief through the real outbound adapter and API, preserving setup guidance and legacy requests", async () => {
  const server = new MockBgosServer();
  const baseUrl = await server.start();
  const outbound = new BgosOutbound(new BgosApi({
    baseUrl, pairingToken: "pair_test", reconnect: { initialDelayMs: 100, maxDelayMs: 1000 },
  }));
  const brief = { context: 'Path C:\\Work\\notes.md\n"Ready" 🙂', openingMessage: "Ready." };
  try {
    server.stage("POST", "/api/v1/voice/outbound-call", 201, { callId: "c1", expiresAt: "2026-09-11T10:00:00Z" });
    const handle = buildReplyHandle({ outbound } as any, { assistantId: 7, chatId: 12 });
    expect(await handle.callOwner!("Build ready.", brief)).toMatchObject({ status: "ringing", callId: "c1" });
    expect(server.requests.at(-1)!.body).toEqual({ assistantId: 7, chatId: 12, reason: "Build ready.", ...brief });

    server.stage("POST", "/api/v1/voice/outbound-call", 201, { callId: "c2" });
    await handle.callOwner!("Standup");
    expect(server.requests.at(-1)!.body).toEqual({ assistantId: 7, chatId: 12, reason: "Standup" });

    server.stage("POST", "/api/v1/voice/outbound-call", 400, { code: "voice_not_configured", guidance: "Choose a voice in settings." });
    expect(await handle.callOwner!()).toMatchObject({ status: "needs_setup", guidance: "Choose a voice in settings." });

    const requestsBefore = server.requests.length;
    await expect(handle.callOwner!("Ready", { context: "x".repeat(4001) })).rejects.toThrow(/4000/);
    expect(server.requests).toHaveLength(requestsBefore);
  } finally {
    await server.stop();
  }
});
it("forwards optional context through the per-chat reply handle without permitting an identity override", async () => {
  const triggerOutboundCall = vi.fn(async () => ({
    status: "ringing",
    callId: "c1",
  }));
  const outbound = { callOwner: vi.fn(async (p) => triggerOutboundCall(p)) };
  const handle = buildReplyHandle({ outbound } as any, {
    assistantId: 7,
    chatId: 12,
  });
  await handle.callOwner!("Build ready.", {
    context: "Path C:\\Work\\notes.md\n🙂",
    openingMessage: "Ready.",
    assistantId: 999,
  } as any);
  expect(triggerOutboundCall).toHaveBeenCalledWith({
    assistantId: 7,
    chatId: 12,
    reason: "Build ready.",
    context: "Path C:\\Work\\notes.md\n🙂",
    openingMessage: "Ready.",
  });
});
it("validates optional fields and preserves the legacy empty payload", () => {
  expect(callContextFields({})).toEqual({});
  expect(() => callContextFields({ context: "x".repeat(4001) })).toThrow(
    /4000/,
  );
  expect(() => callContextFields({ openingMessage: 42 } as any)).toThrow(/400/);
});
