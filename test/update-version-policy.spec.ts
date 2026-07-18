import { describe, expect, it } from "vitest";

import {
  candidateSatisfiesForkPluginConstraint,
  parseExactStableNpmVersion,
  parseForkPluginConstraint,
} from "../src/update-version-policy.js";

describe("exact stable npm versions", () => {
  it("accepts canonical exact stable versions", () => {
    expect(parseExactStableNpmVersion("0.0.0")).toEqual({
      major: 0,
      minor: 0,
      patch: 0,
    });
    expect(parseExactStableNpmVersion("12.34.56")).toEqual({
      major: 12,
      minor: 34,
      patch: 56,
    });
  });

  it.each([
    "",
    "v1.2.3",
    "^1.2.3",
    "~1.2.3",
    ">=1.2.3",
    "1.2.x",
    "1.2",
    "1.2.3-rc.1",
    "1.2.3+build.1",
    "01.2.3",
    "1.02.3",
    "1.2.03",
    " 1.2.3",
    "1.2.3 ",
    "latest",
  ])("rejects unsafe candidate spec %s", (value) => {
    expect(parseExactStableNpmVersion(value)).toBeNull();
  });
});

describe("fork plugin constraints", () => {
  it("accepts only exact and caret stable constraints", () => {
    expect(parseForkPluginConstraint("2.4.6")).toEqual({
      kind: "exact",
      version: { major: 2, minor: 4, patch: 6 },
    });
    expect(parseForkPluginConstraint("^2.4.6")).toEqual({
      kind: "caret",
      minimum: { major: 2, minor: 4, patch: 6 },
      upperExclusive: { major: 3, minor: 0, patch: 0 },
    });

    for (const value of [
      "~2.4.6",
      ">=2.4.6",
      "2.x",
      "^v2.4.6",
      "^2.4.6-rc.1",
      "^ 2.4.6",
      "^^2.4.6",
    ]) {
      expect(parseForkPluginConstraint(value)).toBeNull();
    }
  });

  it("requires equality for an exact constraint", () => {
    const constraint = parseForkPluginConstraint("1.2.3");
    expect(constraint).not.toBeNull();
    if (!constraint) return;

    expect(candidateSatisfiesForkPluginConstraint("1.2.3", constraint)).toBe(
      true,
    );
    expect(candidateSatisfiesForkPluginConstraint("1.2.4", constraint)).toBe(
      false,
    );
    expect(candidateSatisfiesForkPluginConstraint("^1.2.3", constraint)).toBe(
      false,
    );
  });

  it("uses the next major as the caret ceiling above major zero", () => {
    const constraint = parseForkPluginConstraint("^1.2.3");
    expect(constraint).not.toBeNull();
    if (!constraint) return;

    expect(candidateSatisfiesForkPluginConstraint("1.2.3", constraint)).toBe(
      true,
    );
    expect(candidateSatisfiesForkPluginConstraint("1.99.99", constraint)).toBe(
      true,
    );
    expect(candidateSatisfiesForkPluginConstraint("2.0.0", constraint)).toBe(
      false,
    );
    expect(candidateSatisfiesForkPluginConstraint("1.2.2", constraint)).toBe(
      false,
    );
  });

  it("uses the next minor as the caret ceiling for major zero", () => {
    const constraint = parseForkPluginConstraint("^0.15.0");
    expect(constraint).toEqual({
      kind: "caret",
      minimum: { major: 0, minor: 15, patch: 0 },
      upperExclusive: { major: 0, minor: 16, patch: 0 },
    });
    if (!constraint) return;

    expect(candidateSatisfiesForkPluginConstraint("0.15.0", constraint)).toBe(
      true,
    );
    expect(candidateSatisfiesForkPluginConstraint("0.15.99", constraint)).toBe(
      true,
    );
    expect(candidateSatisfiesForkPluginConstraint("0.16.0", constraint)).toBe(
      false,
    );
  });

  it("uses the next patch as the caret ceiling below 0.1.0", () => {
    const constraint = parseForkPluginConstraint("^0.0.3");
    expect(constraint).toEqual({
      kind: "caret",
      minimum: { major: 0, minor: 0, patch: 3 },
      upperExclusive: { major: 0, minor: 0, patch: 4 },
    });
    if (!constraint) return;

    expect(candidateSatisfiesForkPluginConstraint("0.0.3", constraint)).toBe(
      true,
    );
    expect(candidateSatisfiesForkPluginConstraint("0.0.4", constraint)).toBe(
      false,
    );
    expect(candidateSatisfiesForkPluginConstraint("0.0.2", constraint)).toBe(
      false,
    );
  });
});
