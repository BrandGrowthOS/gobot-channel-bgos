import { describe, expect, it, vi } from "vitest";

import { BGOSAdapter } from "../src/adapter.js";

const TOKEN = "pair_" + "x".repeat(30);

interface AdapterUpdateInternals {
  activeMessageCount: number;
  updateDraining: boolean;
  started: boolean;
  networkStarted: boolean;
  ws: { connect: () => Promise<void> };
  replaySpoolTracked: () => Promise<void>;
  drainForUpdate: () => Promise<void>;
  resumeAfterUpdateFailure: () => Promise<void>;
}

function makeAdapter(): BGOSAdapter {
  return new BGOSAdapter({
    baseUrl: "http://127.0.0.1:1",
    pairingToken: TOKEN,
  });
}

describe("BGOSAdapter update drain", () => {
  it("waits for an outbound spool send after its durable entry is claimed", async () => {
    const adapter = makeAdapter();
    let releaseSend: (() => void) | undefined;
    const sendFinished = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    vi.spyOn(adapter.outbound, "replaySpool").mockReturnValue(sendFinished);
    const internal = adapter as unknown as AdapterUpdateInternals;

    const replay = internal.replaySpoolTracked();
    expect(internal.activeMessageCount).toBe(1);

    let drainFinished = false;
    const drain = internal.drainForUpdate().then(() => {
      drainFinished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(drainFinished).toBe(false);
    expect(internal.updateDraining).toBe(true);

    releaseSend?.();
    await Promise.all([replay, drain]);
    expect(drainFinished).toBe(true);
    expect(internal.activeMessageCount).toBe(0);
  });

  it("does not open another socket when failure happened before drain", async () => {
    const adapter = makeAdapter();
    const internal = adapter as unknown as AdapterUpdateInternals;
    internal.started = true;
    internal.networkStarted = true;
    internal.updateDraining = false;
    const connect = vi.spyOn(internal.ws, "connect");

    await internal.resumeAfterUpdateFailure();

    expect(connect).not.toHaveBeenCalled();
  });
});
