import { homedir } from "node:os";
import { join } from "node:path";

export function resolveGobotStateHome(
  env: Record<string, string | undefined> = process.env,
  userHome: string = homedir(),
): string {
  const configured = env.GOBOT_HOME?.trim();
  if (!configured) return join(userHome, ".gobot");
  return configured.startsWith("~")
    ? join(userHome, configured.slice(1))
    : configured;
}
