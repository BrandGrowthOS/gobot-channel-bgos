/**
 * Pure user-facing message composition. No IO.
 */
import type { Competitor } from "./competitors.js";

export interface SuccessInfo {
  installDir: string;
  agentCount: number;
  supervisor: string;
  homeChannel: string;
  paired: boolean;
}

export function formatSuccessLine(info: SuccessInfo): string {
  const agents = `${info.agentCount} agent${info.agentCount === 1 ? "" : "s"}`;
  return (
    `Gobot is connected to BGOS. ${agents} exposed, ` +
    `home channel ${info.homeChannel}, supervised by ${info.supervisor}. ` +
    `Open BGOS, Integrations, Gobot card to see this device, then message a ` +
    `Gobot agent to test the round trip.`
  );
}

export function competitorPrompt(c: Competitor): string {
  return (
    `Another process is polling the same Telegram token ` +
    `(pid ${c.pid || "?"}, ${c.source}):\n  ${c.command}\n` +
    `Two pollers cause repeated 409 Conflicts. Kill it before continuing? ` +
    `[y/N] `
  );
}
