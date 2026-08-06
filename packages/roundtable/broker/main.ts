import { RoundtableBroker } from "./broker.ts";

const broker = new RoundtableBroker();
broker.start(() => {
  console.log(`Roundtable broker started (pid: ${process.pid})`);
});
