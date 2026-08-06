import type { Socket } from "net";

/** Hard protocol bound for both inbound and outbound JSON frames. */
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

/**
 * Write a length-prefixed message to a socket.
 * Format: 4-byte big-endian length + JSON payload.
 * Mirrors @bastani/intercom framing so the two brokers stay protocol-cousins.
 */
export function writeMessage(socket: Socket, msg: unknown): void {
  const json = JSON.stringify(msg);
  const payload = Buffer.from(json, "utf-8");
  if (payload.length > MAX_MESSAGE_BYTES) {
    throw new Error(`Roundtable message too large: ${payload.length} bytes (max ${MAX_MESSAGE_BYTES})`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  socket.write(Buffer.concat([header, payload]));
}

/** Create a message reader that handles partial reads. */
export function createMessageReader(
  onMessage: (msg: unknown) => void,
  onError: (error: Error) => void,
) {
  let buffer = Buffer.alloc(0);

  return (data: Buffer) => {
    buffer = Buffer.concat([buffer, data]);

    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0);
      if (length > MAX_MESSAGE_BYTES) {
        buffer = Buffer.alloc(0);
        onError(new Error(`Roundtable message too large: ${length} bytes (max ${MAX_MESSAGE_BYTES})`));
        return;
      }
      if (buffer.length < 4 + length) break;

      const payload = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);

      let msg: unknown;
      try {
        msg = JSON.parse(payload.toString("utf-8"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onError(new Error(`Failed to parse roundtable message: ${message}`, { cause: error }));
        return;
      }

      try {
        onMessage(msg);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onError(new Error(`Failed to handle roundtable message: ${message}`, { cause: error }));
        return;
      }
    }
  };
}
