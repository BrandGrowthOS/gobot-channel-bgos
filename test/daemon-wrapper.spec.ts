import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import {
  botSpawnSpec,
  parseDaemonWrapperArgs,
  runDaemonWrapper,
  type DaemonWrapperRuntime,
  type WrapperController,
} from "../src/daemon-wrapper.js";
import {
  EMPTY_AUTO_UPDATE_STATE,
  WRAPPED_BOOT_COMMIT_ENV,
  transitionRollbackState,
  type AutoUpdateControllerDeps,
  type AutoUpdateStartResult,
} from "../src/self-update.js";

class FakeChild extends EventEmitter {
  kill = vi.fn(() => true);
}

class FakeSignalTarget extends EventEmitter {
  override on(signal: NodeJS.Signals, listener: () => void): this {
    return super.on(signal, listener);
  }

  override off(signal: NodeJS.Signals, listener: () => void): this {
    return super.off(signal, listener);
  }
}

function createHarness(
  start: (
    env: NodeJS.ProcessEnv,
  ) => Promise<AutoUpdateStartResult> = async () => "running",
): {
  runtime: DaemonWrapperRuntime;
  child: FakeChild;
  controller: WrapperController;
  createController: ReturnType<typeof vi.fn>;
  spawnProcess: ReturnType<typeof vi.fn>;
  signalTarget: FakeSignalTarget;
  env: NodeJS.ProcessEnv;
  logs: string[];
} {
  const env: NodeJS.ProcessEnv = { BGOS_AUTO_UPDATE: "on" };
  const child = new FakeChild();
  const controller: WrapperController = {
    start: vi.fn(() => start(env)),
    stop: vi.fn(),
  };
  const createController = vi.fn(
    (_deps: AutoUpdateControllerDeps) => controller,
  );
  const spawnProcess = vi.fn(() => child as unknown as ChildProcess);
  const signalTarget = new FakeSignalTarget();
  const logs: string[] = [];
  return {
    runtime: {
      env,
      execPath: "/opt/homebrew/bin/bun",
      signalTarget,
      spawnProcess: spawnProcess as unknown as typeof spawn,
      createController,
      log: (message) => logs.push(message),
    },
    child,
    controller,
    createController,
    spawnProcess,
    signalTarget,
    env,
    logs,
  };
}

