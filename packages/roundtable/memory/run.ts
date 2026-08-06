import { spawn } from "child_process";
import type { MemoryConfig } from "./dossier.ts";

/**
 * The subprocess boundary — the only impure part of the memory path.
 *
 * argv is passed as a real argument vector with no shell, so an agent-supplied
 * question or source path is data, never a command: it cannot inject shell
 * syntax. A backend that is not installed surfaces as a rejected promise, which
 * the tool turns into a "configure memory" notice rather than a crash.
 */

export interface MemoryRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function runDossier(
  config: MemoryConfig,
  argv: readonly string[],
  signal?: AbortSignal,
): Promise<MemoryRunResult> {
  const [command, ...baseArgs] = config.command;
  if (!command) return Promise.reject(new Error("memory command is empty; set ORPHUS_MEMORY_COMMAND"));

  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, [...baseArgs, ...argv], {
      cwd: config.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      ...(signal ? { signal } : {}),
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    // ENOENT (backend not installed) and abort both arrive as 'error'; a normal
    // run ends in 'close'. Guard so a late 'close' after 'error' cannot double-settle.
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}
