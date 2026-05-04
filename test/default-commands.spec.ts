import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  DEFAULT_COMMANDS,
  resolveCommandSeedMode,
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
    it("returns true only when count is exactly 0 (default mode=auto)", () => {
      expect(shouldSeedDefaults(0)).toBe(true);
    });
    it("returns false for any positive count", () => {
      expect(shouldSeedDefaults(1)).toBe(false);
      expect(shouldSeedDefaults(7)).toBe(false);
      expect(shouldSeedDefaults(100)).toBe(false);
    });
    it("returns false when count is undefined and mode=auto (older backend, conservative)", () => {
      expect(shouldSeedDefaults(undefined)).toBe(false);
      expect(shouldSeedDefaults(undefined, "auto")).toBe(false);
    });
    it("mode=safe also seeds when count is undefined (covers older deploys)", () => {
      expect(shouldSeedDefaults(undefined, "safe")).toBe(true);
      expect(shouldSeedDefaults(0, "safe")).toBe(true);
      expect(shouldSeedDefaults(3, "safe")).toBe(false);
    });
    it("mode=always seeds regardless of count (used by force-reseed flows)", () => {
      expect(shouldSeedDefaults(undefined, "always")).toBe(true);
      expect(shouldSeedDefaults(0, "always")).toBe(true);
      expect(shouldSeedDefaults(7, "always")).toBe(true);
    });
    it("mode=never never seeds", () => {
      expect(shouldSeedDefaults(undefined, "never")).toBe(false);
      expect(shouldSeedDefaults(0, "never")).toBe(false);
      expect(shouldSeedDefaults(7, "never")).toBe(false);
    });
  });

  describe("resolveCommandSeedMode", () => {
    const original = process.env.GOBOT_BGOS_RESEED_COMMANDS;
    beforeEach(() => {
      delete process.env.GOBOT_BGOS_RESEED_COMMANDS;
    });
    afterEach(() => {
      if (original === undefined) {
        delete process.env.GOBOT_BGOS_RESEED_COMMANDS;
      } else {
        process.env.GOBOT_BGOS_RESEED_COMMANDS = original;
      }
    });
    it("defaults to auto when unset", () => {
      expect(resolveCommandSeedMode()).toBe("auto");
    });
    it("accepts the four valid modes (case-insensitive)", () => {
      process.env.GOBOT_BGOS_RESEED_COMMANDS = "SAFE";
      expect(resolveCommandSeedMode()).toBe("safe");
      process.env.GOBOT_BGOS_RESEED_COMMANDS = "always";
      expect(resolveCommandSeedMode()).toBe("always");
      process.env.GOBOT_BGOS_RESEED_COMMANDS = "Never";
      expect(resolveCommandSeedMode()).toBe("never");
    });
    it("falls back to auto on invalid values (logged warning)", () => {
      process.env.GOBOT_BGOS_RESEED_COMMANDS = "yolo";
      expect(resolveCommandSeedMode()).toBe("auto");
    });
  });
});