async function letWrapperSpawn(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("daemon wrapper arguments", () => {
  it("accepts exactly one checkout and builds an absolute shell-free child", () => {
    expect(parseDaemonWrapperArgs(["/Users/kc/src/gobot-bgos"])).toBe(
      "/Users/kc/src/gobot-bgos",
    );
    expect(() => parseDaemonWrapperArgs([])).toThrow(
      "expected one Gobot install directory argument",
    );
    expect(() => parseDaemonWrapperArgs(["/a", "/b"])).toThrow(
      "expected one Gobot install directory argument",
    );

    const env = { BGOS_AUTO_UPDATE: "on" };
    expect(
      botSpawnSpec(
        "/Users/kc/src/gobot-bgos",
        "/opt/homebrew/bin/bun",
        env,
      ),
    ).toEqual({
      command: "/opt/homebrew/bin/bun",
      args: ["run", "/Users/kc/src/gobot-bgos/src/bot.ts"],
      options: {
        cwd: "/Users/kc/src/gobot-bgos",
        env,
        shell: false,
        stdio: "inherit",
      },
    });
  });
});

describe("daemon wrapper lifecycle", () => {
  it("runs pre-import recovery and inherits its boot marker", async () => {
    const commit = "a".repeat(40);
    const harness = createHarness(async (env) => {
      expect(env[WRAPPED_BOOT_COMMIT_ENV]).toBeUndefined();
      env[WRAPPED_BOOT_COMMIT_ENV] = commit;
      return "running";
    });
    harness.env[WRAPPED_BOOT_COMMIT_ENV] = "stale";

    const completion = runDaemonWrapper(
      "/Users/kc/src/gobot-bgos",
      harness.runtime,
    );
    await letWrapperSpawn();

    expect(harness.createController).toHaveBeenCalledWith(
      expect.objectContaining({
        checkoutDir: "/Users/kc/src/gobot-bgos",
        expectedPackageName: "gobot",
        bunPath: "/opt/homebrew/bin/bun",
        env: harness.env,
        preImportOnly: true,
      }),
    );
    expect(harness.spawnProcess).toHaveBeenCalledWith(
      "/opt/homebrew/bin/bun",
      ["run", "/Users/kc/src/gobot-bgos/src/bot.ts"],
      expect.objectContaining({
        shell: false,
        env: expect.objectContaining({
          [WRAPPED_BOOT_COMMIT_ENV]: commit,
        }),
      }),
    );

    harness.child.emit("exit", 0, null);
    await expect(completion).resolves.toBe(0);
    expect(harness.controller.stop).not.toHaveBeenCalled();
  });

  it.each(["retry-required", "exit-requested"] as const)(
    "does not import Gobot after %s",
    async (result) => {
      const harness = createHarness(async () => result);

      await expect(
        runDaemonWrapper("/Users/kc/src/gobot-bgos", harness.runtime),
      ).resolves.toBe(result === "retry-required" ? 1 : 0);
      expect(harness.spawnProcess).not.toHaveBeenCalled();
      expect(harness.controller.stop).not.toHaveBeenCalled();
    },
  );

  it("keeps an intentional child update exit pending for health validation", async () => {
    const harness = createHarness();
    const completion = runDaemonWrapper(
      "/Users/kc/src/gobot-bgos",
      harness.runtime,
    );
    await letWrapperSpawn();

    harness.child.emit("exit", 0, null);

    await expect(completion).resolves.toBe(0);
    expect(harness.controller.stop).not.toHaveBeenCalled();

    const handoff = transitionRollbackState(
      transitionRollbackState(EMPTY_AUTO_UPDATE_STATE, {
        type: "update-staged",
        previousCommit: "a".repeat(40),
        previousPluginVersion: "0.15.0",
        targetCommit: "b".repeat(40),
        targetPluginVersion: "0.15.1",
        dependencyFilesChanged: false,
        upstreamRef: "refs/remotes/origin/bgos-integration",
      }).state,
      {
        type: "boot",
        nowMs: 100,
        currentCommit: "b".repeat(40),
      },
    );
    expect(handoff.action).toBe("continue");
    expect(handoff.state.pending).toMatchObject({
      crashCount: 0,
      bootStartedAtMs: 100,
    });
  });

  it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
    "records %s as clean before forwarding it",
    async (signal) => {
      const harness = createHarness();
      const completion = runDaemonWrapper(
        "/Users/kc/src/gobot-bgos",
        harness.runtime,
      );
      await letWrapperSpawn();

      harness.signalTarget.emit(signal);

      expect(harness.controller.stop).toHaveBeenCalledTimes(1);
      expect(harness.child.kill).toHaveBeenCalledWith(signal);
      expect(
        vi.mocked(harness.controller.stop).mock.invocationCallOrder[0],
      ).toBeLessThan(harness.child.kill.mock.invocationCallOrder[0]);
      harness.child.emit("exit", null, signal);
      await expect(completion).resolves.toBe(0);
    },
  );

  it("records a clean signal again when it arrives during preflight", async () => {
    let releasePreflight: (() => void) | undefined;
    const preflight = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
    const harness = createHarness(async () => {
      await preflight;
      return "running";
    });
    const completion = runDaemonWrapper(
      "/Users/kc/src/gobot-bgos",
      harness.runtime,
    );
    harness.signalTarget.emit("SIGTERM");
    releasePreflight?.();

    await expect(completion).resolves.toBe(0);
    expect(harness.controller.stop).toHaveBeenCalledTimes(2);
    expect(harness.spawnProcess).not.toHaveBeenCalled();
  });

  it("fails closed without importing Gobot when the preflight throws", async () => {
    const harness = createHarness(async () => {
      throw new Error("unexpected preflight error");
    });

    await expect(
      runDaemonWrapper("/Users/kc/src/gobot-bgos", harness.runtime),
    ).resolves.toBe(1);
    expect(harness.spawnProcess).not.toHaveBeenCalled();
    expect(harness.logs.join("\n")).toContain(
      "auto-update preflight failed; Gobot was not started",
    );
    expect(harness.controller.stop).not.toHaveBeenCalled();
  });
});
