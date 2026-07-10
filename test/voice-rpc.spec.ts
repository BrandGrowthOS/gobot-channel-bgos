/**
 * voice_rpc handler — mint / consult / dispatch.
 *
 * The G2 regression class this guards: SILENT DROPS. Every whitelisted op
 * (mint | consult | dispatch) must pass the normalizer and reach the
 * handler, and every well-formed frame must produce an explicit REST
 * outcome (result or descriptive error) — never silence. Plus the
 * deadline/dedupe discipline ported from the OpenClaw reference
 * (inner cap < backend cap; rpcId + taskId dedupe; accept-first dispatch;
 * resilient voice-task result post).
 */
import { describe, expect, it } from "vitest";

import type { DispatchArgs, DispatchFn } from "../src/inbound-handler.js";
import {
  buildConsultToolDefinition,
  buildConsultTurnText,
  buildDispatchTurnText,
  buildMintInstructions,
  CONSULT_TOOL_NAME,
  DEFAULT_TIMING,
  loadVoiceConfigFromEnv,
  normalizeExpiresAtSeconds,
  normalizeVoiceConfig,
  normalizeVoiceRpc,
  OFFER_URL,
  VOICE_TURN_SYSTEM_NOTE,
  VoiceRpcHandler,
  type VoiceConfig,
  type VoiceRpcDeps,
  type VoiceRpcFrame,
  type VoiceRpcResultBody,
} from "../src/voice-rpc.js";

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function frame(over: Partial<VoiceRpcFrame> = {}): VoiceRpcFrame {
  return {
    rpcId: "rpc-1",
    op: "consult",
    assistantId: 7,
    agentRoute: "main",
    chatId: 42,
    payload: {
      callId: "call-1",
      name: CONSULT_TOOL_NAME,
      args: { question: "What is the deploy status?" },
    },
    ...over,
  };
}

interface RecordedCalls {
  acks: string[];
  results: Array<{ rpcId: string; body: VoiceRpcResultBody }>;
  taskResults: Array<{ taskId: string; body: VoiceRpcResultBody }>;
  dispatches: DispatchArgs[];
}

function makeHarness(over: {
  dispatchImpl?: DispatchFn | null;
  config?: Partial<VoiceConfig>;
  timing?: Partial<VoiceRpcDeps["timing"]>;
  fetchImpl?: typeof fetch;
  failAck?: boolean;
  failResult?: boolean;
  failTaskResultTimes?: number;
  route?: string | null;
} = {}) {
  const calls: RecordedCalls = {
    acks: [],
    results: [],
    taskResults: [],
    dispatches: [],
  };
  let taskResultFailures = over.failTaskResultTimes ?? 0;
  const deps: VoiceRpcDeps = {
    api: {
      postVoiceRpcAck: async (rpcId) => {
        if (over.failAck) throw new Error("ack 500");
        calls.acks.push(rpcId);
      },
      postVoiceRpcResult: async (rpcId, body) => {
        if (over.failResult) throw new Error("result 500");
        calls.results.push({ rpcId, body });
      },
      postVoiceTaskResult: async (taskId, body) => {
        if (taskResultFailures > 0) {
          taskResultFailures--;
          throw new Error("task result 500");
        }
        calls.taskResults.push({ taskId, body });
      },
    },
    config: {
      openaiApiKey: "sk-test-not-a-real-key",
      model: "gpt-realtime-2",
      voice: "marin",
      persona: "",
      ...(over.config ?? {}),
    },
    getDispatch: () =>
      over.dispatchImpl === undefined
        ? async (args) => {
            calls.dispatches.push(args);
            await args.replyHandle.sendText("Deploy is green.");
          }
        : over.dispatchImpl === null
          ? null
          : (async (args) => {
              calls.dispatches.push(args);
              await over.dispatchImpl!(args);
            })
        ,
    getRouteForAssistant: () => over.route === undefined ? "main" : over.route,
    getAssistantName: () => "Echo",
    getUserId: () => "user_1",
    getSystemPrompt: () => "You are Echo.",
    timing: {
      mintTimeoutMs: 500,
      consultTimeoutMs: 400,
      dispatchTimeoutMs: 600,
      noReplyGraceMs: 40,
      resultRetryDelayMs: 10,
      ...(over.timing ?? {}),
    },
    ...(over.fetchImpl ? { fetchImpl: over.fetchImpl } : {}),
  };
  return { handler: new VoiceRpcHandler(deps), calls };
}

