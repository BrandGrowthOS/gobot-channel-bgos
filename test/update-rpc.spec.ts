/**
 * update_rpc handler (wire contract v1, sections 3 + 6): frame whitelist,
 * ack/duplicate discipline, the fail-closed decision table, and the
 * supervised-restart vs staged split.
 */
import { describe, expect, it, vi } from "vitest";

import {
  normalizeUpdateRpc,
  UpdateRpcHandler,
  type UpdateRpcDeps,
  type UpdateRpcProgressBody,
} from "../src/update-rpc.js";
import type { CommandResult } from "../src/self-update.js";

const OK: CommandResult = { status: 0, stdout: "", stderr: "" };
const FAILED: CommandResult = { status: 1, stdout: "", stderr: "boom" };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Recorded {
  acks: string[];
  progresses: Array<{ rpcId: string; body: UpdateRpcProgressBody }>;
}

function makeHandler(overrides: Partial<UpdateRpcDeps> = {}): {
  handler: UpdateRpcHandler;
  recorded: Recorded;
  drain: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
  restart: ReturnType<typeof vi.fn>;
  hardExit: ReturnType<typeof vi.fn>;
} {
  const recorded: Recorded = { acks: [], progresses: [] };
  const drain = vi.fn(async () => {});
  const resume = vi.fn(async () => {});
  const shutdown = vi.fn(async () => {});
  const restart = vi.fn();
  const hardExit = vi.fn();
  const handler = new UpdateRpcHandler({
    api: {
      postUpdateRpcAck: async (rpcId) => void recorded.acks.push(rpcId),
      postUpdateRpcProgress: async (rpcId, body) =>
        void recorded.progresses.push({ rpcId, body }),
    },
    runningVersion: "0.16.0",
    drain,
    resume,
    shutdown,
    restart,
    env: {},
    registryVersionReader: async () => "0.16.1",
    forkRootResolver: () => "/fork",
    installPlugin: () => OK,
    installedPluginVersionReader: () => "0.16.1",
    latchReader: () => false,
    supervisedResolver: () => "none",
    hardExit,
    restartDelayMs: 0,
    hardExitDelayMs: 20,
    ...overrides,
  });
  return { handler, recorded, drain, resume, shutdown, restart, hardExit };
}

function stages(recorded: Recorded): string[] {
  return recorded.progresses.map((p) => p.body.stage);
}

describe("normalizeUpdateRpc", () => {
  it("accepts the exact contract frame", () => {
    expect(normalizeUpdateRpc({ rpcId: "r1", op: "update_now" })).toEqual({
      rpcId: "r1",
      op: "update_now",
    });
  });

  it("whitelists the op and requires rpcId", () => {
    expect(normalizeUpdateRpc({ rpcId: "r1", op: "install" })).toBeNull();
    expect(normalizeUpdateRpc({ op: "update_now" })).toBeNull();
    expect(normalizeUpdateRpc({ rpcId: 5, op: "update_now" })).toBeNull();
    expect(normalizeUpdateRpc(null)).toBeNull();
    expect(normalizeUpdateRpc("update_now")).toBeNull();
  });
});

