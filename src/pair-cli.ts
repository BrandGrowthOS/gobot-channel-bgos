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
