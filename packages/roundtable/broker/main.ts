import { getBrokerPidPath, getBrokerSocketPath, getRoundtableDirPath } from "./paths.ts";
import { BrokerAlreadyRunningError, RoundtableBroker } from "./broker.ts";

// This process exists only to be the broker, so it is the one caller allowed to
// exit when the last session goes away.
const broker = new RoundtableBroker(getBrokerSocketPath(), getBrokerPidPath(), getRoundtableDirPath(), {
  exitWhenIdle: true,
});

broker.start(
  () => {
    console.log(`Roundtable broker started (pid: ${process.pid})`);
  },
  (reason) => {
    if (reason instanceof BrokerAlreadyRunningError) {
      // Losing the race is the ordinary outcome when several sessions start at
      // once: another broker is already serving this socket, so this process has
      // nothing left to do. The caller's next probe finds the winner and proceeds.
      console.log(`Roundtable broker not started: ${reason.message}`);
      process.exit(0);
    }
    console.error(`Roundtable broker failed to start: ${reason.message}`);
    process.exit(1);
  },
);