describe("UpdateRpcHandler decision table", () => {
  it("kill switch off -> ack then error updates_disabled, nothing drained", async () => {
    const { handler, recorded, drain } = makeHandler({
      env: { BGOS_AUTO_UPDATE: "off" },
    });
    await handler.handle({ rpcId: "r1", op: "update_now" });
    expect(recorded.acks).toEqual(["r1"]);
    expect(recorded.progresses).toEqual([
      { rpcId: "r1", body: { stage: "error", message: "updates_disabled" } },
    ]);
    expect(drain).not.toHaveBeenCalled();
  });

  it("an invalid kill-switch value fails closed to updates_disabled", async () => {
    const { handler, recorded } = makeHandler({
      env: { BGOS_AUTO_UPDATE: "yes" },
    });
    await handler.handle({ rpcId: "r1", op: "update_now" });
    expect(recorded.progresses[0]!.body.message).toBe("updates_disabled");
  });

  it("rollback latch -> error rollback_latched", async () => {
    const { handler, recorded } = makeHandler({ latchReader: () => true });
    await handler.handle({ rpcId: "r1", op: "update_now" });
    expect(recorded.progresses).toEqual([
      { rpcId: "r1", body: { stage: "error", message: "rollback_latched" } },
    ]);
  });

  it("no fork root -> error fork_root_not_found", async () => {
    const { handler, recorded } = makeHandler({ forkRootResolver: () => null });
    await handler.handle({ rpcId: "r1", op: "update_now" });
    expect(recorded.progresses).toEqual([
      { rpcId: "r1", body: { stage: "error", message: "fork_root_not_found" } },
    ]);
  });

  it("registry not newer -> error no_update_available", async () => {
    const { handler, recorded } = makeHandler({
      registryVersionReader: async () => "0.16.0",
    });
    await handler.handle({ rpcId: "r1", op: "update_now" });
    expect(recorded.progresses).toEqual([
      { rpcId: "r1", body: { stage: "error", message: "no_update_available" } },
    ]);
  });

  it("a major jump is out of one-click scope -> no_update_available", async () => {
    const { handler, recorded, drain } = makeHandler({
      registryVersionReader: async () => "1.0.0",
    });
    await handler.handle({ rpcId: "r1", op: "update_now" });
    expect(recorded.progresses[0]!.body.message).toBe("no_update_available");
    expect(drain).not.toHaveBeenCalled();
  });

  it("registry failure -> no_update_available (fail closed, no crash)", async () => {
    const { handler, recorded } = makeHandler({
      registryVersionReader: async () => {
        throw new Error("registry down");
      },
    });
    await handler.handle({ rpcId: "r1", op: "update_now" });
    expect(recorded.progresses[0]!.body.message).toBe("no_update_available");
  });

  it("install failure -> draining, installing, error install_failed + resume", async () => {
    const { handler, recorded, drain, resume, restart } = makeHandler({
      installPlugin: () => FAILED,
    });
    await handler.handle({ rpcId: "r1", op: "update_now" });
    expect(stages(recorded)).toEqual(["draining", "installing", "error"]);
    expect(recorded.progresses.at(-1)!.body).toEqual({
      stage: "error",
      message: "install_failed",
      targetVersion: "0.16.1",
    });
    expect(drain).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(restart).not.toHaveBeenCalled();
  });

  it("installed major != running major -> contract_major_mismatch + resume", async () => {
    const { handler, recorded, resume } = makeHandler({
      installedPluginVersionReader: () => "1.0.0",
    });
    await handler.handle({ rpcId: "r1", op: "update_now" });
    expect(recorded.progresses.at(-1)!.body).toEqual({
      stage: "error",
      message: "contract_major_mismatch",
      targetVersion: "0.16.1",
    });
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("supervised host: restarting, then graceful shutdown + restart, no resume", async () => {
    const { handler, recorded, shutdown, restart, resume } = makeHandler({
      supervisedResolver: () => "systemd",
    });
    await handler.handle({ rpcId: "r1", op: "update_now" });
    expect(stages(recorded)).toEqual(["draining", "installing", "restarting"]);
    expect(recorded.progresses.at(-1)!.body.targetVersion).toBe("0.16.1");
    await vi.waitFor(() => {
      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(restart).toHaveBeenCalledTimes(1);
    });
    expect(resume).not.toHaveBeenCalled();
  });

  it("supervised host hard-exits if the SIGTERM is ignored", async () => {
    const { handler, hardExit } = makeHandler({
      supervisedResolver: () => "launchd",
      hardExitDelayMs: 5,
    });
    await handler.handle({ rpcId: "r1", op: "update_now" });
    await vi.waitFor(() => expect(hardExit).toHaveBeenCalledWith(0));
  });

  it("unsupervised host: staged + resume + onStaged, NEVER an exit", async () => {
    const onStaged = vi.fn();
    const { handler, recorded, resume, shutdown, restart, hardExit } =
      makeHandler({ onStaged });
    await handler.handle({ rpcId: "r1", op: "update_now" });
    expect(stages(recorded)).toEqual(["draining", "installing", "staged"]);
    expect(recorded.progresses.at(-1)!.body.targetVersion).toBe("0.16.1");
    expect(resume).toHaveBeenCalledTimes(1);
    expect(onStaged).toHaveBeenCalledTimes(1);
    await sleep(30);
    expect(shutdown).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
    expect(hardExit).not.toHaveBeenCalled();
  });
});

describe("UpdateRpcHandler ack + duplicate discipline", () => {
  it("a re-emitted frame does not run a second update", async () => {
    let releaseDrain: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    const { handler, recorded } = makeHandler({
      drain: vi.fn(() => gate) as unknown as UpdateRpcDeps["drain"],
    });
    const first = handler.handle({ rpcId: "r1", op: "update_now" });
    await sleep(5);
    await handler.handle({ rpcId: "r1", op: "update_now" }); // backend re-emit
    releaseDrain();
    await first;
    expect(recorded.acks).toEqual(["r1"]);
    expect(stages(recorded)).toEqual(["draining", "installing", "staged"]);
  });

  it("a duplicate frame retries a failed ack (the backend's retry lane)", async () => {
    const acks: string[] = [];
    let ackAttempts = 0;
    let releaseDrain: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    const { handler } = makeHandler({
      api: {
        postUpdateRpcAck: async (rpcId) => {
          ackAttempts += 1;
          if (ackAttempts === 1) throw new Error("network blip");
          acks.push(rpcId);
        },
        postUpdateRpcProgress: async () => {},
      },
      drain: (() => gate) as UpdateRpcDeps["drain"],
    });
    const first = handler.handle({ rpcId: "r1", op: "update_now" });
    await sleep(5);
    await handler.handle({ rpcId: "r1", op: "update_now" }); // re-emit lands the ack
    releaseDrain();
    await first;
    expect(ackAttempts).toBe(2);
    expect(acks).toEqual(["r1"]);
  });

  it("a malformed frame is ignored entirely", async () => {
    const { handler, recorded } = makeHandler();
    await handler.handle({ rpcId: "", op: "update_now" });
    await handler.handle({
      rpcId: "r1",
      op: "reboot",
    } as unknown as Parameters<UpdateRpcHandler["handle"]>[0]);
    expect(recorded.acks).toEqual([]);
    expect(recorded.progresses).toEqual([]);
  });
});
