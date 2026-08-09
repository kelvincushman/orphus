import { NAME_PATTERN } from "../roles/manifest.js";

export const BRIDGE_USAGE = "Usage: orphus-roundtable-mcp --as <role>";

/**
 * The role is the peer's identity: room cursors and attribution are keyed by
 * it broker-side, which is why it is a launch flag rather than a tool
 * parameter, and why it must satisfy the same pattern the roles manifest
 * enforces.
 */
export function parseBridgeArgs(argv: string[]): { role: string } | { error: string } {
  const index = argv.indexOf("--as");
  const value = index === -1 ? undefined : argv[index + 1];
  if (value === undefined) return { error: BRIDGE_USAGE };
  const role = value.trim();
  if (!NAME_PATTERN.test(role)) {
    return { error: `Invalid role ${JSON.stringify(value)}: must match ${String(NAME_PATTERN)}. ${BRIDGE_USAGE}` };
  }
  return { role };
}
