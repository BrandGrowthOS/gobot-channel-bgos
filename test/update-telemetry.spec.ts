/**
 * One-click update telemetry (wire contract v1, section 1): supervised
 * resolution, rollback-latch read, fork-root walk-up, and the
 * UpdateTelemetrySource snapshot the heartbeat rides.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  autoUpdateStatePath,
  writeAutoUpdateState,
  EMPTY_AUTO_UPDATE_STATE,
  WRAPPED_BOOT_COMMIT_ENV,
} from "../src/self-update.js";
import {
  LATEST_CHECK_INTERVAL_MS,
  readRollbackLatched,
  resolveForkRoot,
  resolveSupervised,
  SUPERVISED_KINDS,
  UpdateTelemetrySource,
} from "../src/update-telemetry.js";

describe("resolveSupervised", () => {
  it.each([...SUPERVISED_KINDS])("accepts declared %s", (kind) => {
    expect(resolveSupervised({ BGOS_SUPERVISED: kind })).toBe(kind);
  });

  it("ignores values outside the contract enum", () => {
    expect(resolveSupervised({ BGOS_SUPERVISED: "docker" })).toBe("none");
    expect(resolveSupervised({ BGOS_SUPERVISED: "" })).toBe("none");
    expect(resolveSupervised({})).toBe("none");
  });

  it("falls back to 'launcher' under the daemon wrapper boot marker", () => {
    expect(resolveSupervised({ [WRAPPED_BOOT_COMMIT_ENV]: "a".repeat(40) }))
      .toBe("launcher");
  });

  it("an explicit declaration beats the wrapper marker", () => {
    expect(
      resolveSupervised({
        BGOS_SUPERVISED: "systemd",
        [WRAPPED_BOOT_COMMIT_ENV]: "a".repeat(40),
      }),
    ).toBe("systemd");
  });
});

describe("readRollbackLatched", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "gobot-latch-test-"));
  });
  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("no state file reads as not latched", () => {
    expect(readRollbackLatched({ GOBOT_HOME: tempHome })).toBe(false);
  });

  it("disabled without resetSeen reads as latched", () => {
    const env = { GOBOT_HOME: tempHome };
    writeAutoUpdateState(autoUpdateStatePath(env), {
      ...EMPTY_AUTO_UPDATE_STATE,
      disabled: true,
    });
    expect(readRollbackLatched(env)).toBe(true);
  });

  it("disabled with resetSeen reads as not latched", () => {
    const env = { GOBOT_HOME: tempHome };
    writeAutoUpdateState(autoUpdateStatePath(env), {
      ...EMPTY_AUTO_UPDATE_STATE,
      disabled: true,
      resetSeen: true,
    });
    expect(readRollbackLatched(env)).toBe(false);
  });

  it("a malformed state file fails closed to latched", () => {
    const env = { GOBOT_HOME: tempHome };
    writeFileSync(autoUpdateStatePath(env), "{ not json");
    expect(readRollbackLatched(env)).toBe(true);
  });
});

describe("resolveForkRoot", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "gobot-forkroot-test-"));
  });
  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function writeManifest(dir: string, manifest: Record<string, unknown>): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  }

  it("walks up to a package.json listing the plugin in dependencies", () => {
    writeManifest(tempRoot, {
      name: "gobot",
      dependencies: { "gobot-channel-bgos": "^0.16.0" },
    });
    const nested = join(tempRoot, "src", "deep");
    mkdirSync(nested, { recursive: true });
    expect(resolveForkRoot({ startDir: nested })).toBe(tempRoot);
  });

  it("accepts optionalDependencies (the fork loader shape)", () => {
    writeManifest(tempRoot, {
      name: "gobot",
      optionalDependencies: { "gobot-channel-bgos": "0.16.0" },
    });
    expect(resolveForkRoot({ startDir: tempRoot })).toBe(tempRoot);
  });

  it("skips manifests that do not list the plugin", () => {
    writeManifest(tempRoot, {
      name: "gobot",
      dependencies: { "gobot-channel-bgos": "^0.16.0" },
    });
    const inner = join(tempRoot, "packages", "other");
    writeManifest(inner, { name: "other", dependencies: { axios: "^1.0.0" } });
    expect(resolveForkRoot({ startDir: inner })).toBe(tempRoot);
  });

  it("returns null when no manifest on the path lists the plugin", () => {
    const bare = join(tempRoot, "bare");
    mkdirSync(bare, { recursive: true });
    expect(resolveForkRoot({ startDir: bare })).toBeNull();
  });

  it("starts the walk at GOBOT_INSTALL_DIR when set", () => {
    writeManifest(tempRoot, {
      name: "gobot",
      dependencies: { "gobot-channel-bgos": "^0.16.0" },
    });
    expect(
      resolveForkRoot({ env: { GOBOT_INSTALL_DIR: tempRoot } }),
    ).toBe(tempRoot);
  });
});

describe("UpdateTelemetrySource", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "gobot-telemetry-test-"));
  });
  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function makeSource(overrides: Partial<ConstructorParameters<typeof UpdateTelemetrySource>[0]> = {}) {
    return new UpdateTelemetrySource({
      runningVersion: "0.16.0",
      env: {},
      registryVersionReader: async () => "0.17.0",
      forkRootResolver: () => null,
      latchReader: () => false,
      ...overrides,
    });
  }

  it("assembles the readiness shape from its readers", async () => {
    const source = makeSource({
      env: { BGOS_SUPERVISED: "launchd", BGOS_AUTO_UPDATE: "on" },
      latchReader: () => true,
    });
    source.snapshot();
    await source.whenIdle();
    expect(source.snapshot()).toEqual({
      latestKnownVersion: "0.17.0",
      updateReadiness: {
        supervised: "launchd",
        autoUpdateEnabled: true,
        rollbackLatched: true,
        pendingRestartVersion: null,
      },
    });
  });

  it("autoUpdateEnabled is false for off AND for invalid flag values", () => {
    expect(
      makeSource({ env: { BGOS_AUTO_UPDATE: "off" } }).snapshot()
        .updateReadiness.autoUpdateEnabled,
    ).toBe(false);
    expect(
      makeSource({ env: { BGOS_AUTO_UPDATE: "yes" } }).snapshot()
        .updateReadiness.autoUpdateEnabled,
    ).toBe(false);
    expect(
      makeSource({ env: {} }).snapshot().updateReadiness.autoUpdateEnabled,
    ).toBe(true);
  });

  it("registry failure or junk version reads as null latestKnownVersion", async () => {
    const failing = makeSource({
      registryVersionReader: async () => {
        throw new Error("registry down");
      },
    });
    failing.snapshot();
    await failing.whenIdle();
    expect(failing.snapshot().latestKnownVersion).toBeNull();

    const junk = makeSource({
      registryVersionReader: async () => "not-a-version",
    });
    junk.snapshot();
    await junk.whenIdle();
    expect(junk.snapshot().latestKnownVersion).toBeNull();
  });

  it("checks the registry at most daily", async () => {
    let nowMs = 1_000_000;
    const reader = vi.fn(async () => "0.17.0");
    const source = makeSource({
      registryVersionReader: reader,
      now: () => nowMs,
    });
    source.snapshot();
    await source.whenIdle();
    source.snapshot();
    await source.whenIdle();
    expect(reader).toHaveBeenCalledTimes(1);
    nowMs += LATEST_CHECK_INTERVAL_MS + 1;
    source.snapshot();
    await source.whenIdle();
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it("reports a staged install as pendingRestartVersion", async () => {
    const moduleDir = join(tempRoot, "node_modules", "gobot-channel-bgos");
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(
      join(moduleDir, "package.json"),
      JSON.stringify({ name: "gobot-channel-bgos", version: "0.17.0" }),
    );
    const source = makeSource({ forkRootResolver: () => tempRoot });
    source.snapshot();
    await source.whenIdle();
    expect(
      source.snapshot().updateReadiness.pendingRestartVersion,
    ).toBe("0.17.0");
  });

  it("pendingRestartVersion is null when disk matches the running version", () => {
    const moduleDir = join(tempRoot, "node_modules", "gobot-channel-bgos");
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(
      join(moduleDir, "package.json"),
      JSON.stringify({ name: "gobot-channel-bgos", version: "0.16.0" }),
    );
    const source = makeSource({ forkRootResolver: () => tempRoot });
    expect(
      source.snapshot().updateReadiness.pendingRestartVersion,
    ).toBeNull();
  });
});
