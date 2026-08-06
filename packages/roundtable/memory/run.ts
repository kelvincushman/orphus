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

export const MAX_CAPTURE_BYTES = 1024 * 1024;

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

    // Collect raw Buffers and decode ONCE at the end. Decoding each chunk as it
    // arrives would split a multi-byte UTF-8 sequence that straddles a chunk
    // boundary into U+FFFD — routine for a Python backend flushing incrementally.
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let capturedBytes = 0;
    let captureExceeded = false;
    const capture = (chunks: Buffer[], chunk: Buffer) => {
      if (captureExceeded) return;
      const remaining = MAX_CAPTURE_BYTES - capturedBytes;
      if (remaining > 0) {
        const captured = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
        chunks.push(captured);
        capturedBytes += captured.length;
      }
      if (chunk.length > remaining) {
        captureExceeded = true;
        child.kill();
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => capture(outChunks, chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture(errChunks, chunk));

    // ENOENT (backend not installed) and abort both arrive as 'error'; a normal
    // run ends in 'close'. Guard so a late 'close' after 'error' cannot double-settle.
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("close", (code, killSignal) => {
      if (settled) return;
      settled = true;
      const stdout = Buffer.concat(outChunks).toString("utf8");
      let stderr = Buffer.concat(errChunks).toString("utf8");
      if (captureExceeded) {
        const note = `captured output exceeded ${MAX_CAPTURE_BYTES} bytes`;
        stderr = stderr.trim() ? `${stderr}\n${note}` : note;
        resolve({ code: 1, stdout, stderr });
        return;
      }
      // A signal-terminated child (OOM kill, SIGSEGV) reports code=null. Collapsing
      // that to 0 would read as success; surface it as a non-zero failure instead.
      if (code === null) {
        const note = `process terminated by signal ${killSignal ?? "unknown"}`;
        stderr = stderr.trim() ? `${stderr}\n${note}` : note;
        resolve({ code: 1, stdout, stderr });
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}
