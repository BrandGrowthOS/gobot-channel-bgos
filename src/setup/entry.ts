/**
 * Robust "am I the CLI entry point?" detection.
 *
 * The filename-regex approach (`/setup-cli$/`.test(argv[1])) breaks when a
 * package-manager runs the bin by its bin NAME: `bunx gobot-channel-bgos ...`
 * sets `process.argv[1]` to a shim/symlink called `gobot-channel-bgos`, not
 * `dist/setup-cli.js`, so the regex never matches and `main()` never runs.
 *
 * `isEntryModule` compares the invoked entry to this module by real (symlink
 * resolved) path, so a bin-name shim that points at us still counts as the
 * entry. The realpath function is injectable for testing.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isEntryModule(
  argv1: string | undefined,
  moduleUrl: string,
  realpath: (p: string) => string = realpathSync,
): boolean {
  if (!argv1) return false;
  try {
    return realpath(argv1) === realpath(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

/**
 * Prefer the runtime's own entry signal when present (Bun and Node >= 24
 * expose `import.meta.main`), else fall back to the realpath comparison so
 * Node 20 to 23 also works.
 */
export function invokedAsCliEntry(
  meta: { url: string; main?: boolean },
  argv1: string | undefined,
  realpath?: (p: string) => string,
): boolean {
  if (typeof meta.main === "boolean") return meta.main;
  return isEntryModule(argv1, meta.url, realpath);
}
