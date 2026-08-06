import { createHash } from "crypto";
import { homedir } from "os";
import { join } from "path";

function getHomeDir(): string {
  if (process.platform === "win32") {
    if (process.env.USERPROFILE) return process.env.USERPROFILE;
    if (process.env.HOMEDRIVE && process.env.HOMEPATH) return `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`;
    if (process.env.HOME) return process.env.HOME;
    return homedir();
  }
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

function expandTildePath(path: string): string {
  if (path === "~") return getHomeDir();
  if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) {
    return join(getHomeDir(), path.slice(2));
  }
  return path;
}

/** Fork lineage: Orphus first, then Atomic, then Pi — matching CONFIG_DIR_NAMES. */
function getAgentDir(): string {
  const orphusAgentDir = process.env.ORPHUS_CODING_AGENT_DIR;
  if (orphusAgentDir) return expandTildePath(orphusAgentDir);
  const atomicAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
  if (atomicAgentDir) return expandTildePath(atomicAgentDir);
  const piAgentDir = process.env.PI_CODING_AGENT_DIR;
  if (piAgentDir) return expandTildePath(piAgentDir);
  return join(getHomeDir(), ".orphus", "agent");
}

function sanitizePipeSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "default";
}

export function getRoundtableDirPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, "roundtable");
}

export function getBrokerPidPath(agentDir: string = getAgentDir()): string {
  return join(getRoundtableDirPath(agentDir), "broker.pid");
}

export function getBrokerSocketPath(
  platform: NodeJS.Platform = process.platform,
  agentDir: string = getAgentDir(),
): string {
  if (platform === "win32") {
    // sanitizePipeSegment is many-to-one (it collapses punctuation/case), so on
    // its own it would collide distinct agent dirs — e.g. team.one and team_one —
    // onto one machine-global pipe. Append a hash of the full path for uniqueness;
    // the sanitized part stays for human readability.
    const digest = createHash("sha256").update(agentDir).digest("hex").slice(0, 12);
    return `\\\\.\\pipe\\atomic-roundtable-${sanitizePipeSegment(agentDir)}-${digest}`;
  }
  return join(getRoundtableDirPath(agentDir), "broker.sock");
}
