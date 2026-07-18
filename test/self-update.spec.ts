import {
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AutoUpdateController,
  ACTIVE_WORK_RETRY_MS,
  COMMAND_TIMEOUT_MS,
  EMPTY_AUTO_UPDATE_STATE,
  HEALTHY_BOOT_MS,
  MAX_UPDATE_JITTER_MS,
  MalformedAutoUpdateStateError,
  UPDATE_INTERVAL_MS,
  WRAPPED_BOOT_COMMIT_ENV,
  checkGitUpdate,
  compareVersions,
  decideDrainBeforeUpdate,
  decideVersionUpdate,
  parseAutoUpdateFlag,
  readAutoUpdateState,
  runCommand,
  transitionRollbackState,
  updateJitterMs,
  writeAutoUpdateState,
  type AutoUpdateState,
  type CommandRunner,
} from "../src/self-update.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gobot-update-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await import("node:fs/promises").then((fs) =>
      fs.rm(dir, { recursive: true, force: true }),
    );
  }
  vi.restoreAllMocks();
});

describe("auto-update flag gate", () => {
  it("accepts only the exact on and off values", () => {
    expect(parseAutoUpdateFlag("on")).toBe("on");
    expect(parseAutoUpdateFlag("off")).toBe("off");
    expect(parseAutoUpdateFlag(undefined)).toBe("invalid");
    expect(parseAutoUpdateFlag("ON")).toBe("invalid");
    expect(parseAutoUpdateFlag("true")).toBe("invalid");
    expect(parseAutoUpdateFlag(" on ")).toBe("invalid");
  });

  it("does no IO, command, check, or timer work when unset", async () => {
    const dir = tempDir();
    const statePath = join(dir, "bgos_auto_update.json");
    const runner = vi.fn<CommandRunner>();
    const setTimer = vi.fn();
    const controller = new AutoUpdateController({
      env: {},
      statePath,
      runner,
      setTimer,
    });

    await expect(controller.start()).resolves.toBe("inactive");
    expect(runner).not.toHaveBeenCalled();
    expect(setTimer).not.toHaveBeenCalled();
    expect(() => readFileSync(statePath)).toThrow();
  });

  it("records only the durable reset marker on an off boot", async () => {
    const dir = tempDir();
    const statePath = join(dir, "bgos_auto_update.json");
    writeAutoUpdateState(statePath, {
      schemaVersion: 1,
      disabled: true,
      resetSeen: false,
      upstreamRef: null,
      pending: null,
    });
    const runner = vi.fn<CommandRunner>();
    const setTimer = vi.fn();
    const controller = new AutoUpdateController({
      env: { BGOS_AUTO_UPDATE: "off" },
      statePath,
      runner,
      setTimer,
    });

    await expect(controller.start()).resolves.toBe("inactive");
    expect(readAutoUpdateState(statePath).resetSeen).toBe(true);
    expect(runner).not.toHaveBeenCalled();
    expect(setTimer).not.toHaveBeenCalled();
  });

  it("requires explicit off then on to recover malformed state", async () => {
    const root = tempDir();
    const statePath = join(root, "bgos_auto_update.json");
    writeFileSync(statePath, "malformed");
    const blockedRunner = vi.fn<CommandRunner>();
    const blocked = new AutoUpdateController({
      env: { BGOS_AUTO_UPDATE: "on" },
      checkoutDir: root,
      statePath,
      runner: blockedRunner,
    });
    await expect(blocked.start()).resolves.toBe("inactive");
    expect(blockedRunner).not.toHaveBeenCalled();

    const offRunner = vi.fn<CommandRunner>();
    const off = new AutoUpdateController({
      env: { BGOS_AUTO_UPDATE: "off" },
      checkoutDir: root,
      statePath,
      runner: offRunner,
    });
    await expect(off.start()).resolves.toBe("inactive");
    expect(offRunner).not.toHaveBeenCalled();
    expect(readAutoUpdateState(statePath)).toMatchObject({
      disabled: true,
      resetSeen: true,
    });

    const commit = "a".repeat(40);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "gobot", version: "2.1.0" }),
    );
    const runner: CommandRunner = (_command, args) => {
      const key = args.join(" ");
      if (key === "rev-parse --show-toplevel") {
        return { status: 0, stdout: root + "\n", stderr: "" };
      }
      if (
        key === "rev-parse HEAD" ||
        key === "rev-parse refs/remotes/origin/main"
      ) {
        return { status: 0, stdout: commit + "\n", stderr: "" };
      }
      if (key === "rev-parse --symbolic-full-name @{upstream}") {
        return { status: 0, stdout: "refs/remotes/origin/main\n", stderr: "" };
      }
      if (key === "fetch --quiet") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (key === `show ${currentCommit}:package.json`) {
        return {
          status: 0,
          stdout: JSON.stringify({
            name: "gobot",
            optionalDependencies: {
              "gobot-channel-bgos": "^0.15.0",
            },
          }),
          stderr: "",
        };
      }
      return { status: 1, stdout: "", stderr: "unexpected command" };
    };
    const timer = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    const reenabled = new AutoUpdateController({
      env: { BGOS_AUTO_UPDATE: "on" },
      checkoutDir: root,
      statePath,
      runner,
      setTimer: () => timer,
    });
    await expect(reenabled.start()).resolves.toBe("running");
    expect(readAutoUpdateState(statePath).disabled).toBe(false);
    reenabled.stop();
  });
});

