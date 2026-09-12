import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import { forkAcceptsPluginVersion } from "../src/update-telemetry.js";

describe("manual update host compatibility", () => {
  it.each([
    ["^0.17.0", "0.17.1", true],
    ["^0.17.0", "0.18.0", false],
    ["0.17.0", "0.17.1", false],
    ["*", "0.17.1", false],
  ])("checks %s against %s", (spec, candidate, allowed) => {
    const root = mkdtempSync(join(tmpdir(), "bgos-host-range-"));
    try {
      writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { "gobot-channel-bgos": spec } }));
      expect(forkAcceptsPluginVersion(root, candidate)).toBe(allowed);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
