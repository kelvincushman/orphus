import net from "net";

const PROBE_TIMEOUT_MS = 1000;

/**
 * Is a live broker listening on this socket path?
 *
 * Used by two callers with opposite intents: the spawner asks "do I need to
 * start one?", and the broker asks "did someone beat me to this path, or is
 * this a stale socket file I may remove?". Both need the same answer, so they
 * share one implementation rather than two that could drift.
 *
 * A socket *file* existing proves nothing — a broker killed with SIGKILL leaves
 * one behind. Only a completed connection distinguishes live from stale.
 */
export function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    // Cleared on whichever of connect/error/timeout lands first. Left pending,
    // it keeps the event loop alive for a further second per probe, and the
    // spawn path probes up to 25 times.
    let timer: NodeJS.Timeout | null = null;
    const finish = (result: boolean) => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
  });
}
