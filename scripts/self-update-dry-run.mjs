import { AutoUpdateController } from "../dist/self-update.js";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const checkoutDir = resolve(
  process.env.GOBOT_INSTALL_DIR || process.cwd(),
);
const manifest = JSON.parse(
  readFileSync(join(checkoutDir, "package.json"), "utf8"),
);
if (typeof manifest.name !== "string") {
  throw new Error("dry-run checkout package name is missing");
}

process.stdout.write(
  `[gobot-channel-bgos] auto-update dry-run checkout=${checkoutDir}\n`,
);

const controller = new AutoUpdateController({
  checkoutDir,
  expectedPackageName: manifest.name,
});

const result = await controller.dryRunCheck();
if (result.decision === "check-failed") process.exitCode = 1;
