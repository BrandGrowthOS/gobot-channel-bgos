import { describe, it, expect } from "vitest";

import {
  BGOS_AGENT_HINTS,
  buildSystemPromptWithHints,
} from "../src/agent-hints.js";

describe("agent-hints", () => {
  it("BGOS_AGENT_HINTS is a non-trivial string with the expected structure", () => {
    expect(typeof BGOS_AGENT_HINTS).toBe("string");
    // Roughly the documented size — a handful of paragraphs.
    expect(BGOS_AGENT_HINTS.length).toBeGreaterThan(800);
    // Covers each documented capability
    expect(BGOS_AGENT_HINTS).toContain("Markdown");
    expect(BGOS_AGENT_HINTS).toContain("attachments");
    expect(BGOS_AGENT_HINTS).toContain("MEDIA:");
    expect(BGOS_AGENT_HINTS).toContain("ea:");
    expect(BGOS_AGENT_HINTS).toContain("ask_user_input");
    expect(BGOS_AGENT_HINTS).toContain("Slash commands");
  });

  it("starts with a separator the agent can find before injection", () => {
    expect(BGOS_AGENT_HINTS).toContain(
      "BGOS Channel — Agent Capabilities",
    );
  });

  it("buildSystemPromptWithHints appends the hints once", () => {
    const result = buildSystemPromptWithHints("You are Ramy, a Gobot agent.");
    expect(result.startsWith("You are Ramy, a Gobot agent.")).toBe(true);
    expect(result).toContain("BGOS Channel — Agent Capabilities");
    expect(result).toContain("MEDIA:");
  });

  it("is idempotent — applying it twice produces no duplication", () => {
    const once = buildSystemPromptWithHints("Hello world.");
    const twice = buildSystemPromptWithHints(once);
    expect(twice).toBe(once);
    // Sanity: the heading appears exactly once
    const occurrences = (
      twice.match(/BGOS Channel — Agent Capabilities/g) ?? []
    ).length;
    expect(occurrences).toBe(1);
  });

  it("handles undefined / empty input gracefully", () => {
    // @ts-expect-error — exercising the runtime fallback for non-string input.
    expect(buildSystemPromptWithHints(undefined)).toContain(
      "BGOS Channel — Agent Capabilities",
    );
    expect(buildSystemPromptWithHints("")).toContain(
      "BGOS Channel — Agent Capabilities",
    );
  });
});