function okFetch(
  data: Record<string, unknown> = {
    value: "ek_test_secret",
    expires_at: 1_780_000_000,
  },
  capture?: { body?: unknown },
): typeof fetch {
  return (async (_url: unknown, init?: { body?: unknown }) => {
    if (capture) capture.body = init?.body;
    return new Response(JSON.stringify(data), { status: 200 });
  }) as unknown as typeof fetch;
}

async function waitUntil(
  cond: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---------------------------------------------------------------------
// normalizeVoiceRpc — the G2 pass-through regression
// ---------------------------------------------------------------------

describe("normalizeVoiceRpc", () => {
  it.each(["mint", "consult", "dispatch"] as const)(
    "passes op=%s through (G2: no silent drops for served ops)",
    (op) => {
      const f = normalizeVoiceRpc({
        rpcId: "r1",
        op,
        assistantId: 7,
        agentRoute: "main",
        chatId: 42,
        payload: { a: 1 },
      });
      expect(f).not.toBeNull();
      expect(f!.op).toBe(op);
      expect(f!.rpcId).toBe("r1");
      expect(f!.assistantId).toBe(7);
      expect(f!.chatId).toBe(42);
      expect(f!.payload).toEqual({ a: 1 });
    },
  );

  it("drops unknown ops and malformed frames", () => {
    expect(
      normalizeVoiceRpc({ rpcId: "r1", op: "reboot", payload: {} }),
    ).toBeNull();
    expect(normalizeVoiceRpc({ op: "mint" })).toBeNull(); // no rpcId
    expect(normalizeVoiceRpc(null)).toBeNull();
    expect(normalizeVoiceRpc("mint")).toBeNull();
  });

  it("tolerates string ids and missing payload", () => {
    const f = normalizeVoiceRpc({ rpcId: "r1", op: "mint", assistantId: "7" });
    expect(f).not.toBeNull();
    expect(f!.assistantId).toBe("7");
    expect(f!.chatId).toBeNull();
    expect(f!.payload).toEqual({});
    expect(f!.agentRoute).toBe("");
  });
});

// ---------------------------------------------------------------------
// mint
// ---------------------------------------------------------------------

describe("mint", () => {
  it("maps the OpenAI secret to the wire contract (contextInjected:true)", async () => {
    const capture: { body?: unknown } = {};
    const { handler, calls } = makeHarness({
      fetchImpl: okFetch(undefined, capture),
    });
    await handler.handle(
      frame({ op: "mint", payload: { recentContext: "KC: hi\nYou: hello" } }),
    );
    expect(calls.acks).toEqual(["rpc-1"]);
    expect(calls.results).toHaveLength(1);
    const { body } = calls.results[0]!;
    expect(body.ok).toBe(true);
    expect(body.payload).toMatchObject({
      provider: "openai",
      transport: "webrtc",
      clientSecret: "ek_test_secret",
      offerUrl: OFFER_URL,
      model: "gpt-realtime-2",
      voice: "marin",
      expiresAt: 1_780_000_000,
      contextInjected: true,
    });
    // The session bakes ≥1 tool (the consult tool) + persona + context —
    // the app only registers dispatch/roundtable tools when the mint
    // returned a non-empty tools array (verified frontend gotcha).
    const sent = JSON.parse(String(capture.body)) as {
      session: {
        instructions: string;
        tools: Array<{ name: string }>;
        audio: { input: { transcription: unknown; turn_detection: unknown } };
      };
    };
    expect(sent.session.tools).toHaveLength(1);
    expect(sent.session.tools[0]!.name).toBe(CONSULT_TOOL_NAME);
    expect(sent.session.instructions).toContain("You are Echo");
    expect(sent.session.instructions).toContain("KC: hi");
    expect(sent.session.audio.input.transcription).toBeTruthy();
    expect(sent.session.audio.input.turn_detection).toBeTruthy();
  });

  it("mints with the CALLER's OpenAI key from the frame, never the host env owner key", async () => {
    let authHeader = "";
    const fetchImpl = (async (
      _url: unknown,
      init?: { headers?: Record<string, string> },
    ) => {
      authHeader = init?.headers?.Authorization ?? "";
      return new Response(
        JSON.stringify({ value: "ek_test_secret", expires_at: 1_780_000_000 }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const { handler, calls } = makeHarness({
      fetchImpl,
      config: { openaiApiKey: "sk-host-owner-key" },
    });
    await handler.handle(
      frame({
        op: "mint",
        payload: { recentContext: "", openaiApiKey: "sk-caller-own-key" },
      }),
    );
    // The caller's own key is spent, not the host env owner key.
    expect(authHeader).toBe("Bearer sk-caller-own-key");
    expect(authHeader).not.toContain("sk-host-owner-key");
    expect(calls.results[0]!.body.ok).toBe(true);
  });

  it("falls back to the host env OpenAI key only when the frame carries no caller key (standalone host)", async () => {
    let authHeader = "";
    const fetchImpl = (async (
      _url: unknown,
      init?: { headers?: Record<string, string> },
    ) => {
      authHeader = init?.headers?.Authorization ?? "";
      return new Response(
        JSON.stringify({ value: "ek_test_secret", expires_at: 1_780_000_000 }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const { handler } = makeHarness({
      fetchImpl,
      config: { openaiApiKey: "sk-host-owner-key" },
    });
    await handler.handle(frame({ op: "mint", payload: { recentContext: "" } }));
    expect(authHeader).toBe("Bearer sk-host-owner-key");
  });

  it("normalizeVoiceConfig sanitizes the wire (junk dropped, speed clamped, cap applied)", () => {
    expect(normalizeVoiceConfig(undefined)).toEqual({});
    expect(normalizeVoiceConfig("cedar")).toEqual({});
    expect(normalizeVoiceConfig([])).toEqual({});
    expect(
      normalizeVoiceConfig({ voice: " Cedar ", speed: 1.2, instructions: " hi " }),
    ).toEqual({ voice: "cedar", speed: 1.2, instructions: "hi" });
    expect(normalizeVoiceConfig({ voice: "x; DROP", speed: 99 })).toEqual({
      speed: 1.5,
    });
    expect(normalizeVoiceConfig({ speed: "0.01" })).toEqual({ speed: 0.25 });
    expect(
      normalizeVoiceConfig({ instructions: "x".repeat(5000) }).instructions,
    ).toHaveLength(2000);
  });

  it("applies payload.voiceConfig — voice/speed/persona override env, echoed back", async () => {
    const capture: { body?: unknown } = {};
    const { handler, calls } = makeHarness({
      fetchImpl: okFetch(undefined, capture),
      config: { persona: "Speak like a calm pilot." },
    });
    await handler.handle(
      frame({
        op: "mint",
        payload: {
          recentContext: "KC: hi",
          voiceConfig: {
            voice: "cedar",
            speed: 1.25,
            instructions: "Dry humor, two sentences max.",
          },
        },
      }),
    );
    const sent = JSON.parse(String(capture.body)) as {
      session: {
        instructions: string;
        audio: { output: { voice: string; speed?: number } };
      };
    };
    // Applied to the OpenAI session…
    expect(sent.session.audio.output.voice).toBe("cedar");
    expect(sent.session.audio.output.speed).toBe(1.25);
    // App persona REPLACES the env persona (env is the fallback only).
    expect(sent.session.instructions).toContain("Dry humor");
    expect(sent.session.instructions).not.toContain("calm pilot");
    // …and echoed in the result so the in-call gear shows the real voice.
    expect(calls.results[0]!.body.payload).toMatchObject({
      voice: "cedar",
      speed: 1.25,
    });
  });

  it("keeps the exact pre-feature request shape without voiceConfig (env fallback)", async () => {
    const capture: { body?: unknown } = {};
    const { handler, calls } = makeHarness({
      fetchImpl: okFetch(undefined, capture),
    });
    await handler.handle(
      frame({ op: "mint", payload: { recentContext: "" } }),
    );
    const sent = JSON.parse(String(capture.body)) as {
      session: { audio: { output: Record<string, unknown> } };
    };
    expect(sent.session.audio.output).toEqual({ voice: "marin" });
    expect(calls.results[0]!.body.payload!.voice).toBe("marin");
    expect("speed" in calls.results[0]!.body.payload!).toBe(false);
  });

  it("degrades junk voiceConfig to env config, never failing the call", async () => {
    const capture: { body?: unknown } = {};
    const { handler, calls } = makeHarness({
      fetchImpl: okFetch(undefined, capture),
    });
    await handler.handle(
      frame({
        op: "mint",
        payload: { recentContext: "", voiceConfig: { voice: "!!", speed: "junk" } },
      }),
    );
    const sent = JSON.parse(String(capture.body)) as {
      session: { audio: { output: Record<string, unknown> } };
    };
    expect(sent.session.audio.output).toEqual({ voice: "marin" });
    expect(calls.results[0]!.body.ok).toBe(true);
  });

  it("normalizes a milliseconds expires_at to epoch seconds", async () => {
    const { handler, calls } = makeHarness({
      fetchImpl: okFetch({ value: "ek_x", expires_at: 1_780_000_000_000 }),
    });
    await handler.handle(frame({ op: "mint" }));
    expect(calls.results[0]!.body.payload!.expiresAt).toBe(1_780_000_000);
  });

  it("answers VOICE_NOT_CONFIGURED without an OpenAI key", async () => {
    const { handler, calls } = makeHarness({
      config: { openaiApiKey: "" },
    });
    await handler.handle(frame({ op: "mint" }));
    expect(calls.results).toHaveLength(1);
    const { body } = calls.results[0]!;
    expect(body.ok).toBe(false);
    expect(body.error!.code).toBe("VOICE_NOT_CONFIGURED");
    expect(body.error!.message).toContain("BGOS_OPENAI_API_KEY");
  });

  it("maps an OpenAI error status to a descriptive MINT_FAILED", async () => {
    const { handler, calls } = makeHarness({
      fetchImpl: (async () =>
        new Response('{"error":"bad key"}', {
          status: 401,
        })) as unknown as typeof fetch,
    });
    await handler.handle(frame({ op: "mint" }));
    const { body } = calls.results[0]!;
    expect(body.ok).toBe(false);
    expect(body.error!.code).toBe("MINT_FAILED");
    expect(body.error!.message).toContain("401");
  });

  it("fails MINT_FAILED when OpenAI returns no secret value", async () => {
    const { handler, calls } = makeHarness({ fetchImpl: okFetch({}) });
    await handler.handle(frame({ op: "mint" }));
    expect(calls.results[0]!.body.error!.code).toBe("MINT_FAILED");
  });
});

// ---------------------------------------------------------------------
// consult
// ---------------------------------------------------------------------

describe("consult", () => {
  it("runs a brain turn and returns the FIRST reply text", async () => {
    const { handler, calls } = makeHarness();
    await handler.handle(frame());
    expect(calls.results).toHaveLength(1);
    expect(calls.results[0]!.body).toEqual({
      ok: true,
      payload: { text: "Deploy is green." },
    });
    // The brain turn rode the fork dispatch with voice framing.
    expect(calls.dispatches).toHaveLength(1);
    const d = calls.dispatches[0]!;
    expect(d.agentRoute).toBe("main");
    expect(d.assistantId).toBe(7);
    expect(d.chatId).toBe(42);
    expect(d.userId).toBe("user_1");
    expect(d.text).toContain("[voice_consult]");
    expect(d.text).toContain("What is the deploy status?");
    expect(d.systemPrompt).toContain("You are Echo.");
    expect(d.systemPrompt).toContain("LIVE VOICE CALL");
  });

  it("resolves on the first text even while the turn keeps running", async () => {
    let finishTurn: () => void = () => {};
    const turnGate = new Promise<void>((r) => (finishTurn = r));
    const { handler, calls } = makeHarness({
      dispatchImpl: async (args) => {
        await args.replyHandle.sendText("Quick answer.");
        await turnGate; // turn keeps going long after the answer
      },
    });
    await handler.handle(frame());
    expect(calls.results[0]!.body.payload).toEqual({ text: "Quick answer." });
    finishTurn();
  });

  it("answers GOBOT_NOT_READY when the fork has not registered dispatch", async () => {
    const { handler, calls } = makeHarness({ dispatchImpl: null });
    await handler.handle(frame());
    expect(calls.results[0]!.body.error!.code).toBe("GOBOT_NOT_READY");
  });

  it("answers NO_AGENT_ROUTE when neither frame nor map has a route", async () => {
    const { handler, calls } = makeHarness({ route: null });
    await handler.handle(frame({ agentRoute: "" }));
    expect(calls.results[0]!.body.error!.code).toBe("NO_AGENT_ROUTE");
  });

  it("maps a brain throw to CONSULT_FAILED", async () => {
    const { handler, calls } = makeHarness({
      dispatchImpl: async () => {
        throw new Error("claude API 529");
      },
    });
    await handler.handle(frame());
    const { body } = calls.results[0]!;
    expect(body.error!.code).toBe("CONSULT_FAILED");
    expect(body.error!.message).toContain("529");
  });

  it("answers NO_REPLY when the turn ends without any text", async () => {
    const { handler, calls } = makeHarness({
      dispatchImpl: async () => {
        /* turn runs and ends silently */
      },
    });
    await handler.handle(frame());
    expect(calls.results[0]!.body.error!.code).toBe("NO_REPLY");
  });

  it("times out with a descriptive CONSULT_TIMEOUT (inner < backend cap)", async () => {
    const { handler, calls } = makeHarness({
      timing: { consultTimeoutMs: 60 },
      dispatchImpl: async () => {
        await new Promise((r) => setTimeout(r, 500));
      },
    });
    await handler.handle(frame());
    const { body } = calls.results[0]!;
    expect(body.error!.code).toBe("CONSULT_TIMEOUT");
    expect(body.error!.message).toContain("still working");
    // Sanity: the shipped default stays under the task's <40 s rule and
    // the backend's 45 s drop-late deadline.
    expect(DEFAULT_TIMING.consultTimeoutMs).toBeLessThan(40_000);
    expect(DEFAULT_TIMING.mintTimeoutMs).toBeLessThan(10_000);
  });

  it("rejects a second concurrent consult for the same assistant (AGENT_BUSY)", async () => {
    let finishTurn: () => void = () => {};
    const turnGate = new Promise<void>((r) => (finishTurn = r));
    const { handler, calls } = makeHarness({
      dispatchImpl: async (args) => {
        await turnGate;
        await args.replyHandle.sendText("done");
      },
    });
    const first = handler.handle(frame({ rpcId: "rpc-slow" }));
    await waitUntil(() => calls.dispatches.length === 1);
    await handler.handle(frame({ rpcId: "rpc-second" }));
    const second = calls.results.find((r) => r.rpcId === "rpc-second");
    expect(second!.body.error!.code).toBe("AGENT_BUSY");
    finishTurn();
    await first;
  });

  it("dedupes a re-emitted frame by rpcId (backend 1.5 s retry)", async () => {
    let finishTurn: () => void = () => {};
    const turnGate = new Promise<void>((r) => (finishTurn = r));
    const { handler, calls } = makeHarness({
      dispatchImpl: async (args) => {
        await turnGate;
        await args.replyHandle.sendText("done");
      },
    });
    const f = frame();
    const p1 = handler.handle(f);
    await waitUntil(() => calls.dispatches.length === 1);
    await handler.handle(f); // duplicate — must not start a second turn
    expect(calls.dispatches).toHaveLength(1);
    finishTurn();
    await p1;
    expect(calls.results).toHaveLength(1);
  });

  it("rejects a consult without a question (BAD_CONSULT)", async () => {
    const { handler, calls } = makeHarness();
    await handler.handle(
      frame({ payload: { callId: "c", name: CONSULT_TOOL_NAME, args: {} } }),
    );
    expect(calls.results[0]!.body.error!.code).toBe("BAD_CONSULT");
  });

  it("a failed ACK is non-fatal — the op still runs", async () => {
    const { handler, calls } = makeHarness({ failAck: true });
    await handler.handle(frame());
    expect(calls.results[0]!.body.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------
// dispatch (accept-first + detached run)
// ---------------------------------------------------------------------

function dispatchFrame(over: Partial<VoiceRpcFrame> = {}): VoiceRpcFrame {
  return frame({
    op: "dispatch",
    payload: {
      taskId: "task-9",
      callId: "call-1",
      name: "agent_dispatch",
      args: { question: "Summarize the overnight logs." },
    },
    ...over,
  });
}

describe("dispatch", () => {
  it("accepts FIRST, then posts the LAST reply text to voice-tasks", async () => {
    const { handler, calls } = makeHarness({
      dispatchImpl: async (args) => {
        await args.replyHandle.sendText("Working on it…");
        await args.replyHandle.sendText("Logs look clean; two warnings.");
      },
    });
    await handler.handle(dispatchFrame());
    // The accept must have been posted on the rpc result route.
    expect(calls.results).toHaveLength(1);
    expect(calls.results[0]!.body).toEqual({
      ok: true,
      payload: { accepted: true, taskId: "task-9" },
    });
    await waitUntil(() => calls.taskResults.length === 1);
    expect(calls.taskResults[0]!).toEqual({
      taskId: "task-9",
      body: { ok: true, payload: { text: "Logs look clean; two warnings." } },
    });
    const d = calls.dispatches[0]!;
    expect(d.text).toContain("[voice_dispatch]");
    expect(d.text).toContain("task-9");
  });

  it("answers BAD_DISPATCH when the payload has no taskId", async () => {
    const { handler, calls } = makeHarness();
    await handler.handle(
      dispatchFrame({ payload: { callId: "c", name: "agent_dispatch" } }),
    );
    expect(calls.results[0]!.body.error!.code).toBe("BAD_DISPATCH");
    expect(calls.taskResults).toHaveLength(0);
  });

  it("reports a brain failure as DISPATCH_FAILED on the voice-tasks route", async () => {
    const { handler, calls } = makeHarness({
      dispatchImpl: async () => {
        throw new Error("boom");
      },
    });
    await handler.handle(dispatchFrame());
    await waitUntil(() => calls.taskResults.length === 1);
    const { body } = calls.taskResults[0]!;
    expect(body.ok).toBe(false);
    expect(body.error!.code).toBe("DISPATCH_FAILED");
    expect(body.error!.message).toContain("boom");
  });

  it("reports NO_REPLY when the run ends without a summary", async () => {
    const { handler, calls } = makeHarness({
      dispatchImpl: async () => {},
    });
    await handler.handle(dispatchFrame());
    await waitUntil(() => calls.taskResults.length === 1);
    expect(calls.taskResults[0]!.body.error!.code).toBe("NO_REPLY");
  });

  it("dedupes detached runs by taskId across distinct rpcIds", async () => {
    let finishTurn: () => void = () => {};
    const turnGate = new Promise<void>((r) => (finishTurn = r));
    const { handler, calls } = makeHarness({
      dispatchImpl: async (args) => {
        await turnGate;
        await args.replyHandle.sendText("done");
      },
    });
    await handler.handle(dispatchFrame({ rpcId: "rpc-a" }));
    await waitUntil(() => calls.dispatches.length === 1);
    await handler.handle(dispatchFrame({ rpcId: "rpc-b" }));
    expect(calls.dispatches).toHaveLength(1); // second run never started
    finishTurn();
    await waitUntil(() => calls.taskResults.length === 1);
  });

  it("retries a failed voice-task result post once", async () => {
    const { handler, calls } = makeHarness({
      failTaskResultTimes: 1,
      dispatchImpl: async (args) => {
        await args.replyHandle.sendText("done");
      },
    });
    await handler.handle(dispatchFrame());
    await waitUntil(() => calls.taskResults.length === 1);
    expect(calls.taskResults[0]!.body.ok).toBe(true);
  });

  it("does NOT start the run when the accept post fails (no ghost runs)", async () => {
    const { handler, calls } = makeHarness({ failResult: true });
    await handler.handle(dispatchFrame());
    await new Promise((r) => setTimeout(r, 100));
    expect(calls.dispatches).toHaveLength(0);
    expect(calls.taskResults).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// builders + config
// ---------------------------------------------------------------------

describe("builders and config", () => {
  it("buildMintInstructions bakes name, persona and context", () => {
    const text = buildMintInstructions({
      agentName: "Echo",
      persona: "Dry humor.",
      recentContext: "KC: status?",
    });
    expect(text).toContain("You are Echo");
    expect(text).toContain("Dry humor.");
    expect(text).toContain("KC: status?");
    expect(text).toContain(CONSULT_TOOL_NAME);
    expect(text).toContain("agent_dispatch");
  });

  it("consult/dispatch turn texts carry the voice framing + constraints", () => {
    const consult = buildConsultTurnText({
      question: "Q?",
      context: "ctx",
      responseStyle: "one sentence",
      budgetSeconds: 30,
    });
    expect(consult).toContain("[voice_consult]");
    expect(consult).toContain("Call context: ctx");
    expect(consult).toContain("Answer style: one sentence");
    expect(consult).toContain("~30 seconds");
    const dispatch = buildDispatchTurnText({
      taskId: "t1",
      question: "Do it.",
      context: "",
    });
    expect(dispatch).toContain("[voice_dispatch]");
    expect(dispatch).toContain("task t1");
    expect(dispatch).toContain("speakable");
    expect(VOICE_TURN_SYSTEM_NOTE).toContain("no MEDIA:");
  });

  it("the baked consult tool mirrors VoiceToolCallDto args", () => {
    const tool = buildConsultToolDefinition() as {
      name: string;
      parameters: { required: string[]; properties: Record<string, unknown> };
    };
    expect(tool.name).toBe(CONSULT_TOOL_NAME);
    expect(tool.parameters.required).toEqual(["question"]);
    expect(Object.keys(tool.parameters.properties)).toEqual([
      "question",
      "context",
      "responseStyle",
    ]);
  });

  it("loadVoiceConfigFromEnv prefers BGOS_OPENAI_API_KEY and has parity defaults", () => {
    expect(
      loadVoiceConfigFromEnv({
        BGOS_OPENAI_API_KEY: "sk-a",
        OPENAI_API_KEY: "sk-b",
      }),
    ).toEqual({
      openaiApiKey: "sk-a",
      model: "gpt-realtime-2",
      voice: "marin",
      persona: "",
      requireConfirmedDispatch: false,
    });
    expect(loadVoiceConfigFromEnv({ OPENAI_API_KEY: "sk-b" }).openaiApiKey).toBe(
      "sk-b",
    );
    expect(loadVoiceConfigFromEnv({}).openaiApiKey).toBe("");
  });

  it("normalizeExpiresAtSeconds handles seconds, millis, strings, junk", () => {
    expect(normalizeExpiresAtSeconds(1_780_000_000)).toBe(1_780_000_000);
    expect(normalizeExpiresAtSeconds(1_780_000_000_000)).toBe(1_780_000_000);
    expect(normalizeExpiresAtSeconds("1780000000")).toBe(1_780_000_000);
    expect(normalizeExpiresAtSeconds("soon")).toBeNull();
    expect(normalizeExpiresAtSeconds(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------
// quick-wins prompt pack (Iris 514)
// ---------------------------------------------------------------------

describe("quick-wins prompt pack (Iris 514)", () => {
  it("mint instructions carry the truthfulness contract", () => {
    const text = buildMintInstructions({
      agentName: "Jeff",
      persona: "",
      recentContext: "",
    });
    expect(text).toContain("Truthfulness contract: NEVER invent");
    expect(text).toContain("still in progress");
  });

  it("mint instructions carry the intent-only brief rule", () => {
    const text = buildMintInstructions({
      agentName: "Jeff",
      persona: "",
      recentContext: "",
    });
    expect(text).toContain("intent and desired outcome");
    expect(text).toContain("stale mechanics mislead it");
  });

  it("consult turn text carries the continuation brief", () => {
    const text = buildConsultTurnText({
      question: "q",
      context: "",
      responseStyle: "",
      budgetSeconds: 30,
    });
    expect(text).toContain("Reuse those results");
    expect(text).toContain("re-check only what changed");
    expect(text.indexOf("Reuse those results")).toBeLessThan(
      text.indexOf("You have ~"),
    );
  });

  it("dispatch turn text carries the continuation brief", () => {
    const text = buildDispatchTurnText({
      taskId: "t1",
      question: "q",
      context: "",
    });
    expect(text).toContain("Reuse those results");
    expect(text).toContain("re-check only what changed");
    expect(text.indexOf("Reuse those results")).toBeLessThan(
      text.indexOf("Do the work now"),
    );
  });
});

// ---------------------------------------------------------------------
// confirm-before-dispatch gate (Iris G5, wave 2)
// ---------------------------------------------------------------------

describe("confirm-before-dispatch gate (Iris G5)", () => {
  it("loadVoiceConfigFromEnv reads the BGOS_REQUIRE_CONFIRMED_DISPATCH belt (default off)", () => {
    expect(loadVoiceConfigFromEnv({}).requireConfirmedDispatch).toBe(false);
    expect(
      loadVoiceConfigFromEnv({ BGOS_REQUIRE_CONFIRMED_DISPATCH: "true" })
        .requireConfirmedDispatch,
    ).toBe(true);
    expect(
      loadVoiceConfigFromEnv({ BGOS_REQUIRE_CONFIRMED_DISPATCH: "1" })
        .requireConfirmedDispatch,
    ).toBe(false);
  });

  it("gate off: an unconfirmed dispatch is accepted (back-compat)", async () => {
    const { handler, calls } = makeHarness();
    await handler.handle(dispatchFrame());
    expect(calls.results[0]!.body.ok).toBe(true);
  });

  it("gate on: an unconfirmed dispatch is rejected pre-accept with DISPATCH_UNCONFIRMED", async () => {
    const { handler, calls } = makeHarness({
      config: { requireConfirmedDispatch: true },
    });
    await handler.handle(dispatchFrame());
    expect(calls.results[0]!.body.ok).toBe(false);
    expect(calls.results[0]!.body.error!.code).toBe("DISPATCH_UNCONFIRMED");
    expect(calls.taskResults).toHaveLength(0);
    expect(calls.dispatches).toHaveLength(0);
  });

  it("gate on: confirmed:true and 'true' both pass", async () => {
    for (const confirmed of [true, "true"]) {
      const { handler, calls } = makeHarness({
        config: { requireConfirmedDispatch: true },
      });
      await handler.handle(
        dispatchFrame({
          payload: {
            taskId: "task-9",
            callId: "call-1",
            name: "agent_dispatch",
            args: { question: "Summarize the overnight logs." },
            confirmed,
          },
        }),
      );
      expect(calls.results[0]!.body.ok).toBe(true);
    }
  });

  it("mint instructions carry the propose-first contract only when voiceConfig requires it", () => {
    const on = buildMintInstructions({
      agentName: "Echo",
      persona: "",
      recentContext: "",
      requireDispatchConfirm: true,
    });
    expect(on).toContain("Dispatch confirmation is ON");
    expect(on).toContain("STAGES a proposal");
    expect(on).toContain("confirm_dispatch");
    const off = buildMintInstructions({
      agentName: "Echo",
      persona: "",
      recentContext: "",
    });
    expect(off).not.toContain("Dispatch confirmation is ON");
  });

  it("normalizeVoiceConfig picks up requireDispatchConfirm (boolean and string)", () => {
    expect(
      normalizeVoiceConfig({ requireDispatchConfirm: true })
        .requireDispatchConfirm,
    ).toBe(true);
    expect(
      normalizeVoiceConfig({ requireDispatchConfirm: "true" })
        .requireDispatchConfirm,
    ).toBe(true);
    expect(
      "requireDispatchConfirm" in normalizeVoiceConfig({ voice: "marin" }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------
// welcome-back ceremony (Iris G2, wave 2)
// ---------------------------------------------------------------------

describe("welcome-back ceremony (Iris G2)", () => {
  it("mint instructions carry the welcome-back ceremony", () => {
    const text = buildMintInstructions({
      agentName: "Echo",
      persona: "",
      recentContext: "",
    });
    expect(text).toContain("Welcome-back ceremony");
    expect(text).toContain("skip the greeting ceremony");
    expect(text).toContain("by name");
    expect(text).toContain("never a robotic");
  });
});
