import { describe, expect, it } from "vitest";

import {
  BOARDS_LOOP_GUARD_LIMIT,
  BOARDS_MAX_BLOCKS,
  BOARDS_OPS,
  BOARDS_RESULT_HEADER,
  buildResultTurn,
  parseBoardsBlocks,
  planRequest,
  type BoardsCallResult,
  type BoardsRequest,
} from "../src/boards-marker.js";

/**
 * Pure functions for the [[BGOS_BOARDS]] marker round trip (Agent Boards on
 * the Gobot channel). A faithful port of the Hermes suite
 * (hermes-channel-bgos/tests/test_boards_marker.py): these tests pin the
 * protocol's behaviour, not its wording:
 *
 * - a well formed block parses into a BoardsRequest and is stripped;
 * - a malformed block becomes a BoardsParseError and is STILL stripped (the
 *   user must never see marker syntax, and silence would strand the agent);
 * - a denial from the backend is passed through verbatim in the result turn;
 * - a result is correlated to the request that asked for it by reqId.
 */

function block(payload: unknown): string {
  return `[[BGOS_BOARDS]]${JSON.stringify(payload)}[[/BGOS_BOARDS]]`;
}

describe("parseBoardsBlocks", () => {
  it("leaves text without the marker untouched", () => {
    // The overwhelmingly common case: a normal reply must pass through
    // unchanged, with nothing parsed and nothing to report.
    const text = "Just a normal reply, no boards involved.";
    const { cleanedText, requests, errors } = parseBoardsBlocks(text);
    expect(cleanedText).toBe(text);
    expect(requests).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("parses and strips a well formed query block", () => {
    const text =
      "Let me check the board.\n" +
      block({ op: "query", board: "Tasks", reqId: "q1", limit: 20 });
    const { cleanedText, requests, errors } = parseBoardsBlocks(text);
    expect(cleanedText).toBe("Let me check the board.");
    expect(errors).toEqual([]);
    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.op).toBe("query");
    expect(req.reqId).toBe("q1");
    expect(req.args.board).toBe("Tasks");
    expect(req.args.limit).toBe(20);
    expect(cleanedText).not.toContain("BGOS_BOARDS");
  });

  it("mints a reqId when the agent omits one", () => {
    // Correlation must survive an agent that forgot reqId: the adapter
    // mints one so the result section is still attributable.
    const { requests } = parseBoardsBlocks(block({ op: "list" }));
    expect(requests).toHaveLength(1);
    expect(requests[0]!.reqId).toMatch(/^b-[0-9a-f]{8}$/);
  });

  it("treats invalid JSON as an error and still strips the block", () => {
    const text = "Before\n[[BGOS_BOARDS]]{not json}[[/BGOS_BOARDS]]\nAfter";
    const { cleanedText, requests, errors } = parseBoardsBlocks(text);
    expect(requests).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(cleanedText).not.toContain("BGOS_BOARDS");
    expect(cleanedText).toContain("Before");
    expect(cleanedText).toContain("After");
  });

  it("treats an unknown op as an error", () => {
    const { requests, errors } = parseBoardsBlocks(
      block({ op: "drop_table", board: "Tasks" }),
    );
    expect(requests).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("drop_table");
  });

  it("treats a missing required field as an error", () => {
    // update needs board, row and cells; leaving row out must not plan a
    // REST call that would 404 confusingly.
    const { requests, errors } = parseBoardsBlocks(
      block({ op: "update", board: "Tasks", cells: { status: "done" } }),
    );
    expect(requests).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("row");
  });

  it("truncates beyond the max block count with errors", () => {
    const text = Array.from({ length: BOARDS_MAX_BLOCKS + 2 }, (_, i) =>
      block({ op: "list", reqId: `r${i}` }),
    ).join("\n");
    const { cleanedText, requests, errors } = parseBoardsBlocks(text);
    expect(requests).toHaveLength(BOARDS_MAX_BLOCKS);
    expect(errors).toHaveLength(2);
    expect(cleanedText).not.toContain("BGOS_BOARDS");
  });

  it("leaves a code fenced example intact", () => {
    // Documenting the convention to the user must not fire a real call,
    // same discipline as the Hermes MEDIA: parser.
    const fenced =
      "Here is the syntax:\n```\n" +
      block({ op: "list" }) +
      "\n```\nNo call intended.";
    const { cleanedText, requests, errors } = parseBoardsBlocks(fenced);
    expect(requests).toEqual([]);
    expect(errors).toEqual([]);
    expect(cleanedText).toContain("[[BGOS_BOARDS]]");
  });

  it("coerces a non string reqId", () => {
    const { requests } = parseBoardsBlocks(block({ op: "list", reqId: 7 }));
    expect(requests[0]!.reqId).toBe("7");
  });

  it("treats a non object payload as an error", () => {
    const { requests, errors } = parseBoardsBlocks(
      "[[BGOS_BOARDS]][1, 2, 3][[/BGOS_BOARDS]]",
    );
    expect(requests).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});

describe("planRequest", () => {
  function plan(op: string, args: Record<string, unknown> = {}) {
    const req: BoardsRequest = { reqId: "r", op, args };
    return planRequest(req);
  }

  it("keeps the twelve ops exactly the Claude roster", () => {
    expect(new Set(BOARDS_OPS)).toEqual(
      new Set([
        "list",
        "describe",
        "create",
        "update_schema",
        "query",
        "get_row",
        "insert",
        "update",
        "attach",
        "search",
        "changes",
        "grant",
      ]),
    );
  });

  it("plans list", () => {
    const p = plan("list");
    expect([p.method, p.path]).toEqual(["GET", ""]);
    expect(p.params).toEqual({ format: "markdown" });
    expect(p.kind).toBe("rest");
  });

  it("plans describe", () => {
    const p = plan("describe", { board: "Tasks" });
    expect([p.method, p.path]).toEqual(["GET", "/Tasks/describe"]);
    expect(p.params).toEqual({ format: "markdown" });
  });

  it("url quotes the board segment", () => {
    const p = plan("describe", { board: "Q3 Roadmap" });
    expect(p.path).toBe("/Q3%20Roadmap/describe");
  });

  it("plans create", () => {
    const p = plan("create", {
      name: "Bugs",
      fields: [{ label: "Title", type: "text" }],
    });
    expect([p.method, p.path]).toEqual(["POST", ""]);
    expect(p.json).toEqual({
      name: "Bugs",
      fields: [{ label: "Title", type: "text" }],
    });
  });

  it("plans query with the markdown format default", () => {
    const p = plan("query", { board: "Tasks", limit: 10 });
    expect([p.method, p.path]).toEqual(["POST", "/Tasks/rows/query"]);
    expect(p.params).toEqual({ format: "markdown" });
    expect(p.json).toEqual({ limit: 10 });
  });

  it("honors json format on query", () => {
    const p = plan("query", { board: "Tasks", format: "json" });
    expect(p.params).toEqual({ format: "json" });
    // format is a transport concern, never part of the body.
    expect(p.json ?? {}).not.toHaveProperty("format");
  });

  it("plans get_row", () => {
    const p = plan("get_row", { board: "Tasks", row: "ab12cd34" });
    expect([p.method, p.path]).toEqual(["GET", "/Tasks/rows/ab12cd34"]);
    expect(p.params).toEqual({ format: "markdown" });
  });

  it("plans insert", () => {
    const p = plan("insert", { board: "Tasks", cells: { title: "x" } });
    expect([p.method, p.path]).toEqual(["POST", "/Tasks/rows"]);
    expect(p.json).toEqual({ cells: { title: "x" } });
  });

  it("plans update", () => {
    const p = plan("update", {
      board: "Tasks",
      row: "ab12cd34",
      cells: { status: "done" },
    });
    expect([p.method, p.path]).toEqual(["PATCH", "/Tasks/rows/ab12cd34"]);
    expect(p.json).toEqual({ cells: { status: "done" } });
  });

  it("plans search", () => {
    const p = plan("search", { board: "Tasks", query: "stale rows", limit: 5 });
    expect([p.method, p.path]).toEqual(["POST", "/Tasks/search"]);
    expect(p.json).toEqual({ query: "stale rows", limit: 5 });
    expect(p.params).toEqual({ format: "markdown" });
  });

  it("plans changes", () => {
    const p = plan("changes", { board: "Tasks", since: "41" });
    expect([p.method, p.path]).toEqual(["GET", "/Tasks/changes"]);
    expect(p.params).toEqual({ format: "markdown", since: "41" });
  });

  it("plans grant", () => {
    const p = plan("grant", { board: "Tasks", assistantId: 944, role: "read" });
    expect([p.method, p.path]).toEqual(["POST", "/Tasks/grants"]);
    expect(p.json).toEqual({ assistantId: 944, role: "read" });
    // Writes have no format knob; nothing to ask for.
    expect(p.params).toBeNull();
  });

  it("plans update_schema add_field", () => {
    const p = plan("update_schema", {
      board: "Tasks",
      action: "add_field",
      field: { label: "Owner", type: "text" },
    });
    expect([p.method, p.path]).toEqual(["POST", "/Tasks/fields"]);
    expect(p.json).toEqual({ label: "Owner", type: "text" });
  });

  it("plans update_schema update_field", () => {
    const p = plan("update_schema", {
      board: "Tasks",
      action: "update_field",
      fieldKey: "owner",
      field: { label: "Assignee" },
    });
    expect([p.method, p.path]).toEqual(["PATCH", "/Tasks/fields/owner"]);
    expect(p.json).toEqual({ label: "Assignee" });
  });

  it("plans update_schema delete_field", () => {
    const p = plan("update_schema", {
      board: "Tasks",
      action: "delete_field",
      fieldKey: "owner",
    });
    expect([p.method, p.path]).toEqual(["DELETE", "/Tasks/fields/owner"]);
    expect(p.json).toBeNull();
  });

  it("plans attach as a sentinel", () => {
    // The orchestrator, not the REST lane, executes attach (file read,
    // inline or presigned upload); the plan only flags it.
    const p = plan("attach", {
      board: "Tasks",
      row: "ab12cd34",
      path: "/tmp/report.pdf",
    });
    expect(p.kind).toBe("attach");
  });
});

describe("parse validates against plan", () => {
  // Required-field validation happens at parse time so a bad block never
  // reaches the REST lane.
  it.each([
    [{ op: "describe" }, "board"],
    [{ op: "create" }, "name"],
    [{ op: "query" }, "board"],
    [{ op: "get_row", board: "T" }, "row"],
    [{ op: "insert", board: "T" }, "cells"],
    [{ op: "attach", board: "T", row: "r" }, "path"],
    [{ op: "search", board: "T" }, "query"],
    [{ op: "changes" }, "board"],
    [{ op: "grant", board: "T", role: "read" }, "assistantId"],
    [{ op: "update_schema", board: "T" }, "action"],
  ])("missing field yields a parse error: %j", (payload, missing) => {
    const { requests, errors } = parseBoardsBlocks(block(payload));
    expect(requests).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain(missing);
  });

  it("update_schema field must be an object", () => {
    // A string field must fail at parse time with the real problem, never
    // surface later as a misleading transport_error (Hermes review finding
    // 2026-08-03).
    const { requests, errors } = parseBoardsBlocks(
      block({
        op: "update_schema",
        board: "Tasks",
        action: "add_field",
        field: "Status",
      }),
    );
    expect(requests).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("field");
    expect(errors[0]!.message).toContain("object");
  });

  it("update_schema unknown action is an error", () => {
    const { requests, errors } = parseBoardsBlocks(
      block({ op: "update_schema", board: "Tasks", action: "drop_field" }),
    );
    expect(requests).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("drop_field");
  });

  it("update_schema prototype-chain action names are unknown actions", () => {
    // `"toString" in SCHEMA_ACTIONS` is true via the prototype chain; an
    // own-property check must reject it at parse time like Python does,
    // instead of letting planRequest blow up into a misleading
    // transport_error (code review finding 2026-08-03).
    for (const action of ["toString", "constructor", "hasOwnProperty"]) {
      const { requests, errors } = parseBoardsBlocks(
        block({ op: "update_schema", board: "Tasks", action }),
      );
      expect(requests).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toContain(action);
      expect(errors[0]!.message).toContain("unknown update_schema action");
    }
  });
});

describe("buildResultTurn", () => {
  function result(partial: Partial<BoardsCallResult>): BoardsCallResult {
    return {
      reqId: "r",
      op: "list",
      ok: true,
      status: 200,
      body: {},
      ...partial,
    };
  }

  it("opens with the provenance header", () => {
    const turn = buildResultTurn([
      result({ reqId: "q1", op: "list", body: { markdown: "| Board |" } }),
    ]);
    expect(turn.startsWith(BOARDS_RESULT_HEADER)).toBe(true);
  });

  it("carries a markdown body verbatim on an ok result", () => {
    const markdown = "| key | Title |\n| --- | --- |\n| ab12cd34 | Fix login |";
    const turn = buildResultTurn([
      result({ reqId: "q1", op: "query", body: { markdown } }),
    ]);
    expect(turn).toContain("reqId=q1 op=query ok");
    expect(turn).toContain(markdown);
  });

  it("passes a denial body through verbatim", () => {
    // The backend's denial bodies are a leak-proof contract; the result
    // turn must carry them byte for byte, never a paraphrase.
    const body = {
      error: "not_found_board",
      message: "No board by that name is visible to you.",
    };
    const turn = buildResultTurn([
      result({ reqId: "w2", op: "update", ok: false, status: 404, body }),
    ]);
    expect(turn).toContain("reqId=w2 op=update error status=404");
    expect(turn).toContain(JSON.stringify(body));
  });

  it("correlates each result to its own request in order", () => {
    // Two results in one turn: each body must sit under ITS reqId header,
    // in request order.
    const turn = buildResultTurn([
      result({ reqId: "a", op: "query", body: { markdown: "ALPHA-ROWS" } }),
      result({
        reqId: "b",
        op: "get_row",
        ok: false,
        status: 403,
        body: { error: "forbidden_tool", message: "read only" },
      }),
    ]);
    const aAt = turn.indexOf("reqId=a op=query ok");
    const alphaAt = turn.indexOf("ALPHA-ROWS");
    const bAt = turn.indexOf("reqId=b op=get_row error status=403");
    expect(aAt).toBeGreaterThanOrEqual(0);
    expect(alphaAt).toBeGreaterThan(aAt);
    expect(bAt).toBeGreaterThan(alphaAt);
  });

  it("renders a plain string body as text", () => {
    const turn = buildResultTurn([
      result({ reqId: "s", op: "describe", body: "plain text answer" }),
    ]);
    expect(turn).toContain("plain text answer");
  });

  it("keeps the loop guard limit sane", () => {
    expect(BOARDS_LOOP_GUARD_LIMIT).toBeGreaterThan(1);
    expect(BOARDS_LOOP_GUARD_LIMIT).toBeLessThanOrEqual(20);
  });
});
