#!/usr/bin/env node
/**
 * `gobot-bgos-reseed-commands` — force-replace the slash-command manifest
 * for every assistant bound to the local Gobot↔BGOS pairing with the
 * canonical `DEFAULT_COMMANDS` list.
 *
 * When to run:
 *   - The BGOS slash picker for the bound assistant is empty or missing
 *     commands the fork actually handles (e.g. `/track` doesn't appear).
 *   - You upgraded gobot-channel-bgos and want the new defaults pushed
 *     without waiting for an `assistant_bound` event.
 *   - You're on an older BGOS deploy where `whoami` doesn't return
 *     `command_count`, so the auto-seed never fires.
 *
 * Usage:
 *   GOBOT_BASE_URL=https://api.brandgrowthos.ai \
 *   GOBOT_PAIRING_TOKEN=$(jq -r .pairingToken ~/.gobot/secrets/bgos.json) \
 *     gobot-bgos-reseed-commands
 *
 * Or — by default — the CLI reads `~/.gobot/secrets/bgos.json` for both
 * `baseUrl` and `pairingToken`. Pass `--secrets-file <path>` to override.
 *
 * Pass `--dry-run` to print the manifest the CLI would PUT without
 * writing. Pass `--assistant <id>` (repeatable) to limit the reseed to a
 * subset of assistants.
 *
 * Exit codes:
 *   0  all assistants reseeded successfully
 *   1  network / token error (no assistants reseeded)
 *   2  partial failure — one or more assistants failed; the rest succeeded
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { BGOSAdapter } from "./adapter.js";
import { DEFAULT_COMMANDS } from "./default-commands.js";
import type { BgosConfig } from "./adapter.js";

interface ResolvedConfig {
  baseUrl: string;
  pairingToken: string;
  secretsFile: string | null;
}

const SECRETS_FILE_DEFAULT = join(
  process.env.HOME ?? process.env.USERPROFILE ?? ".",
  ".gobot",
  "secrets",
  "bgos.json",
);

async function loadSecrets(path: string): Promise<{
  baseUrl?: string;
  pairingToken?: string;
} | null> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : undefined,
      pairingToken:
        typeof parsed.pairingToken === "string"
          ? parsed.pairingToken
          : undefined,
    };
  } catch {
    return null;
  }
}

function takeFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx < 0) return undefined;
  const val = argv[idx + 1];
  argv.splice(idx, 2);
  return val;
}

function takeFlagAll(argv: string[], flag: string): string[] {
  const out: string[] = [];
  while (true) {
    const v = takeFlag(argv, flag);
    if (v === undefined) break;
    out.push(v);
  }
  return out;
}

function takeBool(argv: string[], flag: string): boolean {
  const idx = argv.indexOf(flag);
  if (idx < 0) return false;
  argv.splice(idx, 1);
  return true;
}

async function resolveConfig(argv: string[]): Promise<ResolvedConfig> {
  const secretsFile = takeFlag(argv, "--secrets-file") ?? SECRETS_FILE_DEFAULT;
  const cliBaseUrl = takeFlag(argv, "--base-url");
  const cliToken = takeFlag(argv, "--pairing-token");

  const secrets = await loadSecrets(secretsFile);

  const baseUrl =
    cliBaseUrl ??
    process.env.GOBOT_BASE_URL ??
    process.env.BGOS_BASE_URL ??
    secrets?.baseUrl ??
    "https://api.brandgrowthos.ai";
  const pairingToken =
    cliToken ??
    process.env.GOBOT_PAIRING_TOKEN ??
    process.env.BGOS_PAIRING_TOKEN ??
    secrets?.pairingToken ??
    "";

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    pairingToken,
    secretsFile: secrets ? secretsFile : null,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = takeBool(argv, "--dry-run");
  const assistantFlags = takeFlagAll(argv, "--assistant");
  const cfg = await resolveConfig(argv);

  if (!cfg.pairingToken) {
    process.stderr.write(
      "gobot-bgos-reseed-commands: no pairing token. Provide via\n" +
        "  --pairing-token <token>, GOBOT_PAIRING_TOKEN, or\n" +
        `  ${SECRETS_FILE_DEFAULT}\n`,
    );
    process.exit(1);
  }

  if (dryRun) {
    process.stdout.write(
      `[dry-run] would PUT ${DEFAULT_COMMANDS.length} commands ` +
        `to ${cfg.baseUrl}/api/v1/integrations/assistants/<id>/commands:\n`,
    );
    for (const c of DEFAULT_COMMANDS) {
      process.stdout.write(
        `  /${c.command} — ${c.description} (order=${c.order_index})\n`,
      );
    }
    process.exit(0);
  }

  const config: BgosConfig = {
    baseUrl: cfg.baseUrl,
    pairingToken: cfg.pairingToken,
    // We only need REST + whoami; mark seed mode "never" so
    // construction doesn't auto-seed if the user later starts the
    // adapter from this same config.
    commandSeedMode: "never",
  };

  const adapter = new BGOSAdapter(config);
  const assistantIds = assistantFlags
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n));
  const results = await adapter.reseedAllCommands(
    assistantIds.length ? assistantIds : undefined,
  );

  let okCount = 0;
  let failCount = 0;
  for (const r of results) {
    if (r.ok) {
      okCount += 1;
      process.stdout.write(
        `✔ assistant=${r.assistantId} reseeded ${DEFAULT_COMMANDS.length} commands\n`,
      );
    } else {
      failCount += 1;
      process.stderr.write(
        `✘ assistant=${r.assistantId} failed: ${r.error ?? "unknown"}\n`,
      );
    }
  }

  if (okCount === 0) {
    process.exit(1);
  }
  if (failCount > 0) {
    process.exit(2);
  }
  process.exit(0);
}

const invokedAsCli =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  /reseed-cli(?:\.[mc]?[jt]s)?$/.test(process.argv[1] ?? "");
if (invokedAsCli) {
  void main();
}

export { main as runReseedCli };