describe("version policy", () => {
  it("compares stable and prerelease versions", () => {
    expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.2.3-rc.1", "1.2.3")).toBe(-1);
    expect(compareVersions("bad", "1.2.3")).toBeNull();
  });

  it("permits only newer versions in the same major", () => {
    expect(decideVersionUpdate("2.1.0", "2.2.0")).toBe("update");
    expect(decideVersionUpdate("2.1.0", "3.0.0")).toBe("major-blocked");
    expect(decideVersionUpdate("2.1.0", "2.1.0")).toBe("current");
    expect(decideVersionUpdate("2.2.0", "2.1.0")).toBe("current");
    expect(decideVersionUpdate("unknown", "2.1.0")).toBe("invalid");
  });
});

describe("scheduling and drain policy", () => {
  it("keeps jitter within zero through six hours", () => {
    expect(updateJitterMs(0)).toBe(0);
    expect(updateJitterMs(0.5)).toBe(MAX_UPDATE_JITTER_MS / 2);
    expect(updateJitterMs(1)).toBe(MAX_UPDATE_JITTER_MS);
    expect(updateJitterMs(-10)).toBe(0);
    expect(updateJitterMs(10)).toBe(MAX_UPDATE_JITTER_MS);
    expect(updateJitterMs(Number.NaN)).toBe(0);
  });

  it("requires intake drain and zero active messages before apply", () => {
    expect(
      decideDrainBeforeUpdate({
        updateReady: false,
        draining: false,
        activeMessages: 0,
      }),
    ).toBe("idle");
    expect(
      decideDrainBeforeUpdate({
        updateReady: true,
        draining: false,
        activeMessages: 0,
      }),
    ).toBe("begin");
    expect(
      decideDrainBeforeUpdate({
        updateReady: true,
        draining: true,
        activeMessages: 1,
      }),
    ).toBe("wait");
    expect(
      decideDrainBeforeUpdate({
        updateReady: true,
        draining: true,
        activeMessages: 0,
      }),
    ).toBe("apply");
  });
});

describe("rollback state machine", () => {
  const previousCommit = "a".repeat(40);
  const targetCommit = "b".repeat(40);

  function staged(): AutoUpdateState {
    return transitionRollbackState(EMPTY_AUTO_UPDATE_STATE, {
      type: "update-staged",
      previousCommit,
      previousPluginVersion: "0.15.0",
      targetCommit,
      targetPluginVersion: "0.15.1",
      dependencyFilesChanged: false,
      upstreamRef: "refs/remotes/origin/main",
    }).state;
  }

  it("requests rollback after two consecutive boots shorter than 60 seconds", () => {
    let result = transitionRollbackState(staged(), {
      type: "boot",
      nowMs: 1,
      currentCommit: targetCommit,
    });
    expect(result.action).toBe("continue");

    result = transitionRollbackState(result.state, {
      type: "boot",
      nowMs: HEALTHY_BOOT_MS - 1,
      currentCommit: targetCommit,
    });
    expect(result.state.pending?.crashCount).toBe(1);
    expect(result.action).toBe("continue");

    result = transitionRollbackState(result.state, {
      type: "boot",
      nowMs: HEALTHY_BOOT_MS,
      currentCommit: targetCommit,
    });
    expect(result.state.pending?.crashCount).toBe(2);
    expect(result.action).toBe("rollback");
  });

  it("clears rollback monitoring after a healthy boot", () => {
    const booted = transitionRollbackState(staged(), {
      type: "boot",
      nowMs: 5,
      currentCommit: targetCommit,
    });
    const healthy = transitionRollbackState(booted.state, {
      type: "healthy",
      currentCommit: targetCommit,
    });
    expect(healthy.state.pending).toBeNull();
  });

  it("keeps rollback disabled until off is observed before on", () => {
    let result = transitionRollbackState(staged(), { type: "rolled-back" });
    expect(result.action).toBe("disabled");

    result = transitionRollbackState(result.state, {
      type: "boot",
      nowMs: 10,
      currentCommit: previousCommit,
    });
    expect(result.action).toBe("disabled");

    result = transitionRollbackState(result.state, { type: "flag-off" });
    expect(result.state.disabled).toBe(true);
    expect(result.state.resetSeen).toBe(true);

    result = transitionRollbackState(result.state, {
      type: "boot",
      nowMs: 20,
      currentCommit: previousCommit,
    });
    expect(result.action).toBe("continue");
    expect(result.state.disabled).toBe(false);
    expect(result.state.resetSeen).toBe(false);
  });
});

