#!/usr/bin/env node
import { hostname } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { BgosApi } from "./bgos-api.js";
import type { AgentCatalogEntry, PairExchangeResponse } from "./types.js";

/**
 * CLI entry point for `gobot-pair-bgos <CODE>`.
 *
 * Steps:
 *   1. POST /api/v1/integrations/pair-exchange with the user-supplied
 *      code, a derived device label (os.hostname()), and the local
 *      agent-route catalog (passed in by caller).
 *   2. Persist the raw pairing_token at ~/.gobot/secrets/bgos.json
 *      (0600 perms). Caller can hand it off to the proper secret store.
 *
 * Exit-code convention (set by the CLI wrapper):
 *   0 success
 *   1 network error
 *   2 invalid/consumed/expired code
 */

export interface PairResult {
  pairing: PairExchangeResponse;
  tokenFile: string;
}

export interface PairCliOptions {
  baseUrl: string;
  code: string;
  deviceLabel?: string;
  agentCatalog?: AgentCatalogEntry[];
  secretsDir?: string;
}

export async function pairBgos(opts: PairCliOptions): Promise<PairResult> {
  const label = opts.deviceLabel ?? `${hostname()} (Gobot)`;
  const res = await BgosApi.pairExchange(opts.baseUrl, {
    code: opts.code,
    deviceLabel: label,
    agentCatalog: opts.agentCatalog,
  });

  const secretsDir =
    opts.secretsDir ??
    join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".gobot", "secrets");
  await mkdir(secretsDir, { recursive: true });
  const tokenFile = join(secretsDir, "bgos.json");
  const payload = {
    baseUrl: opts.baseUrl.replace(/\/+$/, ""),
    pairingToken: res.pairing_token,
    pairingId: res.pairing_id,
    userId: res.user_id,
    pairedAt: new Date().toISOString(),
  };
  await writeFile(tokenFile, JSON.stringify(payload, null, 2), {
    mode: 0o600,
  });
  return { pairing: res, tokenFile };
}

const DEFAULT_BASE_URL = "https://api.brandgrowthos.ai";

function parseAgentCatalog(raw: string | undefined): AgentCatalogEntry[] | undefined {
  if (!raw) return undefined;
  const entries = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [route, name] = entry.split(":").map((p) => p.trim());
      if (!route) return null;
      return { agent_route: route, name: name || route };
    })
    .filter((a): a is AgentCatalogEntry => a !== null);
  return entries.length ? entries : undefined;
}

function takeFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx < 0) return undefined;
  const val = argv[idx + 1];
  argv.splice(idx, 2);
  return val;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const deviceLabel = takeFlag(argv, "--device-label");
  const baseUrl =
    takeFlag(argv, "--base-url") ??
    process.env.BGOS_BASE_URL ??
    DEFAULT_BASE_URL;
  const code = argv.find((a) => !a.startsWith("--"));

  if (!code) {
    process.stderr.write(
      "usage: gobot-pair-bgos <CODE> [--device-label NAME] [--base-url URL]\n",
    );
    process.exit(2);
  }

  try {
    const { pairing, tokenFile } = await pairBgos({
      baseUrl,
      code,
      deviceLabel,
      agentCatalog: parseAgentCatalog(process.env.GOBOT_AGENTS),
    });
    process.stdout.write(`Paired. Secret written to ${tokenFile}\n`);
    process.stdout.write(
      `pairing_id=${pairing.pairing_id} user_id=${pairing.user_id}\n`,
    );
    process.exit(0);
  } catch (err: unknown) {
    const e = err as { response?: { status?: number; data?: unknown }; message?: string };
    const status = e?.response?.status;
    if (status === 400 || status === 404 || status === 410) {
      process.stderr.write(
        `Pair code rejected (${status}): ${JSON.stringify(e.response?.data ?? "expired or consumed")}\n`,
      );
      process.exit(2);
    }
    process.stderr.write(`Pair failed: ${e?.message ?? String(err)}\n`);
    process.exit(1);
  }
}

// Run when invoked as a CLI (not when imported as a library).
const invokedAsCli =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  /pair-cli(?:\.[mc]?[jt]s)?$/.test(process.argv[1] ?? "");
if (invokedAsCli) {
  void main();
}
