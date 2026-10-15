/**
 * An agent that becomes known while the gateway runs gets its OWN persisted
 * cursor at once, not at the next poll: until it has one, it follows the shared
 * head, so a sibling's live message could move it past a row it has not got.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BGOSAdapter } from "../src/adapter.js";
import { loadAgentCursor, pollSince, saveAgentCursor } from "../src/last-id-store.js";

describe("a newly known agent is pinned to its own cursor", () => {
  let tempHome: string;
  const originalGobotHome = process.env.GOBOT_HOME;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "gobot-pin-"));
    process.env.GOBOT_HOME = tempHome;
  });
  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    if (originalGobotHome === undefined) delete process.env.GOBOT_HOME;
    else process.env.GOBOT_HOME = originalGobotHome;
  });

  it("pinKnownCursors gives a newly known agent its own cursor at the head", () => {
    const adapter = new BGOSAdapter({
      baseUrl: "http://127.0.0.1:1",
      pairingToken: "pair_" + "x".repeat(30),
    });
    const routes = (adapter as unknown as { assistantToRoute: Map<number, string> })
      .assistantToRoute;
    routes.set(1, "a");
    pollSince([1]);
    saveAgentCursor(1, 10); // head is 10

    routes.set(2, "b"); // agent 2 becomes known (assistant_bound / refreshIdentity)
    (adapter as unknown as { pinKnownCursors: () => void }).pinKnownCursors();

    saveAgentCursor(1, 12); // a sibling's live message moves the head on
    expect(loadAgentCursor(2)).toBe(10); // pinned, not following the head
  });
});
