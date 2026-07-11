/**
 * Capability bootstrap: the pure validate/choose/append logic + the BgosApi GET.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BgosApi } from "../src/bgos-api.js";
import { BGOS_AGENT_HINTS } from "../src/agent-hints.js";
import {
  BUNDLED_AGENT_HINTS,
  MAX_CANON_BYTES,
  appendAgentHints,
  hasCanonMarkers,
  pickAgentHints,
  type ServedCapabilities,
} from "../src/capabilities.js";
import { MockBgosServer } from "./mocks/mock-bgos-server.js";

const SERVED_TEXT =
  "# BGOS Channel Agent Capabilities\n(channel: gobot, canon v2026.07.11)\n\nbody...";

function served(text: string, version = "2026.07.11"): ServedCapabilities {
  return { channel: "gobot", version, text, core: "", channelSyntax: "" };
}

describe("hasCanonMarkers", () => {
  it("accepts the served canon heading (dash-free)", () => {
    expect(hasCanonMarkers(SERVED_TEXT)).toBe(true);
  });

  it("accepts the bundled fallback (em-dash heading)", () => {
    expect(hasCanonMarkers(BGOS_AGENT_HINTS)).toBe(true);
  });

  it("rejects empty / partial / unrelated / non-string", () => {
    expect(hasCanonMarkers("")).toBe(false);
    expect(hasCanonMarkers("   ")).toBe(false);
    expect(hasCanonMarkers("BGOS Channel but nothing else")).toBe(false);
    expect(hasCanonMarkers("random text")).toBe(false);
    expect(hasCanonMarkers(null)).toBe(false);
    expect(hasCanonMarkers(undefined)).toBe(false);
  });
});

describe("pickAgentHints", () => {
  it("wraps the served text with a dash-free separator and marks source backend", () => {
    const picked = pickAgentHints(served(SERVED_TEXT));
    expect(picked.source).toBe("backend");
    expect(picked.hints).toContain(SERVED_TEXT.trim());
    expect(picked.hints.startsWith("\n\n---\n")).toBe(true);
    // The served injectable must never carry an em/en dash.
    expect(picked.hints.includes("—")).toBe(false);
    expect(picked.hints.includes("–")).toBe(false);
  });

  it("falls back to the bundled hints on null / undefined / malformed", () => {
    expect(pickAgentHints(null).source).toBe("bundled");
    expect(pickAgentHints(null).hints).toBe(BUNDLED_AGENT_HINTS);
    expect(pickAgentHints(undefined).source).toBe("bundled");
    expect(pickAgentHints(served("")).source).toBe("bundled");
    expect(pickAgentHints(served("no markers here")).source).toBe("bundled");
  });

  it("falls back to bundled when the served canon exceeds the size cap (DoS/injection guard)", () => {
    const marker = "# BGOS Channel Agent Capabilities\n";
    const oversized = marker + "x".repeat(MAX_CANON_BYTES + 1);
    const picked = pickAgentHints(served(oversized));
    expect(picked.source).toBe("bundled");
    expect(picked.hints).toBe(BUNDLED_AGENT_HINTS);
    // A canon right at the cap with valid markers is still accepted.
    const atCap = marker + "y".repeat(MAX_CANON_BYTES - marker.length);
    expect(pickAgentHints(served(atCap)).source).toBe("backend");
  });
});

describe("appendAgentHints (idempotent, both dash forms)", () => {
  it("appends the hints to a base prompt", () => {
    const out = appendAgentHints("You are Ava.", BGOS_AGENT_HINTS);
    expect(out.startsWith("You are Ava.")).toBe(true);
    expect(out).toContain("BGOS Channel");
    expect(out).toContain("Agent Capabilities");
  });

  it("does not double-inject when the bundled (em-dash) hints are already present", () => {
    const once = appendAgentHints("base", BGOS_AGENT_HINTS);
    const twice = appendAgentHints(once, BGOS_AGENT_HINTS);
    expect(twice).toBe(once);
  });

  it("does not double-inject when the served (dash-free) canon is already present", () => {
    const served1 = pickAgentHints(served(SERVED_TEXT)).hints;
    const once = appendAgentHints("base", served1);
    // A later dispatch that would try to append the bundled copy must no-op,
    // because the guard matches the dash-free markers the served text carries.
    const twice = appendAgentHints(once, BGOS_AGENT_HINTS);
    expect(twice).toBe(once);
  });

  it("tolerates an empty base", () => {
    expect(appendAgentHints("", BGOS_AGENT_HINTS)).toBe(BGOS_AGENT_HINTS);
  });
});

describe("BgosApi.getCapabilities", () => {
  let server: MockBgosServer;
  let baseUrl: string;

  beforeEach(async () => {
    server = new MockBgosServer();
    baseUrl = await server.start();
  });
  afterEach(async () => {
    await server.stop();
  });

  function makeApi(url: string) {
    return new BgosApi({
      baseUrl: url,
      pairingToken: "pair_" + "x".repeat(30),
      reconnect: { initialDelayMs: 100, maxDelayMs: 1000 },
    });
  }

  it("GETs /integrations/capabilities with the gobot channel param and returns the payload", async () => {
    const payload = {
      channel: "gobot",
      version: "2026.07.11",
      text: SERVED_TEXT,
      core: "core",
      channelSyntax: "gobot delta",
    };
    server.stage("GET", "/api/v1/integrations/capabilities", 200, payload);

    const out = await makeApi(baseUrl).getCapabilities("gobot");
    expect(out).toMatchObject(payload);

    const req = server.requests.at(-1)!;
    expect(req.method).toBe("GET");
    expect(req.url).toContain("/api/v1/integrations/capabilities");
    expect(req.url).toContain("channel=gobot");
    expect(req.headers["x-bgos-pairing"]).toBeTruthy();
  });

  it("defaults the channel to gobot", async () => {
    server.stage("GET", "/api/v1/integrations/capabilities", 200, {
      channel: "gobot",
      version: "v",
      text: SERVED_TEXT,
      core: "",
      channelSyntax: "",
    });
    await makeApi(baseUrl).getCapabilities();
    expect(server.requests.at(-1)!.url).toContain("channel=gobot");
  });

  it("rejects when the endpoint 404s (old backend) so the caller keeps the fallback", async () => {
    await expect(makeApi(baseUrl).getCapabilities("gobot")).rejects.toBeTruthy();
  });
});
