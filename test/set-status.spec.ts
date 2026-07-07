/**
 * Public setStatus surface (contract C4 exposure). The fork's loader
 * feature-detects `adapter.setStatus` on the BGOSAdapter instance AND on the
 * object returned by createAdapter, then calls it to drive the "working…"
 * status line. Both must delegate straight to the internal BgosApi.setStatus
 * (PATCH /integrations/assistants/:id/status). Fail-open is the caller's job;
 * these methods only delegate.
 */
import { describe, it, expect, vi } from "vitest";

import { BGOSAdapter } from "../src/adapter.js";
import { createAdapter } from "../src/create-adapter.js";

const TOKEN = "pair_" + "x".repeat(30);
const BASE = "http://127.0.0.1:1";

function stubApiSetStatus(adapter: BGOSAdapter) {
  const spy = vi.fn().mockResolvedValue(undefined);
  (adapter.api as unknown as { setStatus: typeof spy }).setStatus = spy;
  return spy;
}

describe("BGOSAdapter.setStatus (class method)", () => {
  it("is a function on the adapter instance (fork loader feature-detect)", () => {
    const adapter = new BGOSAdapter({ baseUrl: BASE, pairingToken: TOKEN });
    expect(typeof adapter.setStatus).toBe("function");
  });

  it("delegates a 'working…' status to api.setStatus with the exact args", async () => {
    const adapter = new BGOSAdapter({ baseUrl: BASE, pairingToken: TOKEN });
    const spy = stubApiSetStatus(adapter);

    await adapter.setStatus(886, { statusText: "working...", statusEmoji: "gear" });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(886, {
      statusText: "working...",
      statusEmoji: "gear",
    });
  });

  it("passes a clear (nulls) straight through to api.setStatus", async () => {
    const adapter = new BGOSAdapter({ baseUrl: BASE, pairingToken: TOKEN });
    const spy = stubApiSetStatus(adapter);

    await adapter.setStatus(886, { statusText: null, statusEmoji: null });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(886, {
      statusText: null,
      statusEmoji: null,
    });
  });
});

describe("createAdapter().setStatus (fork-loader surface)", () => {
  it("surfaces setStatus on the returned object and delegates to api.setStatus", async () => {
    const created = createAdapter(
      { baseUrl: BASE, pairingToken: TOKEN },
      { dispatch: async () => {} },
    );
    expect(typeof created.setStatus).toBe("function");

    const spy = stubApiSetStatus(created.raw);
    await created.setStatus(886, { statusText: "working...", statusEmoji: "gear" });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(886, {
      statusText: "working...",
      statusEmoji: "gear",
    });
  });
});
