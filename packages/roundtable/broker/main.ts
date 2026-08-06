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
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
