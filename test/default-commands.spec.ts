import { describe, it, expect } from "vitest";

import {
  DEFAULT_COMMANDS,
  shouldSeedDefaults,
} from "../src/default-commands.js";

const NAME_PATTERN = /^[a-z0-9_]{1,32}$/;
const DESCRIPTION_MAX = 100;

describe("default-commands", () => {
  it("ships exactly seven commands", () => {
    expect(DEFAULT_COMMANDS).toHaveLength(7);
  });

  it("every command name matches ^[a-z0-9_]{1,32}$", () => {
    for (const c of DEFAULT_COMMANDS) {
      expect(c.command).toMatch(NAME_PATTERN);
    }
  });

  it("every description is ≤100 chars and non-empty", () => {
    for (const c of DEFAULT_COMMANDS) {
      expect(c.description.length).toBeGreaterThan(0);
      expect(c.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    }
  });

  it("includes the canonical seven Gobot commands in the documented order", () => {
    const names = DEFAULT_COMMANDS.map((c) => c.command);
    expect(names).toEqual([
      "remember",
      "track",
      "done",
      "forget",
      "cancel",
      "critic",
      "board",
    ]);
  });

  it("preserves the picker order via order_index", () => {
    DEFAULT_COMMANDS.forEach((c, i) => {
      expect(c.order_index).toBe(i);
    });
  });

  describe("shouldSeedDefaults", () => {
    it("returns true only when count is exactly 0", () => {
      expect(shouldSeedDefaults(0)).toBe(true);
    });
    it("returns false for any positive count", () => {
      expect(shouldSeedDefaults(1)).toBe(false);
      expect(shouldSeedDefaults(7)).toBe(false);
      expect(shouldSeedDefaults(100)).toBe(false);
    });
    it("returns false when count is undefined (older backend, can't tell — play safe)", () => {
      expect(shouldSeedDefaults(undefined)).toBe(false);
    });
  });
});
