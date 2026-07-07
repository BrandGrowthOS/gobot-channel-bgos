/**
 * Revocation state machine (contract C2): fatal latch fires onFatal once,
 * rate-limits 401 logs, and the secrets-reload path detects a parseable token
 * change and triggers recovery.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BGOSAdapter, type FatalInfo } from "../src/adapter.js";
import { PairingRevokedError } from "../src/types.js";

const TOKEN = "pair_" + "x".repeat(30);

function makeAdapter(onFatal?: (i: FatalInfo) => void): BGOSAdapter {
  return new BGOSAdapter({
    baseUrl: "https://api.brandgrowthos.ai",
    pairingToken: TOKEN,
    ...(onFatal ? { onFatal } : {}),
  });
}

describe("revocation state machine", () => {
  let tempHome: string;
  const originalGobotHome = process.env.GOBOT_HOME;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "gobot-revoke-test-"));
    process.env.GOBOT_HOME = tempHome;
  });
  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    if (originalGobotHome === undefined) delete process.env.GOBOT_HOME;
    else process.env.GOBOT_HOME = originalGobotHome;
  });

  it("enterFatalLatch fires onFatal ONCE with rotated code/reason", () => {
    const onFatal = vi.fn();
    const adapter = makeAdapter(onFatal);
    const priv = adapter as unknown as {
      enterFatalLatch: (r: "revoked" | "rotated", m: string) => void;
      stopSecretsWatch: () => void;
      heartbeat: { getLastErrorCode: () => string | null };
      fatalLatched: boolean;
    };
    priv.enterFatalLatch("rotated", "rotated!");
    priv.enterFatalLatch("rotated", "again"); // no-op

    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal).toHaveBeenCalledWith({
      code: "token_rotated",
      message: "rotated!",
      reason: "rotated",
    });
    expect(priv.heartbeat.getLastErrorCode()).toBe("token_rotated");
    expect(priv.fatalLatched).toBe(true);
    priv.stopSecretsWatch();
  });

  it("handleWsError rate-limits the 401 log to 1/min", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const adapter = makeAdapter();
      const priv = adapter as unknown as {
        handleWsError: (e: Error) => void;
        stopSecretsWatch: () => void;
      };
      priv.handleWsError(new PairingRevokedError("first"));
      priv.handleWsError(new PairingRevokedError("second"));
      const revokedLogs = errSpy.mock.calls.filter((c) =>
        String(c[0]).includes("pairing rejected (401)"),
      );
      expect(revokedLogs).toHaveLength(1);
      priv.stopSecretsWatch();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("checkSecretsForChange triggers recovery only on a parseable token change", async () => {
    const adapter = makeAdapter();
    const recovered: Array<{ token: string; baseUrl?: string }> = [];
    const priv = adapter as unknown as {
      fatalLatched: boolean;
      currentToken: string;
      recover: (t: string, b?: string) => Promise<void>;
      checkSecretsForChange: () => Promise<void>;
    };
    priv.fatalLatched = true;
    priv.currentToken = TOKEN;
    priv.recover = async (t, b) => {
      recovered.push({ token: t, baseUrl: b });
    };

    const secretsDir = join(tempHome, "secrets");
    mkdirSync(secretsDir, { recursive: true });
    const secretsPath = join(secretsDir, "bgos.json");

    // No file yet -> no recovery.
    await priv.checkSecretsForChange();
    expect(recovered).toHaveLength(0);

    // Same token -> no recovery.
    writeFileSync(
      secretsPath,
      JSON.stringify({ baseUrl: "https://api.brandgrowthos.ai", pairingToken: TOKEN }),
    );
    await priv.checkSecretsForChange();
    expect(recovered).toHaveLength(0);

    // New parseable token -> recovery.
    const newToken = "pair_" + "n".repeat(30);
    writeFileSync(
      secretsPath,
      JSON.stringify({ baseUrl: "https://api.brandgrowthos.ai", pairingToken: newToken }),
    );
    await priv.checkSecretsForChange();
    expect(recovered).toHaveLength(1);
    expect(recovered[0].token).toBe(newToken);
  });
});
