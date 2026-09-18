import { loadConfig } from "@n8nauto/config";
import { buildApp } from "./app.js";

const config = loadConfig();
const app = await buildApp(config);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutdown requested.");
  await app.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({
    host: config.api.host,
    port: config.api.port
  });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
