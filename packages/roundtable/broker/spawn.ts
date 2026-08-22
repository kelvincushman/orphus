import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { getBrokerPidPath, getBrokerSocketPath, getRoundtableDirPath } from "./paths.ts";
import { canConnect } from "./socket-probe.ts";

const EXTENSION_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const BROKER_MAIN = join(dirname(fileURLToPath(import.meta.url)), "main.ts");

const SPAWN_WAIT_ATTEMPTS = 25;
const SPAWN_WAIT_INTERVAL_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveTsxCliPath(): string | null {
  try {
    const require = createRequire(join(EXTENSION_DIR, "package.json"));
    const tsxMain = require.resolve("tsx");
    return join(dirname(tsxMain), "cli.mjs");
  } catch {
    const bundled = join(EXTENSION_DIR, "node_modules", "tsx", "dist", "cli.mjs");
    return existsSync(bundled) ? bundled : null;
  }
}

function brokerCommand(): { command: string; args: string[] } {
  if (process.versions.bun) {
    return { command: process.execPath, args: [BROKER_MAIN] };
  }
  const tsx = resolveTsxCliPath();
  if (!tsx) throw new Error("Cannot resolve tsx to launch the roundtable broker under Node");
  return { command: process.execPath, args: [tsx, BROKER_MAIN] };
}

/** Ensure a roundtable broker is reachable, spawning a detached one if needed. */
export async function ensureBrokerRunning(socketPath: string = getBrokerSocketPath()): Promise<void> {
  if (await canConnect(socketPath)) return;

  mkdirSync(getRoundtableDirPath(), { recursive: true, mode: 0o700 });
  const { command, args } = brokerCommand();
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();

  for (let attempt = 0; attempt < SPAWN_WAIT_ATTEMPTS; attempt++) {
    await sleep(SPAWN_WAIT_INTERVAL_MS);
    if (await canConnect(socketPath)) return;
  }
  throw new Error(`Roundtable broker did not start in time${describeStartupObstruction()}`);
}

/**
 * The broker child runs detached with stdio ignored, so when it dies on a
 * stale startup lock its remove-and-retry message dies with it and every
 * caller here sees only the timeout. A post-mortem read of the lock file
 * recovers that diagnosis. Read-only on purpose: the broker's own fail-closed
 * reasoning (no compare-and-unlink; deleting could take out a live contender's
 * lock) applies to this process too.
 */
export function describeStartupObstruction(lockPath: string = `${getBrokerPidPath()}.startup.lock`): string {
  try {
    const owner = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
    if (typeof owner.pid !== "number") return "";
    process.kill(owner.pid, 0);
    return "";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return ` — a stale startup lock at ${lockPath} belongs to a dead process; remove that file and retry`;
    }
    return "";
  }
}
