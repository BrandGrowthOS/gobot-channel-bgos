import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BgosProactiveClient } from "../src/proactive.js";
import { MockBgosServer } from "./mocks/mock-bgos-server.js";

const ENV_KEYS = [
  "GOBOT_HOME_CHANNEL",
  "GOBOT_PAIRING_TOKEN",
  "GOBOT_BGOS_CHAT_ID",
  "GOBOT_BGOS_CHAT_ID_42",
  "GOBOT_BGOS_CHAT_ID_43",
  "GOBOT_BASE_URL",
] as const;

describe("BgosProactiveClient", () => {
  let server: MockBgosServer;
  let baseUrl: string;
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> =
    {};

  beforeEach(async () => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    server = new MockBgosServer();
    baseUrl = await server.start();
  });

  afterEach(async () => {
    await server.stop();
    for (const k of ENV_KEYS) {
      const v = saved[k];
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  });

  it("returns attempted=false when GOBOT_HOME_CHANNEL=telegram", async () => {
    process.env.GOBOT_HOME_CHANNEL = "telegram";
    process.env.GOBOT_PAIRING_TOKEN = "pair_" + "x".repeat(30);
    const client = new BgosProactiveClient({ baseUrl });
    const r = await client.sendProactive({ text: "hi" });
    expect(r).toEqual({
      attempted: false,
      delivered: 0,
      errors: [],
      channel: "telegram",
    });
    expect(server.requests).toHaveLength(0);
  });

  it("posts to BGOS for every assistant when channel=both and chat id is set", async () => {
    process.env.GOBOT_HOME_CHANNEL = "both";
    process.env.GOBOT_PAIRING_TOKEN = "pair_" + "x".repeat(30);
    process.env.GOBOT_BGOS_CHAT_ID_42 = "777";
    process.env.GOBOT_BGOS_CHAT_ID_43 = "888";

    server.stage("GET", "/api/v1/integrations/me", 200, {
      pairing_id: 1,
      user_id: "user_x",
      device_label: "Test",
      integration: "gobot",
      assistants: [
        { assistant_id: 42, agent_route: "general", name: "Ava" },
        { assistant_id: 43, agent_route: "research", name: "Research" },
      ],
    });
    server.stage("POST", "/api/v1/messages", 201, { id: 1001 });
    server.stage("POST", "/api/v1/messages", 201, { id: 1002 });

    const client = new BgosProactiveClient({ baseUrl });
    const r = await client.sendProactive({ text: "morning briefing" });
    expect(r.attempted).toBe(true);
    expect(r.delivered).toBe(2);
    expect(r.errors).toEqual([]);
    expect(r.channel).toBe("both");

    const messageBodies = server.requests
      .filter((req) => req.url === "/api/v1/messages")
      .map((req) => req.body as Record<string, unknown>);
    expect(messageBodies).toHaveLength(2);
    const targets = messageBodies.map((b) => ({
      assistantId: b.assistantId,
      chatId: b.chatId,
    }));
    expect(targets).toContainEqual({ assistantId: 42, chatId: 777 });
    expect(targets).toContainEqual({ assistantId: 43, chatId: 888 });
  });

  it("respects assistantIds filter", async () => {
    process.env.GOBOT_HOME_CHANNEL = "bgos";
    process.env.GOBOT_PAIRING_TOKEN = "pair_" + "x".repeat(30);
    process.env.GOBOT_BGOS_CHAT_ID = "555"; // generic fallback for both
    server.stage("GET", "/api/v1/integrations/me", 200, {
      pairing_id: 1,
      user_id: "user_x",
      device_label: "Test",
      integration: "gobot",
      assistants: [
        { assistant_id: 10, agent_route: "general", name: "Ava" },
        { assistant_id: 11, agent_route: "research", name: "Research" },
      ],
    });
    server.stage("POST", "/api/v1/messages", 201, { id: 1 });

    const client = new BgosProactiveClient({ baseUrl });
    const r = await client.sendProactive({
      text: "only research",
      assistantIds: [11],
    });
    expect(r.delivered).toBe(1);
    const posted = server.requests
      .filter((req) => req.url === "/api/v1/messages")
      .map((req) => req.body as Record<string, unknown>);
    expect(posted).toHaveLength(1);
    expect(posted[0].assistantId).toBe(11);
  });

  it("returns errors[] (never throws) when no chat id is configured for an assistant", async () => {
    process.env.GOBOT_HOME_CHANNEL = "bgos";
    process.env.GOBOT_PAIRING_TOKEN = "pair_" + "x".repeat(30);
    server.stage("GET", "/api/v1/integrations/me", 200, {
      pairing_id: 1,
      user_id: "user_x",
      device_label: "Test",
      integration: "gobot",
      assistants: [{ assistant_id: 99, agent_route: "general", name: "Ava" }],
    });
    const client = new BgosProactiveClient({ baseUrl });
    const r = await client.sendProactive({ text: "no chat" });
    expect(r.attempted).toBe(true);
    expect(r.delivered).toBe(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].assistantId).toBe(99);
    expect(r.errors[0].error).toMatch(/GOBOT_BGOS_CHAT_ID/);
  });

  it("returns config error (never throws) when no pairing token is set", async () => {
    process.env.GOBOT_HOME_CHANNEL = "both";
    const client = new BgosProactiveClient({ baseUrl });
    const r = await client.sendProactive({ text: "no token" });
    expect(r.attempted).toBe(true);
    expect(r.delivered).toBe(0);
    expect(r.errors[0].error).toMatch(/GOBOT_PAIRING_TOKEN/);
  });
});
