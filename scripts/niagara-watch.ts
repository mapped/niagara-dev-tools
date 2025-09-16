#!/usr/bin/env tsx

import chokidar from "chokidar";
import type { FSWatcher } from "chokidar";
import { spawn } from "cross-spawn";
import type { ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

// Simplified version: removed deprecated platCmd support and unused generic
// command helpers. All logic intentionally resides in this single file for
// easier distribution as a small dev utility.

const DEFAULT_DEBOUNCE_MS = 5000;

type PendingKey =
  | "niagaraHome"
  | "modulesDir"
  | "workbenchCmd"
  | "stationCmd"
  | "debounceMs";

interface MutableConfig {
  niagaraHome: string | null;
  modulesDir: string | null;
  stationName: string;
  stationCmd: string;
  workbenchCmd: string;
  debounceMs: number;
  launchWorkbench: boolean;
}

interface Config {
  niagaraHome: string;
  modulesDir: string;
  stationName: string;
  stationCmd: string;
  workbenchCmd: string;
  debounceMs: number;
  launchWorkbench: boolean;
  binDir: string;
}

interface State {
  config: Config;
  commandEnv: NodeJS.ProcessEnv;
  stationProcess: ChildProcess | null;
  stationStopping: boolean;
  workbenchProcess: ChildProcess | null;
  scheduledRestart: NodeJS.Timeout | null;
  shuttingDown: boolean;
}

// (Removed RunOptions and runCommand helper)

function printUsage(): void {
  console.log(`Usage: niagara-watch [options] <station-name>

Options:
  --niagara-home <path>   Niagara installation directory (default: $NIAGARA_HOME)
  -m, --modules <path>    Modules directory to watch (default: NIAGARA_HOME/modules)
  --workbench-cmd <cmd>   Command used to start the workbench (default: wb)
  --station-cmd <cmd>     Command used to start the station (default: station)
  --debounce <ms>         Debounce delay before restarts (default: ${DEFAULT_DEBOUNCE_MS}ms)
  --no-workbench          Skip launching the workbench process
  -h, --help              Show this help message
  --plat-cmd <ignored>    (deprecated; accepted for backward compatibility only)
`);
}

function parseArgs(argv: string[]): Config {
  const args = argv.slice(2);
  const config: MutableConfig = {
    niagaraHome: process.env.NIAGARA_HOME
      ? path.resolve(process.env.NIAGARA_HOME)
      : null,
    modulesDir: process.env.NIAGARA_MODULES_DIR
      ? path.resolve(process.env.NIAGARA_MODULES_DIR)
      : null,
    stationName: process.env.NIAGARA_STATION || "",
    stationCmd: process.env.NIAGARA_STATION_CMD || "station",
    workbenchCmd: process.env.NIAGARA_WORKBENCH_CMD || "wb",
    debounceMs: Number(process.env.NIAGARA_DEBOUNCE_MS) || DEFAULT_DEBOUNCE_MS,
    launchWorkbench: true,
  };

  let pendingValueKey: PendingKey | null = null;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (pendingValueKey) {
      const value = args[i];
      switch (pendingValueKey) {
        case "debounceMs":
          config.debounceMs = Number(value);
          break;
        case "niagaraHome":
        case "modulesDir":
          config[pendingValueKey] = path.resolve(value);
          break;
        case "workbenchCmd":
        case "stationCmd":
          config[pendingValueKey] = value;
          break;
        default:
          break;
      }
      pendingValueKey = null;
      continue;
    }

    switch (arg) {
      case "--niagara-home":
        pendingValueKey = "niagaraHome";
        break;
      case "-m":
      case "--modules":
        pendingValueKey = "modulesDir";
        break;
      case "--workbench-cmd":
        pendingValueKey = "workbenchCmd";
        break;
      case "--station-cmd":
        pendingValueKey = "stationCmd";
        break;
      case "--plat-cmd":
        // Accept & ignore deprecated flag (optionally skip its value)
        if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
          i += 1; // consume value silently
        }
        break;
      case "--debounce":
        pendingValueKey = "debounceMs";
        break;
      case "--no-workbench":
        config.launchWorkbench = false;
        break;
      case "-h":
      case "--help":
        printUsage();
        process.exit(0);
        break;
      default:
        if (!arg.startsWith("-") && !config.stationName) {
          config.stationName = arg;
        } else {
          console.error(`Unknown option: ${arg}`);
          printUsage();
          process.exit(1);
        }
    }
  }

  if (pendingValueKey) {
    console.error(`Missing value for option: ${pendingValueKey}`);
    printUsage();
    process.exit(1);
  }

  if (!config.stationName) {
    console.error(
      "A station name is required. Provide it as a positional argument or via NIAGARA_STATION."
    );
    printUsage();
    process.exit(1);
  }

  if (!config.niagaraHome) {
    console.error(
      "NIAGARA_HOME must be set (environment variable or --niagara-home)."
    );
    process.exit(1);
  }

  if (Number.isNaN(config.debounceMs) || config.debounceMs < 0) {
    console.error("Debounce value must be a positive number of milliseconds.");
    process.exit(1);
  }

  const resolvedHome = path.resolve(config.niagaraHome);
  const binDir = path.join(resolvedHome, "bin");

  if (!fs.existsSync(binDir)) {
    console.error(`Niagara bin directory not found: ${binDir}`);
    process.exit(1);
  }

  const modulesDir = config.modulesDir
    ? path.resolve(config.modulesDir)
    : path.join(resolvedHome, "modules");

  return {
    niagaraHome: resolvedHome,
    modulesDir,
    stationName: config.stationName,
    stationCmd: config.stationCmd,
    workbenchCmd: config.workbenchCmd,
    debounceMs: config.debounceMs,
    launchWorkbench: config.launchWorkbench,
    binDir,
  };
}

