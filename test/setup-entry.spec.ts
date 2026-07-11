import { describe, expect, it } from "vitest";

import { invokedAsCliEntry, isEntryModule } from "../src/setup/entry.js";

// A fake realpath that resolves a bin-name shim to the real dist file, the way
// a package manager's bin symlink does.
const fakeRealpath = (map: Record<string, string>) => (p: string) =>
  map[p] ?? p;

describe("isEntryModule", () => {
  const moduleUrl = "file:///pkg/dist/setup-cli.js";

  it("matches when argv[1] is the module file itself", () => {
    expect(
      isEntryModule("/pkg/dist/setup-cli.js", moduleUrl, (p) => p),
    ).toBe(true);
  });

  it("matches when argv[1] is a bin-name shim pointing at the module", () => {
    const realpath = fakeRealpath({
      "/usr/.bin/gobot-channel-bgos": "/pkg/dist/setup-cli.js",
      "/pkg/dist/setup-cli.js": "/pkg/dist/setup-cli.js",
    });
    expect(
      isEntryModule("/usr/.bin/gobot-channel-bgos", moduleUrl, realpath),
    ).toBe(true);
  });

  it("does not match an unrelated entry", () => {
    expect(isEntryModule("/other/thing.js", moduleUrl, (p) => p)).toBe(false);
  });

  it("returns false when there is no argv[1]", () => {
    expect(isEntryModule(undefined, moduleUrl, (p) => p)).toBe(false);
  });
});

describe("invokedAsCliEntry", () => {
  it("trusts import.meta.main when the runtime provides it", () => {
    expect(
      invokedAsCliEntry({ url: "file:///pkg/dist/setup-cli.js", main: true }, undefined),
    ).toBe(true);
    expect(
      invokedAsCliEntry(
        { url: "file:///pkg/dist/setup-cli.js", main: false },
        "/pkg/dist/setup-cli.js",
      ),
    ).toBe(false);
  });

  it("falls back to realpath comparison when import.meta.main is absent", () => {
    // No `main` field (older Node): argv[1] is the module -> entry.
    const identity = (p: string) => p;
    expect(
      invokedAsCliEntry(
        { url: "file:///pkg/dist/setup-cli.js" },
        "/pkg/dist/setup-cli.js",
        identity,
      ),
    ).toBe(true);
    expect(
      invokedAsCliEntry(
        { url: "file:///pkg/dist/setup-cli.js" },
        "/pkg/dist/other.js",
        identity,
      ),
    ).toBe(false);
  });
});
