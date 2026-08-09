import { RoundtableClient } from "../broker/client.js";
import { getBrokerSocketPath } from "../broker/paths.js";
import { ensureBrokerRunning } from "../broker/spawn.js";
import { resolveMemoryConfig } from "../memory/dossier.js";
import type { RoundtableToolDeps } from "../roundtable-tool.js";

export interface BridgeOverrides {
  ensureBroker?: () => Promise<void>;
  makeClient?: (role: string) => RoundtableClient;
}

export interface BridgeDeps extends RoundtableToolDeps {
  disconnect(): void;
}

/**
 * The builtin's deps come from a live session (`pi.getSessionName()`); the
 * bridge has no session, so the role is pinned at construction and stamped on
 * everything. Connection stays lazy for the same reason it is lazy in the
 * extension: a server that is configured but never called must cost nothing.
 * Unlike the builtin, the bridge must also ensure the broker exists — when
 * every peer is external, no Orphus session is around to spawn it.
 */
export function createBridgeDeps(role: string, overrides: BridgeOverrides = {}): BridgeDeps {
  const ensureBroker = overrides.ensureBroker ?? (() => ensureBrokerRunning());
  const makeClient = overrides.makeClient ?? ((name: string) => new RoundtableClient(name));
  const memoryConfig = resolveMemoryConfig();
  let client: RoundtableClient | null = null;
  let connecting: Promise<RoundtableClient> | null = null;

  const ensureConnected = (): Promise<RoundtableClient> => {
    if (client?.connected) return Promise.resolve(client);
    if (connecting) return connecting;
    connecting = (async () => {
      try {
        try {
          await ensureBroker();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // A peer that cannot reach the broker should say where it looked.
          throw new Error(`${message} (socket: ${getBrokerSocketPath()})`);
        }
        const fresh = makeClient(role);
        await fresh.connect();
        client = fresh;
        return fresh;
      } finally {
        connecting = null;
      }
    })();
    return connecting;
  };

  return {
    ensureConnected,
    exportRoot: memoryConfig.cwd,
    currentRole: () => role,
    writerRole: memoryConfig.writerRole,
    disconnect: () => {
      client?.disconnect();
      client = null;
    },
  };
}