describe("wrapped boot ownership", () => {
  const previousCommit = "a".repeat(40);
  const targetCommit = "b".repeat(40);

  it("records before host start, avoids a duplicate boot, and uses remaining health time", async () => {
    const root = tempDir();
    const statePath = join(root, "bgos_auto_update.json");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "gobot", version: "2.11.0" }),
    );
    writeAutoUpdateState(
      statePath,
      transitionRollbackState(EMPTY_AUTO_UPDATE_STATE, {
        type: "update-staged",
        previousCommit,
        previousPluginVersion: "0.15.0",
        targetCommit,
        targetPluginVersion: "0.15.1",
        dependencyFilesChanged: false,
        upstreamRef: "refs/remotes/origin/bgos-integration",
      }).state,
    );
    const runner: CommandRunner = (_command, args) => {
      const key = args.join(" ");
      if (key === "rev-parse --show-toplevel") {
        return { status: 0, stdout: root + "\n", stderr: "" };
      }
      if (key === "rev-parse HEAD") {
        return { status: 0, stdout: targetCommit + "\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "unexpected command" };
    };
    const env: Record<string, string | undefined> = {
      BGOS_AUTO_UPDATE: "on",
    };
    const parent = new AutoUpdateController({
      env,
      checkoutDir: root,
      statePath,
      runner,
      now: () => 100,
      preImportOnly: true,
    });

    await expect(parent.start()).resolves.toBe("running");
    expect(env[WRAPPED_BOOT_COMMIT_ENV]).toBe(targetCommit);
    expect(readAutoUpdateState(statePath).pending).toMatchObject({
      bootStartedAtMs: 100,
      crashCount: 0,
    });

    const setTimer = vi.fn(
      () => ({ unref: vi.fn() }) as unknown as NodeJS.Timeout,
    );
    const child = new AutoUpdateController({
      env,
      checkoutDir: root,
      statePath,
      runner,
      now: () => 20_100,
      setTimer,
    });
    await expect(child.start()).resolves.toBe("running");
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 40_000);
    expect(readAutoUpdateState(statePath).pending).toMatchObject({
      bootStartedAtMs: 100,
      crashCount: 0,
    });

    child.stop();
    expect(readAutoUpdateState(statePath).pending?.bootStartedAtMs).toBe(100);
    parent.stop();
    expect(readAutoUpdateState(statePath).pending?.bootStartedAtMs).toBeNull();
  });
});

