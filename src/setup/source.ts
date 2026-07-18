import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_UPSTREAM_BRANCH,
  DEFAULT_UPSTREAM_REPO,
} from "./args.js";

export const BGOS_HOOK_RELATIVE_PATH = join(
  "src",
  "adapters",
  "bgos",
  "loader.ts",
);

export function hasBgosHook(installDir: string): boolean {
  return existsSync(join(installDir, BGOS_HOOK_RELATIVE_PATH));
}

export type PatchDecision = "skip" | "apply";

export function decidePatchAfterAcquire(installDir: string): PatchDecision {
  return hasBgosHook(installDir) ? "skip" : "apply";
}

export function buildCloneArgs(
  upstreamRepo: string,
  installDir: string,
): string[] {
  return upstreamRepo === DEFAULT_UPSTREAM_REPO
    ? [
        "clone",
        "--branch",
        DEFAULT_UPSTREAM_BRANCH,
        "--single-branch",
        upstreamRepo,
        installDir,
      ]
    : ["clone", upstreamRepo, installDir];
}
