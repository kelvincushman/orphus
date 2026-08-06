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
    const finish = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    setTimeout(() => finish(false), 1000);
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
    env: process.env,
  });
  child.unref();

  for (let attempt = 0; attempt < SPAWN_WAIT_ATTEMPTS; attempt++) {
    await sleep(SPAWN_WAIT_INTERVAL_MS);
    if (await canConnect(socketPath)) return;
  }
  throw new Error("Roundtable broker did not start in time");
}