describe("state persistence", () => {
  it("writes atomically with owner-only mode and reads the same state", () => {
    const dir = tempDir();
    const path = join(dir, "state", "bgos_auto_update.json");
    const state: AutoUpdateState = {
      schemaVersion: 1,
      disabled: true,
      resetSeen: true,
      upstreamRef: null,
      pending: null,
    };
    writeAutoUpdateState(path, state);
    expect(readAutoUpdateState(path)).toEqual(state);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("fails closed for malformed existing data", () => {
    const dir = tempDir();
    const path = join(dir, "bgos_auto_update.json");
    writeFileSync(path, "not json");
    expect(() => readAutoUpdateState(path)).toThrow(
      MalformedAutoUpdateStateError,
    );
  });

  it("treats a missing state file as first run", () => {
    const dir = tempDir();
    expect(readAutoUpdateState(join(dir, "missing.json"))).toEqual(
      EMPTY_AUTO_UPDATE_STATE,
    );
  });

  it("sets a finite command timeout and disables git prompts", () => {
    const dir = tempDir();
    expect(Number.isFinite(COMMAND_TIMEOUT_MS)).toBe(true);
    expect(COMMAND_TIMEOUT_MS).toBeGreaterThan(0);
    const result = runCommand(
      process.execPath,
      [
        "-e",
        "process.stdout.write(process.env.GIT_TERMINAL_PROMPT || '')",
      ],
      dir,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("0");
  });
});

describe("git update inspection", () => {
  const currentCommit = "a".repeat(40);
  const targetCommit = "b".repeat(40);
  const runningDaemonVersion = "0.15.0";
  const candidateDaemonVersion = "0.15.1";
  const registryVersionReader = async () => candidateDaemonVersion;

  function fixtureRunner(root: string) {
    const calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
    const runner: CommandRunner = (command, args, cwd) => {
      calls.push({ command, args: [...args], cwd });
      const key = args.join(" ");
      if (key === "rev-parse --show-toplevel") {
        return { status: 0, stdout: root + "\n", stderr: "" };
      }
      if (key === "rev-parse HEAD") {
        return { status: 0, stdout: currentCommit + "\n", stderr: "" };
      }
      if (key.includes("--symbolic-full-name")) {
        return { status: 0, stdout: "refs/remotes/origin/main\n", stderr: "" };
      }
      if (key === "fetch --quiet") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (key === "rev-parse refs/remotes/origin/main") {
        return { status: 0, stdout: targetCommit + "\n", stderr: "" };
      }
      if (key === `merge-base --is-ancestor HEAD ${targetCommit}`) {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (key === `show ${targetCommit}:package.json`) {
        return {
          status: 0,
          stdout: JSON.stringify({
            name: "gobot",
            version: "2.2.0",
            optionalDependencies: {
              "gobot-channel-bgos": "^0.15.0",
            },
          }),
          stderr: "",
        };
      }
      if (key.startsWith("ls-files -- package.json")) {
        return { status: 0, stdout: "package.json\n", stderr: "" };
      }
      if (args[0] === "diff") {
        return {
          status: 0,
          stdout: "package.json\nbun.lock\n",
          stderr: "",
        };
      }
      return { status: 1, stdout: "", stderr: "unexpected command" };
    };
    return { runner, calls };
  }

  it("uses fixed git arguments and identifies a same-major fast-forward", async () => {
    const root = tempDir();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "gobot", version: "2.1.0" }),
    );
    const { runner, calls } = fixtureRunner(root);

    const check = await checkGitUpdate({
      checkoutDir: root,
      runningDaemonVersion,
      registryVersionReader,
      runner,
    });

    expect(check).toMatchObject({
      decision: "update-available",
      currentCommit,
      targetCommit,
      runningDaemonVersion,
      candidateDaemonVersion,
      dependencyFilesChanged: true,
    });
    expect(calls.map((call) => [call.command, ...call.args])).toContainEqual([
      "git",
      "fetch",
      "--quiet",
    ]);
    expect(calls.map((call) => [call.command, ...call.args])).toContainEqual([
      "git",
      "show",
      `${targetCommit}:package.json`,
    ]);
    expect(
      calls.some((call) => call.args.some((arg) => arg.includes("touch"))),
    ).toBe(false);
    expect(calls.slice(1).every((call) => call.cwd === calls[1].cwd)).toBe(true);
  });

  it("installs a newer exact registry daemon even when the fork commit is unchanged", async () => {
    const root = tempDir();
    const statePath = join(root, "state.json");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "gobot", version: "2.11.0" }),
    );
    const calls: string[] = [];
    const runner: CommandRunner = (command, args) => {
      const key = args.join(" ");
      calls.push([command, key].join(" "));
      if (key === "rev-parse --show-toplevel") {
        return { status: 0, stdout: root + "\n", stderr: "" };
      }
      if (
        key === "rev-parse HEAD" ||
        key === "rev-parse refs/remotes/origin/bgos-integration"
      ) {
        return { status: 0, stdout: currentCommit + "\n", stderr: "" };
      }
      if (key === "rev-parse --symbolic-full-name @{upstream}") {
        return {
          status: 0,
          stdout: "refs/remotes/origin/bgos-integration\n",
          stderr: "",
        };
      }
      if (key === "fetch --quiet") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (key === `show ${currentCommit}:package.json`) {
        return {
          status: 0,
          stdout: JSON.stringify({
            name: "gobot",
            optionalDependencies: {
              "gobot-channel-bgos": "^0.15.0",
            },
          }),
          stderr: "",
        };
      }
      if (key === `merge --ff-only ${currentCommit}`) {
        return { status: 0, stdout: "already current", stderr: "" };
      }
      if (key.startsWith("ls-files -- package.json")) {
        return { status: 0, stdout: "package.json\n", stderr: "" };
      }
      if (
        command === "bun" &&
        key === `install gobot-channel-bgos@${candidateDaemonVersion} --no-save`
      ) {
        writeFileSync(join(root, "package.json"), "temporarily mutated");
        return { status: 0, stdout: "installed", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "unexpected command" };
    };
    const exit = vi.fn();
    const controller = new AutoUpdateController({
      env: { BGOS_AUTO_UPDATE: "on" },
      checkoutDir: root,
      runningDaemonVersion,
      registryVersionReader,
      statePath,
      runner,
      exit,
      installedPluginVersionReader: () => candidateDaemonVersion,
    });

    await expect(controller.start()).resolves.toBe("exit-requested");
    expect(calls).toContain(`git merge --ff-only ${currentCommit}`);
    expect(calls).toContain(
      `bun install gobot-channel-bgos@${candidateDaemonVersion} --no-save`,
    );
    expect(calls).not.toContain("bun install");
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))).toEqual({
      name: "gobot",
      version: "2.11.0",
    });
    expect(readAutoUpdateState(statePath).pending).toMatchObject({
      previousCommit: currentCommit,
      targetCommit: currentCommit,
      previousPluginVersion: runningDaemonVersion,
      targetPluginVersion: candidateDaemonVersion,
      dependencyFilesChanged: false,
    });
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("rejects unsafe remote ref text before fetch or apply", async () => {
    const root = tempDir();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "gobot", version: "2.1.0" }),
    );
    const calls: Array<readonly string[]> = [];
    const runner: CommandRunner = (command, args) => {
      calls.push([command, ...args]);
      const key = args.join(" ");
      if (key === "rev-parse --show-toplevel") {
        return { status: 0, stdout: root + "\n", stderr: "" };
      }
      if (key === "rev-parse HEAD") {
        return { status: 0, stdout: currentCommit + "\n", stderr: "" };
      }
      if (key.includes("--symbolic-full-name")) {
        return {
          status: 0,
          stdout: "refs/remotes/origin/main; touch /tmp/not-run\n",
          stderr: "",
        };
      }
      return { status: 1, stdout: "", stderr: "unexpected command" };
    };

    await expect(checkGitUpdate({
      checkoutDir: root,
      runningDaemonVersion,
      registryVersionReader,
      runner,
    })).resolves.toMatchObject({
      decision: "no-upstream",
    });
    expect(calls.some((call) => call.includes("fetch"))).toBe(false);
    expect(calls.some((call) => call.some((arg) => arg === "touch"))).toBe(
      false,
    );
  });

  it("checks at boot before scheduling 24 hours plus fresh jitter", async () => {
    const root = tempDir();
    const statePath = join(root, "state.json");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "gobot", version: "2.1.0" }),
    );
    const calls: string[] = [];
    const runner: CommandRunner = (command, args) => {
      const key = args.join(" ");
      calls.push([command, key].join(" "));
      if (key === "rev-parse --show-toplevel") {
        return { status: 0, stdout: root + "\n", stderr: "" };
      }
      if (
        key === "rev-parse HEAD" ||
        key === "rev-parse refs/remotes/origin/main"
      ) {
        return { status: 0, stdout: currentCommit + "\n", stderr: "" };
      }
      if (key.includes("--symbolic-full-name")) {
        return { status: 0, stdout: "refs/remotes/origin/main\n", stderr: "" };
      }
      if (key === "fetch --quiet") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (key === `show ${currentCommit}:package.json`) {
        return {
          status: 0,
          stdout: JSON.stringify({
            name: "gobot",
            optionalDependencies: {
              "gobot-channel-bgos": "^0.15.0",
            },
          }),
          stderr: "",
        };
      }
      return { status: 1, stdout: "", stderr: "unexpected command" };
    };
    const timer = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    const setTimer = vi.fn(() => timer);
    const controller = new AutoUpdateController({
      env: { BGOS_AUTO_UPDATE: "on" },
      checkoutDir: root,
      runningDaemonVersion,
      registryVersionReader: async () => runningDaemonVersion,
      statePath,
      runner,
      random: () => 0.5,
      setTimer,
    });

    await expect(controller.start()).resolves.toBe("running");
    expect(calls).toContain("git fetch --quiet");
    expect(setTimer).toHaveBeenCalledWith(
      expect.any(Function),
      UPDATE_INTERVAL_MS + MAX_UPDATE_JITTER_MS / 2,
    );
    controller.stop();
  });

  it("defers a scheduled check while message work is active", async () => {
    const root = tempDir();
    const statePath = join(root, "state.json");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "gobot", version: "2.1.0" }),
    );
    let fetchCount = 0;
    const runner: CommandRunner = (_command, args) => {
      const key = args.join(" ");
      if (key === "rev-parse --show-toplevel") {
        return { status: 0, stdout: root + "\n", stderr: "" };
      }
      if (
        key === "rev-parse HEAD" ||
        key === "rev-parse refs/remotes/origin/main"
      ) {
        return { status: 0, stdout: currentCommit + "\n", stderr: "" };
      }
      if (key === "rev-parse --symbolic-full-name @{upstream}") {
        return { status: 0, stdout: "refs/remotes/origin/main\n", stderr: "" };
      }
      if (key === "fetch --quiet") {
        fetchCount += 1;
        return { status: 0, stdout: "", stderr: "" };
      }
      if (key === `show ${currentCommit}:package.json`) {
        return {
          status: 0,
          stdout: JSON.stringify({
            name: "gobot",
            optionalDependencies: {
              "gobot-channel-bgos": "^0.15.0",
            },
          }),
          stderr: "",
        };
      }
      return { status: 1, stdout: "", stderr: "unexpected command" };
    };
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const setTimer = vi.fn((callback: () => void, delay: number) => {
      timers.push({ callback, delay });
      return { unref: vi.fn() } as unknown as NodeJS.Timeout;
    });
    let active = false;
    const controller = new AutoUpdateController({
      env: { BGOS_AUTO_UPDATE: "on" },
      checkoutDir: root,
      runningDaemonVersion,
      registryVersionReader: async () => runningDaemonVersion,
      statePath,
      runner,
      setTimer,
      hasActiveWork: () => active,
    });

    await controller.start();
    expect(fetchCount).toBe(1);
    active = true;
    timers.shift()?.callback();
    expect(fetchCount).toBe(1);
    expect(timers[0]?.delay).toBe(ACTIVE_WORK_RETRY_MS);

    active = false;
    timers.shift()?.callback();
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchCount).toBe(2);
    controller.stop();
  });

  it("dry-run logs the real decision without merge, install, drain, or exit", async () => {
    const root = tempDir();
    const statePath = join(root, "state.json");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "gobot", version: "2.1.0" }),
    );
    const { runner, calls } = fixtureRunner(root);
    const log = vi.fn();
    const drain = vi.fn(async () => undefined);
    const exit = vi.fn();
    const controller = new AutoUpdateController({
      checkoutDir: root,
      runningDaemonVersion,
      registryVersionReader,
      statePath,
      runner,
      log,
      drain,
      exit,
    });

    await expect(controller.dryRunCheck()).resolves.toMatchObject({
      decision: "update-available",
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("update-available"),
    );
    expect(drain).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(calls.some((call) => call.args[0] === "merge")).toBe(false);
    expect(calls.some((call) => call.command === "bun")).toBe(false);
  });

  it("drains before fast-forward and refreshes manifest dependencies plus the exact daemon", async () => {
    const root = tempDir();
    const statePath = join(root, "state", "bgos_auto_update.json");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "gobot", version: "2.1.0" }),
    );
    writeFileSync(join(root, "bun.lock"), "lock");
    const fixture = fixtureRunner(root);
    const events: string[] = [];
    const runner: CommandRunner = (command, args, cwd) => {
      events.push([command, ...args].join(" "));
      if (command === "git" && args[0] === "merge") {
        return { status: 0, stdout: "fast-forwarded", stderr: "" };
      }
      if (command === "bun") {
        return { status: 0, stdout: "installed", stderr: "" };
      }
      return fixture.runner(command, args, cwd);
    };
    const drain = vi.fn(async () => {
      events.push("drain");
    });
    const exit = vi.fn(() => {
      events.push("exit 0");
    });
    const shutdown = vi.fn(async () => {
      events.push("shutdown");
    });
    const controller = new AutoUpdateController({
      env: { BGOS_AUTO_UPDATE: "on" },
      checkoutDir: root,
      runningDaemonVersion,
      registryVersionReader,
      statePath,
      runner,
      drain,
      shutdown,
      exit,
      bunPath: "bun",
      installedPluginVersionReader: () => candidateDaemonVersion,
    });

    await expect(controller.start()).resolves.toBe("exit-requested");
    const drainIndex = events.indexOf("drain");
    const mergeIndex = events.indexOf(`git merge --ff-only ${targetCommit}`);
    const installIndex = events.indexOf("bun install");
    const pluginInstallIndex = events.indexOf(
      `bun install gobot-channel-bgos@${candidateDaemonVersion} --no-save`,
    );
    expect(drainIndex).toBeGreaterThanOrEqual(0);
    expect(mergeIndex).toBeGreaterThan(drainIndex);
    expect(installIndex).toBeGreaterThan(mergeIndex);
    expect(pluginInstallIndex).toBeGreaterThan(installIndex);
    expect(events.indexOf("shutdown")).toBeGreaterThan(pluginInstallIndex);
    expect(events.at(-1)).toBe("exit 0");
    expect(readAutoUpdateState(statePath).pending).toMatchObject({
      previousCommit: currentCommit,
      targetCommit,
      dependencyFilesChanged: true,
      previousPluginVersion: runningDaemonVersion,
      targetPluginVersion: candidateDaemonVersion,
    });
  });

  it("keeps update recovery pending when dependency recovery also fails", async () => {
    const root = tempDir();
    const statePath = join(root, "state", "bgos_auto_update.json");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "gobot", version: "2.1.0" }),
    );
    writeFileSync(join(root, "bun.lock"), "lock");
    const fixture = fixtureRunner(root);
    const runner: CommandRunner = (command, args, cwd) => {
      if (command === "git" && args[0] === "merge") {
        return { status: 0, stdout: "fast-forwarded", stderr: "" };
      }
      if (command === "git" && args[0] === "checkout") {
        return { status: 0, stdout: "restored", stderr: "" };
      }
      if (command === "bun") {
        return { status: 1, stdout: "", stderr: "install failed" };
      }
      return fixture.runner(command, args, cwd);
    };
    const setTimer = vi.fn();
    const controller = new AutoUpdateController({
      env: { BGOS_AUTO_UPDATE: "on" },
      checkoutDir: root,
      runningDaemonVersion,
      registryVersionReader,
      statePath,
      runner,
      setTimer,
      bunPath: "bun",
    });

    await expect(controller.start()).resolves.toBe("running");
    expect(readAutoUpdateState(statePath)).toMatchObject({
      disabled: false,
      resetSeen: false,
      upstreamRef: "refs/remotes/origin/main",
      pending: {
        previousPluginVersion: runningDaemonVersion,
        targetPluginVersion: candidateDaemonVersion,
        rollbackRequired: true,
      },
    });
    expect(setTimer).not.toHaveBeenCalled();
  });

  it("keeps rollback retryable when rollback dependencies cannot be restored", async () => {
    const root = tempDir();
    const statePath = join(root, "state", "bgos_auto_update.json");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "gobot", version: "2.2.0" }),
    );
    writeFileSync(join(root, "bun.lock"), "lock");
    writeAutoUpdateState(statePath, {
      schemaVersion: 1,
      disabled: false,
      resetSeen: false,
      upstreamRef: "refs/remotes/origin/main",
      pending: {
        previousCommit: currentCommit,
        previousPluginVersion: "0.15.0",
        targetCommit,
        targetPluginVersion: "0.15.1",
        crashCount: 2,
        bootStartedAtMs: 90,
        dependencyFilesChanged: true,
        rollbackRequired: true,
      },
    });
    const calls: string[] = [];
    const runner: CommandRunner = (command, args) => {
      const key = args.join(" ");
      calls.push([command, key].join(" "));
      if (key === "rev-parse --show-toplevel") {
        return { status: 0, stdout: root + "\n", stderr: "" };
      }
      if (key === "rev-parse HEAD") {
        return { status: 0, stdout: targetCommit + "\n", stderr: "" };
      }
      if (key === `checkout --detach ${currentCommit}`) {
        return { status: 0, stdout: "old checkout", stderr: "" };
      }
      if (key === `checkout --detach ${targetCommit}`) {
        return { status: 0, stdout: "target checkout", stderr: "" };
      }
      if (key.startsWith("ls-files -- package.json")) {
        return { status: 0, stdout: "package.json\n", stderr: "" };
      }
      if (command === "bun") {
        return { status: 1, stdout: "", stderr: "install failed" };
      }
      return { status: 1, stdout: "", stderr: "unexpected command" };
    };
    const log = vi.fn();
    const exit = vi.fn();
    const setTimer = vi.fn();
    const controller = new AutoUpdateController({
      env: { BGOS_AUTO_UPDATE: "on" },
      checkoutDir: root,
      runningDaemonVersion,
      registryVersionReader,
      statePath,
      runner,
      log,
      exit,
      setTimer,
      bunPath: "bun",
      preImportOnly: true,
    });

    await expect(controller.start()).resolves.toBe("retry-required");
    expect(calls).toContain(`git checkout --detach ${currentCommit}`);
    expect(calls).toContain(`git checkout --detach ${targetCommit}`);
    expect(readAutoUpdateState(statePath)).toMatchObject({
      disabled: false,
      pending: {
        previousCommit: currentCommit,
        targetCommit,
        rollbackRequired: true,
      },
    });
    expect(exit).not.toHaveBeenCalled();
    expect(setTimer).not.toHaveBeenCalled();
    expect(
      log.mock.calls.some(([message]) => String(message).includes("rolled back to")),
    ).toBe(false);
  });

  it("rolls back with a detached checkout and latches updates off", async () => {
    const root = tempDir();
    const statePath = join(root, "state", "bgos_auto_update.json");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "gobot", version: "2.2.0" }),
    );
    writeAutoUpdateState(statePath, {
      schemaVersion: 1,
      disabled: false,
      resetSeen: false,
      upstreamRef: "refs/remotes/origin/main",
      pending: {
        previousCommit: currentCommit,
        previousPluginVersion: "0.15.0",
        targetCommit,
        targetPluginVersion: "0.15.1",
        crashCount: 1,
        bootStartedAtMs: 90,
        dependencyFilesChanged: false,
        rollbackRequired: false,
      },
    });
    const calls: string[] = [];
    const runner: CommandRunner = (command, args) => {
      calls.push([command, ...args].join(" "));
      const key = args.join(" ");
      if (key === "rev-parse --show-toplevel") {
        return { status: 0, stdout: root + "\n", stderr: "" };
      }
      if (key === "rev-parse HEAD") {
        return { status: 0, stdout: targetCommit + "\n", stderr: "" };
      }
      if (key === `checkout --detach ${currentCommit}`) {
        return { status: 0, stdout: "restored", stderr: "" };
      }
      if (key.startsWith("ls-files -- package.json")) {
        return { status: 0, stdout: "package.json\n", stderr: "" };
      }
      if (
        command === "bun" &&
        key === "install gobot-channel-bgos@0.15.0 --no-save"
      ) {
        return { status: 0, stdout: "restored package", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "unexpected command" };
    };
    const exit = vi.fn();
    const controller = new AutoUpdateController({
      env: { BGOS_AUTO_UPDATE: "on" },
      checkoutDir: root,
      runningDaemonVersion,
      registryVersionReader,
      statePath,
      runner,
      now: () => 100,
      exit,
      installedPluginVersionReader: () => "0.15.0",
    });

    await expect(controller.start()).resolves.toBe("exit-requested");
    expect(calls).toContain(`git checkout --detach ${currentCommit}`);
    expect(calls).toContain(
      "bun install gobot-channel-bgos@0.15.0 --no-save",
    );
    expect(calls.some((call) => call.includes("reset"))).toBe(false);
    expect(calls.some((call) => call.includes("force"))).toBe(false);
    expect(exit).toHaveBeenCalledWith(0);
    expect(readAutoUpdateState(statePath)).toMatchObject({
      disabled: true,
      resetSeen: false,
      upstreamRef: "refs/remotes/origin/main",
      pending: null,
    });

    const offRunner = vi.fn<CommandRunner>();
    const offBoot = new AutoUpdateController({
      env: { BGOS_AUTO_UPDATE: "off" },
      checkoutDir: root,
      statePath,
      runner: offRunner,
    });
    await expect(offBoot.start()).resolves.toBe("inactive");
    expect(offRunner).not.toHaveBeenCalled();

    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "gobot", version: "2.1.0" }),
    );
    const rearmCalls: string[] = [];
    const rearmRunner: CommandRunner = (command, args) => {
      const key = args.join(" ");
      rearmCalls.push([command, key].join(" "));
      if (key === "rev-parse --show-toplevel") {
        return { status: 0, stdout: root + "\n", stderr: "" };
      }
      if (
        key === "rev-parse HEAD" ||
        key === "rev-parse refs/remotes/origin/main"
      ) {
        return { status: 0, stdout: currentCommit + "\n", stderr: "" };
      }
      if (key === "fetch --quiet") {
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "unexpected command" };
    };
    const timer = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    const onBoot = new AutoUpdateController({
      env: { BGOS_AUTO_UPDATE: "on" },
      checkoutDir: root,
      runningDaemonVersion,
      registryVersionReader: async () => runningDaemonVersion,
      statePath,
      runner: rearmRunner,
      setTimer: () => timer,
    });
    await expect(onBoot.start()).resolves.toBe("running");
    expect(
      rearmCalls.some((call) => call.includes("symbolic-full-name")),
    ).toBe(false);
    expect(rearmCalls).toContain("git fetch --quiet");
    expect(readAutoUpdateState(statePath).disabled).toBe(false);
    onBoot.stop();
  });

  it("contains unexpected check errors and lets the daemon continue", async () => {
    const root = tempDir();
    const log = vi.fn();
    const controller = new AutoUpdateController({
      env: { BGOS_AUTO_UPDATE: "on" },
      checkoutDir: root,
      runningDaemonVersion,
      registryVersionReader,
      statePath: join(root, "state.json"),
      runner: () => {
        throw new Error("probe exploded");
      },
      log,
    });

    await expect(controller.start()).resolves.toBe("running");
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("daemon will continue"),
    );
  });
});
