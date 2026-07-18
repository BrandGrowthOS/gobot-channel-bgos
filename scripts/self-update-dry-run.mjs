import { AutoUpdateController } from "../dist/self-update.js";

const controller = new AutoUpdateController({
  checkoutDir: process.cwd(),
  expectedPackageName: "gobot-channel-bgos",
});

const result = await controller.dryRunCheck();
if (result.decision === "check-failed") process.exitCode = 1;
