import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { resolveHomeChannel } from "../src/home-channel.js";

describe("resolveHomeChannel", () => {
  const originalEnv = process.env.GOBOT_HOME_CHANNEL;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.GOBOT_HOME_CHANNEL;
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
    if (originalEnv === undefined) delete process.env.GOBOT_HOME_CHANNEL;
    else process.env.GOBOT_HOME_CHANNEL = originalEnv;
  });

  it("defaults to 'both' when env is unset", () => {
    expect(resolveHomeChannel()).toBe("both");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("defaults to 'both' when env is empty", () => {
    process.env.GOBOT_HOME_CHANNEL = "";
    expect(resolveHomeChannel()).toBe("both");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("respects the three valid values", () => {
    process.env.GOBOT_HOME_CHANNEL = "telegram";
    expect(resolveHomeChannel()).toBe("telegram");
    process.env.GOBOT_HOME_CHANNEL = "bgos";
    expect(resolveHomeChannel()).toBe("bgos");
    process.env.GOBOT_HOME_CHANNEL = "both";
    expect(resolveHomeChannel()).toBe("both");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("is case-insensitive on valid values", () => {
    process.env.GOBOT_HOME_CHANNEL = "Telegram";
    expect(resolveHomeChannel()).toBe("telegram");
    process.env.GOBOT_HOME_CHANNEL = "BGOS";
    expect(resolveHomeChannel()).toBe("bgos");
  });

  it("warns + falls back to default on an unknown value", () => {
    process.env.GOBOT_HOME_CHANNEL = "slack";
    expect(resolveHomeChannel()).toBe("both");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const arg = warnSpy.mock.calls[0]?.[0];
    expect(typeof arg).toBe("string");
    expect(arg).toContain("slack");
  });
});
