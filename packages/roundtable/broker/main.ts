import { RoundtableBroker } from "./broker.ts";

const broker = new RoundtableBroker(process.env.ORPHUS_ROUNDTABLE_SOCKET_PATH);
broker
  .start(() => {
    console.log(`Roundtable broker started (pid: ${process.pid})`);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
