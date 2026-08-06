import { spawn } from "child_process";
import { existsSync, mkdirSync } from "fs";
import net from "net";
import { dirname, join } from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { getBrokerSocketPath, getRoundtableDirPath } from "./paths.ts";

const EXTENSION_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const BROKER_MAIN = join(dirname(fileURLToPath(import.meta.url)), "main.ts");

const SPAWN_WAIT_ATTEMPTS = 25;
const SPAWN_WAIT_INTERVAL_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const timer = setTimeout(() => finish(false), 1000);
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
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

  mkdirSync(getRoundtableDirPath(), { recursive: true });
  const { command, args } = brokerCommand();
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ORPHUS_ROUNDTABLE_SOCKET_PATH: socketPath },
  });
  const launchState: { error: Error | null } = { error: null };
  let notifyLaunchError: () => void = () => {};
  const launchFailed = new Promise<void>((resolve) => {
    notifyLaunchError = resolve;
  });
  child.on("error", (error) => {
    launchState.error = error;
    notifyLaunchError();
  });
  child.unref();

  for (let attempt = 0; attempt < SPAWN_WAIT_ATTEMPTS; attempt++) {
    await Promise.race([sleep(SPAWN_WAIT_INTERVAL_MS), launchFailed]);
    const launchError = launchState.error;
    if (launchError) {
      throw new Error(`Failed to launch roundtable broker: ${launchError.message}`, { cause: launchError });
    }
    if (await canConnect(socketPath)) return;
  }
  throw new Error("Roundtable broker did not start in time");
}
