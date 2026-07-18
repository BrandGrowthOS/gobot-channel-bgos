import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_UPSTREAM_BRANCH,
  DEFAULT_UPSTREAM_REPO,
} from "../src/setup/args.js";
import {
  BGOS_HOOK_RELATIVE_PATH,
  buildCloneArgs,
  decidePatchAfterAcquire,
} from "../src/setup/source.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gobot-source-test-"));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("recommended setup source", () => {
  it("defaults to the BGOS fork", () => {
    expect(DEFAULT_UPSTREAM_REPO).toBe(
      "https://github.com/BrandGrowthOS/gobot-bgos-fork.git",
    );
    expect(DEFAULT_UPSTREAM_BRANCH).toBe("bgos-integration");
    expect(buildCloneArgs(DEFAULT_UPSTREAM_REPO, "/srv/gobot")).toEqual([
      "clone",
      "--branch",
      "bgos-integration",
      "--single-branch",
      DEFAULT_UPSTREAM_REPO,
      "/srv/gobot",
    ]);
  });

  it("keeps a fresh fork clone on its upstream commit when the hook exists", () => {
    const root = tempDir();
    const upstream = join(root, "upstream");
    const clone = join(root, "clone");
    const hook = join(upstream, BGOS_HOOK_RELATIVE_PATH);
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, "export const installed = true;\n");
    writeFileSync(
      join(upstream, "package.json"),
      JSON.stringify({ name: "gobot", version: "2.11.0" }),
    );
    git(root, "init", "-b", "main", upstream);
    git(upstream, "config", "user.name", "Setup Test");
    git(upstream, "config", "user.email", "setup@example.invalid");
    git(upstream, "add", ".");
    git(upstream, "commit", "-m", "seed fork hook");
    git(root, "clone", upstream, clone);

    expect(decidePatchAfterAcquire(clone)).toBe("skip");
    expect(git(clone, "rev-parse", "HEAD")).toBe(
      git(clone, "rev-parse", "@{upstream}"),
    );
    expect(git(clone, "rev-list", "--count", "HEAD")).toBe("1");
  });

  it("keeps the patch path for a custom checkout without the hook", () => {
    const checkout = tempDir();
    writeFileSync(
      join(checkout, "package.json"),
      JSON.stringify({ name: "gobot", version: "2.11.0" }),
    );
    expect(decidePatchAfterAcquire(checkout)).toBe("apply");
    expect(buildCloneArgs("https://example.invalid/custom.git", checkout)).toEqual([
      "clone",
      "https://example.invalid/custom.git",
      checkout,
    ]);
  });
});
