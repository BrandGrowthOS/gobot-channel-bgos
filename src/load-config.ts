import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadConfigFromEnv, loadConfigFromPluginCfg } from "./config.js";
import type { CatalogAgent } from "./catalog-sync.js";
import type { PluginConfig } from "./types.js";

export interface LoadedConfig extends PluginConfig {
  agents?: CatalogAgent[];
}

interface SecretsFile {
  baseUrl?: string;
  pairingToken?: string;
}

function resolveGobotHome(): string {
  const fromEnv = process.env.GOBOT_HOME?.trim();
  if (fromEnv) {
    if (fromEnv.startsWith("~")) {
      return join(homedir(), fromEnv.slice(1));
    }
    return fromEnv;
  }
  return join(homedir(), ".gobot");
}

function readSecrets(): SecretsFile | null {
  const path = join(resolveGobotHome(), "secrets", "bgos.json");
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as SecretsFile;
    if (parsed?.pairingToken && parsed.pairingToken.length >= 20) {
      return parsed;
    }
  } catch {
    // file missing / unreadable — fall through to env
  }
  return null;
}

function parseAgents(raw: string | undefined): CatalogAgent[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [route, name] = entry.split(":").map((p) => p.trim());
      if (!route) return null;
      return { route, name: name || route } as CatalogAgent;
    })
    .filter((a): a is CatalogAgent => a !== null);
}

/**
 * Load BGOS plugin config from (in order of precedence):
 *   1. `~/.gobot/secrets/bgos.json` (written by `gobot-pair-bgos`)
 *   2. `BGOS_PAIRING_TOKEN` env var
 * Plus optional agent catalog from `GOBOT_AGENTS=route:Name,route:Name,...`.
 *
 * Throws if neither secrets file nor env var supplies a valid pairing token.
 */
export function loadConfig(): LoadedConfig {
  const secrets = readSecrets();
  let base: PluginConfig;
  if (secrets?.pairingToken) {
    base = loadConfigFromPluginCfg({
      pairingToken: secrets.pairingToken,
      baseUrl: secrets.baseUrl,
    });
  } else {
    base = loadConfigFromEnv();
  }
  const agents = parseAgents(process.env.GOBOT_AGENTS);
  return { ...base, agents };
}
