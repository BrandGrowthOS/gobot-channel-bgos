/**
 * Pure stage planning. No IO.
 *
 * Given observed facts about the host, decide which of the fixed setup stages
 * run, reload, or skip. The shell executes the plan; keeping the decision here
 * makes idempotent re-runs testable without touching the machine.
 */
export type StageName =
  | "detect"
  | "scan-competitors"
  | "acquire-source"
  | "install-deps"
  | "pair"
  | "write-env"
  | "supervisor"
  | "verify";

export type StageAction = "run" | "reload" | "skip";

export interface Stage {
  stage: StageName;
  action: StageAction;
  reason: string;
}

export interface EnvFacts {
  platform: string;
  installDirExists: boolean;
  installDirIsGitRepo: boolean;
  /** src/adapters/bgos/loader.ts already present in the install dir. */
  hookPresent: boolean;
  /** node_modules/gobot-channel-bgos already resolved in the install dir. */
  vendorInstalled: boolean;
  /** ~/.gobot/secrets/bgos.json exists with a plausible token. */
  secretsValid: boolean;
  /** launchd label / systemd unit already loaded. */
  supervisorPresent: boolean;
  /** Target package.json has a setup:launchd script (full private fork). */
  hasSetupLaunchdScript: boolean;
  competitorCount: number;
}

export function planStages(
  facts: EnvFacts,
  opts: { hasCode: boolean },
): Stage[] {
  const stages: Stage[] = [];

  stages.push({ stage: "detect", action: "run", reason: "inspect host" });

  stages.push({
    stage: "scan-competitors",
    action: "run",
    reason:
      facts.competitorCount > 0
        ? `${facts.competitorCount} competing poller(s) found`
        : "no competing pollers",
  });

  if (facts.hookPresent) {
    stages.push({
      stage: "acquire-source",
      action: "skip",
      reason: "BGOS hook already applied",
    });
  } else if (facts.installDirExists && facts.installDirIsGitRepo) {
    stages.push({
      stage: "acquire-source",
      action: "run",
      reason: "apply patch to existing clone",
    });
  } else {
    stages.push({
      stage: "acquire-source",
      action: "run",
      reason: "clone configured upstream and verify BGOS hook",
    });
  }

  stages.push({
    stage: "install-deps",
    action: "run",
    reason: facts.vendorInstalled
      ? "ensure gobot-channel-bgos is latest"
      : "install deps + gobot-channel-bgos",
  });

  if (facts.secretsValid) {
    stages.push({
      stage: "pair",
      action: "skip",
      reason: "already paired (valid secrets file)",
    });
  } else {
    stages.push({
      stage: "pair",
      action: "run",
      reason: opts.hasCode ? "pair with supplied code" : "needs a pair code",
    });
  }

  stages.push({
    stage: "write-env",
    action: "run",
    reason: "write managed GOBOT env block",
  });

  stages.push({
    stage: "supervisor",
    action: facts.supervisorPresent ? "reload" : "run",
    reason:
      facts.platform === "darwin"
        ? "install package-owned launchd wrapper"
        : facts.platform === "linux"
          ? "install package-owned systemd wrapper"
          : "manual supervisor (unsupported platform)",
  });

  stages.push({
    stage: "verify",
    action: "run",
    reason: "whoami + catalog probe",
  });

  return stages;
}