function createCommandEnv(config: Config): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NIAGARA_HOME: config.niagaraHome,
  };
  const pathKey =
    Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
  const currentPath = env[pathKey];
  env[pathKey] = currentPath
    ? `${config.binDir}${path.delimiter}${currentPath}`
    : config.binDir;
  return env;
}

function formatExit(
  code: number | null,
  signal: NodeJS.Signals | null
): string {
  if (code !== null) {
    return `code ${code}`;
  }
  return signal ? `signal ${signal}` : "unknown exit";
}

// (Removed runCommand helper)

async function main(): Promise<void> {
  const config = parseArgs(process.argv);

  if (!fs.existsSync(config.modulesDir)) {
    console.error(`Modules directory not found: ${config.modulesDir}`);
    process.exit(1);
  }

  const commandEnv = createCommandEnv(config);
  console.log(`Watching ${config.modulesDir} for changes...`);

  const state: State = {
    config,
    commandEnv,
    stationProcess: null,
    stationStopping: false,
    workbenchProcess: null,
    scheduledRestart: null,
    shuttingDown: false,
  };

  const watcher: FSWatcher = chokidar.watch(config.modulesDir, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: {
      stabilityThreshold: config.debounceMs,
      pollInterval: Math.min(
        100,
        Math.max(20, Math.floor(config.debounceMs / 2))
      ),
    },
  });

  const scheduleRestart = (reason: string): void => {
    console.log(`[watch] Change detected (${reason}). Restart scheduled.`);
    if (state.scheduledRestart) {
      clearTimeout(state.scheduledRestart);
    }
    state.scheduledRestart = setTimeout(async () => {
      state.scheduledRestart = null;
      try {
        await restartStation(state);
        if (config.launchWorkbench) {
          await restartWorkbench(state);
        }
        console.log("[watch] Restart complete.");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[watch] Restart failed: ${message}`);
      }
    }, config.debounceMs);
  };

  watcher.on("all", (event, changedPath) => {
    const relative = path.relative(config.modulesDir, changedPath);
    scheduleRestart(`${event} ${relative}`);
  });

  watcher.on("error", (err) => {
    console.error(
      `[watch] Watcher error: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  });

  const shutdown = async (): Promise<void> => {
    if (state.shuttingDown) {
      return;
    }
    state.shuttingDown = true;
    console.log("Shutting down watcher...");
    try {
      await watcher.close();
    } catch (err) {
      console.error(
        `Error closing watcher: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    if (state.scheduledRestart) {
      clearTimeout(state.scheduledRestart);
    }
    if (config.launchWorkbench) {
      await stopWorkbench(state);
    }
    await stopStation(state);
    process.exit(0);
  };

  const handleShutdown = () => {
    void shutdown();
  };

  process.on("SIGINT", handleShutdown);
  process.on("SIGTERM", handleShutdown);

  try {
    await startStation(state);
    if (config.launchWorkbench) {
      startWorkbench(state);
    }
  } catch (err) {
    console.error(
      `Failed to launch: ${err instanceof Error ? err.message : String(err)}`
    );
    await shutdown();
  }
}

async function startStation(state: State): Promise<void> {
  if (state.stationProcess) {
    console.log("[station] Already running, skipping start.");
    return;
  }

  state.stationStopping = false;
  console.log(`[station] Starting station ${state.config.stationName}...`);
  // Use pipe for stdin so we can send a graceful quit command.
  const proc = spawn(state.config.stationCmd, [state.config.stationName], {
    stdio: ["pipe", "inherit", "inherit"],
    env: state.commandEnv,
    cwd: state.config.binDir,
    windowsHide: false,
  });

  state.stationProcess = proc;

  proc.on("error", (err) => {
    console.error(
      `[station] Failed to launch: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    if (state.stationProcess === proc) {
      state.stationProcess = null;
    }
  });

  proc.on("exit", (code, signal) => {
    console.log(`[station] Exited with ${formatExit(code, signal)}`);
    if (state.stationProcess === proc) {
      state.stationProcess = null;
    }
    if (!state.shuttingDown && !state.stationStopping) {
      console.log("[station] Process stopped unexpectedly. Restarting...");
      void startStation(state);
    }
  });
}

async function stopStation(state: State): Promise<void> {
  const proc = state.stationProcess;
  if (!proc) {
    state.stationStopping = false;
    return;
  }

  if (state.stationStopping) {
    return; // already stopping
  }

  state.stationStopping = true;
  console.log("[station] Sending quit command...");

  const quitCommand = `quit${os.EOL}`;
  if (proc.stdin && !proc.stdin.destroyed) {
    try {
      proc.stdin.write(quitCommand, (err) => {
        if (err) {
          console.error(`[station] Failed writing quit: ${err.message}`);
        }
        try {
          proc.stdin && proc.stdin.end();
        } catch {
          /* ignore */
        }
      });
    } catch (err) {
      console.error(
        `[station] Error sending quit: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  } else {
    console.warn(
      "[station] stdin not available to send quit; proceeding to wait for exit."
    );
  }

  await new Promise<void>((resolve) => {
    let finished = false;
    let forceKillTimer: NodeJS.Timeout | null = null;

    const finalize = () => {
      if (finished) return;
      finished = true;
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (state.stationProcess === proc) {
        state.stationProcess = null;
      }
      state.stationStopping = false;
      resolve();
    };

    proc.once("exit", finalize);

    // After 5s, escalate to SIGTERM, then after 3s more force kill
    forceKillTimer = setTimeout(() => {
      if (finished) return;
      console.warn("[station] Graceful quit timeout; sending SIGTERM.");
      try {
        // On Windows passing undefined sends a normal termination signal; ensure pid exists
        if (proc.pid) {
          proc.kill(process.platform === "win32" ? undefined : "SIGTERM");
        }
      } catch (err) {
        console.error(
          `[station] Failed SIGTERM: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
      setTimeout(() => {
        if (finished) return;
        console.warn("[station] Forcing termination.");
        if (process.platform === "win32") {
          const killer = spawn(
            "taskkill",
            ["/PID", String(proc.pid), "/T", "/F"],
            {
              stdio: "inherit",
              env: state.commandEnv,
              windowsHide: false,
            }
          );
          killer.once("exit", finalize);
          killer.once("error", (killErr) => {
            console.error(
              `[station] taskkill failed: ${
                killErr instanceof Error ? killErr.message : String(killErr)
              }`
            );
            finalize();
          });
        } else {
          try {
            if (proc.pid) {
              process.kill(proc.pid, "SIGKILL");
            }
          } catch (killErr) {
            console.error(
              `[station] SIGKILL failed: ${
                killErr instanceof Error ? killErr.message : String(killErr)
              }`
            );
          }
          finalize();
        }
      }, 3000);
    }, 5000);
  });
}

async function restartStation(state: State): Promise<void> {
  await stopStation(state);
  await startStation(state);
}

function startWorkbench(state: State): void {
  if (state.workbenchProcess) {
    console.log("[workbench] Already running, skipping start.");
    return;
  }

  console.log("[workbench] Starting workbench...");
  const proc = spawn(state.config.workbenchCmd, [], {
    stdio: "inherit",
    env: state.commandEnv,
    cwd: state.config.binDir,
    windowsHide: false,
  });

  state.workbenchProcess = proc;

  proc.on("error", (err) => {
    console.error(
      `[workbench] Failed to launch: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    if (state.workbenchProcess === proc) {
      state.workbenchProcess = null;
    }
  });

  proc.on("exit", (code, signal) => {
    console.log(`[workbench] Exited with ${formatExit(code, signal)}`);
    if (state.workbenchProcess === proc) {
      state.workbenchProcess = null;
    }
    if (!state.shuttingDown && state.config.launchWorkbench) {
      console.log("[workbench] Process stopped unexpectedly. Restarting...");
      startWorkbench(state);
    }
  });
}

async function stopWorkbench(state: State): Promise<void> {
  const proc = state.workbenchProcess;
  if (!proc) {
    return;
  }

  state.workbenchProcess = null;
  console.log("[workbench] Stopping workbench...");

  await new Promise<void>((resolve) => {
    let finished = false;
    let forceKillTimer: NodeJS.Timeout | null = null;

    const finalize = () => {
      if (finished) {
        return;
      }
      finished = true;
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      resolve();
    };

    proc.once("exit", finalize);

    try {
      proc.kill("SIGTERM");
    } catch (err) {
      console.error(
        `[workbench] Failed to send SIGTERM: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      finalize();
      return;
    }

    forceKillTimer = setTimeout(() => {
      if (finished) {
        return;
      }
      console.warn("[workbench] Workbench did not exit; forcing termination.");
      if (process.platform === "win32") {
        const killer = spawn(
          "taskkill",
          ["/PID", String(proc.pid), "/T", "/F"],
          {
            stdio: "inherit",
            env: state.commandEnv,
            windowsHide: false,
          }
        );
        killer.once("exit", finalize);
        killer.once("error", (killErr) => {
          console.error(
            `[workbench] taskkill failed: ${
              killErr instanceof Error ? killErr.message : String(killErr)
            }`
          );
          finalize();
        });
      } else {
        try {
          if (proc.pid) {
            process.kill(proc.pid, "SIGKILL");
          }
        } catch (killErr) {
          console.error(
            `[workbench] SIGKILL failed: ${
              killErr instanceof Error ? killErr.message : String(killErr)
            }`
          );
        }
        finalize();
      }
    }, 5000);
  });
}

async function restartWorkbench(state: State): Promise<void> {
  await stopWorkbench(state);
  startWorkbench(state);
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
