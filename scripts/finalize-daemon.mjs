// Post-build: ensure the bin entries are executable.
//
// This package ships two bins:
//   - `gobot-pair-bgos`              → `dist/pair-cli.js`
//   - `gobot-bgos-reseed-commands`   → `dist/reseed-cli.js`
// Node strips the shebang on TS compile, so we re-add it here and chmod
// the files. chmod is best-effort on Windows where the bit is meaningless.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const BIN_FILES = ["dist/pair-cli.js", "dist/reseed-cli.js"];

let exitCode = 0;
for (const rel of BIN_FILES) {
  const target = resolve(rel);
  if (!existsSync(target)) {
    console.error(`[finalize-daemon] ${target} does not exist`);
    exitCode = 1;
    continue;
  }
  let contents = readFileSync(target, "utf8");
  if (!contents.startsWith("#!")) {
    contents = "#!/usr/bin/env node\n" + contents;
    writeFileSync(target, contents);
  }
  try {
    chmodSync(target, 0o755);
  } catch {
    // chmod may not apply on Windows; best-effort.
  }
  console.log(`[finalize-daemon] ${rel} is ready`);
}
process.exit(exitCode);
