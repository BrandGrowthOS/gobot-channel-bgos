#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AutoUpdateController,
  WRAPPED_BOOT_COMMIT_ENV,
  type AutoUpdateControllerDeps,
  type AutoUpdateStartResult,
} from "./self-update.js";

const SUPERVISOR_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export interface WrapperController {
  start(): Promise<AutoUpdateStartResult>;
  stop(): void;
}

export interface WrapperSignalTarget {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface DaemonWrapperRuntime {
  env: NodeJS.ProcessEnv;
  execPath: string;
  signalTarget: WrapperSignalTarget;
  spawnProcess: typeof spawn;
  createController: (deps: AutoUpdateControllerDeps) => WrapperController;
  log: (message: string) => void;
}

export function parseDaemonWrapperArgs(argv: string[]): string {
  if (argv.length !== 1 || !argv[0]?.trim()) {
    throw new Error("expected one Gobot install directory argument");
  }
  return resolve(argv[0]);
}

export function botSpawnSpec(
  installDir: string,
  bunPath: string,
  env: NodeJS.ProcessEnv,
): {
  command: string;
  args: string[];
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    shell: false;
    stdio: "inherit";
  };
} {
  const checkout = resolve(installDir);
  return {
    command: bunPath,
    args: ["run", resolve(checkout, "src", "bot.ts")],
    options: {
      cwd: checkout,
      env,
      shell: false,
      stdio: "inherit",
    },
  };
}

function defaultRuntime(): DaemonWrapperRuntime {
  return {
    env: process.env,
    execPath: process.execPath,
    signalTarget: process,
    spawnProcess: spawn,
    createController: (deps) => new AutoUpdateController(deps),
    log: (message) => console.log(message),
  };
}

export async function runDaemonWrapper(
  installDir: string,
  runtime: DaemonWrapperRuntime = defaultRuntime(),
): Promise<number> {
  const checkout = resolve(installDir);
  delete runtime.env[WRAPPED_BOOT_COMMIT_ENV];
  let requestedExitCode: number | null = null;
  let child: ChildProcess | null = null;
  let cleanSignal: NodeJS.Signals | null = null;
  let controllerStopped = false;

  const controller = runtime.createController({
    checkoutDir: checkout,
    expectedPackageName: "gobot",
    bunPath: runtime.execPath,
    env: runtime.env,
    preImportOnly: true,
    log: runtime.log,
    exit: (code) => {
      requestedExitCode = code;
    },
  });

  const signalListeners = new Map<NodeJS.Signals, () => void>();
  const removeSignalListeners = (): void => {
    for (const [signal, listener] of signalListeners) {
      runtime.signalTarget.off(signal, listener);
    }
    signalListeners.clear();
  };

  for (const signal of SUPERVISOR_SIGNALS) {
    const listener = (): void => {
      cleanSignal = signal;
      if (!controllerStopped) {
        controllerStopped = true;
        try {
          controller.stop();
        } catch (error) {
          runtime.log(
            `[gobot-channel-bgos] clean shutdown state could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      child?.kill(signal);
    };
    signalListeners.set(signal, listener);
    runtime.signalTarget.on(signal, listener);
  }

  let preflight: AutoUpdateStartResult;
  try {
    preflight = await controller.start();
  } catch (error) {
    runtime.log(
      `[gobot-channel-bgos] auto-update preflight failed; Gobot will continue: ${error instanceof Error ? error.message : String(error)}`,
    );
    preflight = "running";
  }

  if (cleanSignal) {
    try {
      controller.stop();
    } catch (error) {
      runtime.log(
        `[gobot-channel-bgos] clean shutdown state could not be recorded after preflight: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    removeSignalListeners();
    return 0;
  }
  if (preflight === "retry-required") {
    removeSignalListeners();
    runtime.log(
      "[gobot-channel-bgos] auto-update preflight requires a retry; Gobot was not started",
    );
    return 1;
  }
  if (preflight === "exit-requested" || requestedExitCode !== null) {
    removeSignalListeners();
    return requestedExitCode ?? 0;
  }

  const spec = botSpawnSpec(checkout, runtime.execPath, runtime.env);
  try {
    child = runtime.spawnProcess(spec.command, spec.args, spec.options);
  } catch (error) {
    removeSignalListeners();
    runtime.log(
      `[gobot-channel-bgos] Gobot child could not start: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  return await new Promise<number>((resolveExit) => {
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      removeSignalListeners();
      resolveExit(code);
    };
    child?.once("error", (error) => {
      runtime.log(
        `[gobot-channel-bgos] Gobot child failed: ${error.message}`,
      );
      finish(1);
    });
    child?.once("exit", (code) => {
      finish(code ?? (cleanSignal ? 0 : 1));
    });
  });
}

function invokedAsMain(): boolean {
  const meta = import.meta as ImportMeta & { main?: boolean };
  if (typeof meta.main === "boolean") return meta.main;
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsMain()) {
  let installDir: string;
  try {
    installDir = parseDaemonWrapperArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `daemon wrapper failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
    installDir = "";
  }
  if (installDir) {
    runDaemonWrapper(installDir)
      .then((code) => {
        process.exitCode = code;
      })
      .catch((error: unknown) => {
        process.stderr.write(
          `daemon wrapper failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 1;
      });
  }
}
