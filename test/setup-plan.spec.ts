import { describe, expect, it } from "vitest";

import { planStages, type EnvFacts } from "../src/setup/plan.js";

const fresh: EnvFacts = {
  platform: "darwin",
  installDirExists: false,
  installDirIsGitRepo: false,
  hookPresent: false,
  vendorInstalled: false,
  secretsValid: false,
  supervisorPresent: false,
  hasSetupLaunchdScript: false,
  competitorCount: 0,
};

function stage(stages: ReturnType<typeof planStages>, name: string) {
  return stages.find((s) => s.stage === name)!;
}

describe("planStages", () => {
  it("plans a full fresh install in order", () => {
    const stages = planStages(fresh, { hasCode: true });
    expect(stages.map((s) => s.stage)).toEqual([
      "detect",
      "scan-competitors",
      "acquire-source",
      "install-deps",
      "pair",
      "write-env",
      "supervisor",
      "verify",
    ]);
    expect(stage(stages, "acquire-source").action).toBe("run");
    expect(stage(stages, "acquire-source").reason).toContain("clone upstream");
    expect(stage(stages, "supervisor").reason).toContain("launchd");
  });

  it("skips acquire-source when the hook is already applied", () => {
    const stages = planStages({ ...fresh, hookPresent: true }, { hasCode: true });
    expect(stage(stages, "acquire-source").action).toBe("skip");
  });

  it("skips pairing when a valid secrets file exists (idempotent re-run)", () => {
    const stages = planStages(
      { ...fresh, secretsValid: true },
      { hasCode: false },
    );
    expect(stage(stages, "pair").action).toBe("skip");
  });

  it("marks pair as needing a code when unpaired and no code supplied", () => {
    const stages = planStages(fresh, { hasCode: false });
    expect(stage(stages, "pair").action).toBe("run");
    expect(stage(stages, "pair").reason).toContain("needs a pair code");
  });

  it("reloads the supervisor when already present and reuses fork setup:launchd", () => {
    const stages = planStages(
      { ...fresh, supervisorPresent: true, hasSetupLaunchdScript: true },
      { hasCode: true },
    );
    expect(stage(stages, "supervisor").action).toBe("reload");
    expect(stage(stages, "supervisor").reason).toContain("setup:launchd");
  });

  it("uses systemd on linux", () => {
    const stages = planStages({ ...fresh, platform: "linux" }, { hasCode: true });
    expect(stage(stages, "supervisor").reason).toContain("systemd");
  });
});
