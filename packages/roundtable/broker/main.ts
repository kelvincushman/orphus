import { RoundtableBroker } from "./broker.ts";
import { dirname } from "path";
import { getBrokerPidPathForSocket, getBrokerSocketPath, getRoundtableDirPath } from "./paths.ts";

const socketOverride = process.env.ORPHUS_ROUNDTABLE_SOCKET_PATH;
const broker =
  socketOverride && socketOverride !== getBrokerSocketPath()
    ? new RoundtableBroker(
        socketOverride,
        getBrokerPidPathForSocket(socketOverride),
        process.platform === "win32" ? getRoundtableDirPath() : dirname(socketOverride),
      )
    : new RoundtableBroker();
broker
  .start(() => {
    console.log(`Roundtable broker started (pid: ${process.pid})`);
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error ? error.cause : undefined;
    const causeMessage = cause instanceof Error ? `\nCaused by: ${cause.message}` : "";
    console.error(`${message}${causeMessage}`);
    process.exit(1);
  });
