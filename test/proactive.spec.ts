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

  it("skips the assistant (never throws) with a clear error when the primary-chat endpoint fails", async () => {
    process.env.GOBOT_HOME_CHANNEL = "bgos";
    process.env.GOBOT_PAIRING_TOKEN = "pair_" + "x".repeat(30);
    server.stage("GET", "/api/v1/integrations/me", 200, {
      pairing_id: 1,
      user_id: "user_x",
      device_label: "Test",
      integration: "gobot",
      assistants: [{ assistant_id: 99, agent_route: "general", name: "Ava" }],
    });
    // primary-chat intentionally NOT staged → mock 404s → endpoint fails.
    const client = new BgosProactiveClient({ baseUrl });
    const r = await client.sendProactive({ text: "no chat" });
    expect(r.attempted).toBe(true);
    expect(r.delivered).toBe(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].assistantId).toBe(99);
    // New self-resolve behaviour: the error must describe the daemon being
    // unable to resolve a chat, NOT tell the operator to set an env var.
    expect(r.errors[0].error).toMatch(/could not resolve/i);
    expect(r.errors[0].error).not.toMatch(/GOBOT_BGOS_CHAT_ID/);
  });

  it("uses the env chat id and does NOT call the primary-chat endpoint when an env override is set", async () => {
    process.env.GOBOT_HOME_CHANNEL = "both";
    process.env.GOBOT_PAIRING_TOKEN = "pair_" + "x".repeat(30);
    process.env.GOBOT_BGOS_CHAT_ID_42 = "777";

    server.stage("GET", "/api/v1/integrations/me", 200, {
      pairing_id: 1,
      user_id: "user_x",
      device_label: "Test",
      integration: "gobot",
      assistants: [{ assistant_id: 42, agent_route: "general", name: "Ava" }],
    });
    server.stage("POST", "/api/v1/messages", 201, { id: 1001 });

    const client = new BgosProactiveClient({ baseUrl });
    const r = await client.sendProactive({ text: "hi" });

    expect(r.delivered).toBe(1);
    expect(r.errors).toEqual([]);
    const posted = server.requests
      .filter((req) => req.url === "/api/v1/messages")
      .map((req) => req.body as Record<string, unknown>);
    expect(posted[0].chatId).toBe(777);
    // env override wins — the daemon must not touch the self-resolve endpoint.
    const primaryChatCalls = server.requests.filter((req) =>
      req.url.includes("/primary-chat"),
    );
    expect(primaryChatCalls).toHaveLength(0);
  });

  it("self-resolves the delivery chat via the primary-chat endpoint when no env override is set", async () => {
    process.env.GOBOT_HOME_CHANNEL = "both";
    process.env.GOBOT_PAIRING_TOKEN = "pair_" + "x".repeat(30);

    server.stage("GET", "/api/v1/integrations/me", 200, {
      pairing_id: 1,
      user_id: "user_x",
      device_label: "Test",
      integration: "gobot",
      assistants: [{ assistant_id: 42, agent_route: "general", name: "Ava" }],
    });
    server.stage(
      "POST",
      "/api/v1/integrations/assistants/42/primary-chat",
      200,
      { chat_id: 777 },
    );
    server.stage("POST", "/api/v1/messages", 201, { id: 1001 });

    const client = new BgosProactiveClient({ baseUrl });
    const r = await client.sendProactive({ text: "self resolve" });

    expect(r.attempted).toBe(true);
    expect(r.delivered).toBe(1);
    expect(r.errors).toEqual([]);

    const primaryChatCalls = server.requests.filter(
      (req) => req.url === "/api/v1/integrations/assistants/42/primary-chat",
    );
    expect(primaryChatCalls).toHaveLength(1);
    expect(primaryChatCalls[0].method).toBe("POST");
    // pairing auth header must ride along, same as every other BgosApi call.
    expect(primaryChatCalls[0].headers["x-bgos-pairing"]).toBe(
      "pair_" + "x".repeat(30),
    );

    const posted = server.requests
      .filter((req) => req.url === "/api/v1/messages")
      .map((req) => req.body as Record<string, unknown>);
    expect(posted[0].chatId).toBe(777);
  });

  it("caches the resolved chat id — a second proactive send does not re-POST to primary-chat", async () => {
    process.env.GOBOT_HOME_CHANNEL = "both";
    process.env.GOBOT_PAIRING_TOKEN = "pair_" + "x".repeat(30);

    server.stage("GET", "/api/v1/integrations/me", 200, {
      pairing_id: 1,
      user_id: "user_x",
      device_label: "Test",
      integration: "gobot",
      assistants: [{ assistant_id: 42, agent_route: "general", name: "Ava" }],
    });
    // primary-chat staged EXACTLY once — a re-POST would hit an unstaged 404.
    server.stage(
      "POST",
      "/api/v1/integrations/assistants/42/primary-chat",
      200,
      { chat_id: 777 },
    );
    server.stage("POST", "/api/v1/messages", 201, { id: 1001 });
    server.stage("POST", "/api/v1/messages", 201, { id: 1002 });

    const client = new BgosProactiveClient({ baseUrl });
    const r1 = await client.sendProactive({ text: "first" });
    const r2 = await client.sendProactive({ text: "second" });

    expect(r1.delivered).toBe(1);
    expect(r2.delivered).toBe(1);
    expect(r2.errors).toEqual([]);

    const primaryChatCalls = server.requests.filter(
      (req) => req.url === "/api/v1/integrations/assistants/42/primary-chat",
    );
    expect(primaryChatCalls).toHaveLength(1);

    const posted = server.requests.filter(
      (req) => req.url === "/api/v1/messages",
    );
    expect(posted).toHaveLength(2);
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
