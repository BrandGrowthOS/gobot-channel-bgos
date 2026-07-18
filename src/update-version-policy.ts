export interface StableNpmVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export type ForkPluginConstraint =
  | {
      readonly kind: "exact";
      readonly version: StableNpmVersion;
    }
  | {
      readonly kind: "caret";
      readonly minimum: StableNpmVersion;
      readonly upperExclusive: StableNpmVersion;
    };

const EXACT_STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseExactStableNpmVersion(
  value: string,
): StableNpmVersion | null {
  const match = EXACT_STABLE_VERSION.exec(value);
  if (!match) return null;

  const version = {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
  if (!Object.values(version).every(Number.isSafeInteger)) return null;
  return version;
}

function caretUpperBound(version: StableNpmVersion): StableNpmVersion {
  if (version.major > 0) {
    return { major: version.major + 1, minor: 0, patch: 0 };
  }
  if (version.minor > 0) {
    return { major: 0, minor: version.minor + 1, patch: 0 };
  }
  return { major: 0, minor: 0, patch: version.patch + 1 };
}

export function parseForkPluginConstraint(
  value: string,
): ForkPluginConstraint | null {
  const caret = value.startsWith("^");
  const version = parseExactStableNpmVersion(caret ? value.slice(1) : value);
  if (!version) return null;

  if (!caret) return { kind: "exact", version };
  const upperExclusive = caretUpperBound(version);
  if (!Object.values(upperExclusive).every(Number.isSafeInteger)) return null;
  return { kind: "caret", minimum: version, upperExclusive };
}

function compareVersions(
  left: StableNpmVersion,
  right: StableNpmVersion,
): number {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  return 0;
}

export function candidateSatisfiesForkPluginConstraint(
  candidateValue: string,
  constraint: ForkPluginConstraint,
): boolean {
  const candidate = parseExactStableNpmVersion(candidateValue);
  if (!candidate) return false;

  if (constraint.kind === "exact") {
    return compareVersions(candidate, constraint.version) === 0;
  }
  return (
    compareVersions(candidate, constraint.minimum) >= 0 &&
    compareVersions(candidate, constraint.upperExclusive) < 0
  );
}
