import { P2PClient } from "./p2p-сlient.js";
import { NodeService } from "./services/node-service.js";
import ConfigLoader from "./helpers/config-loader.js";
import { createServer } from "./services/web-server.js";

async function main(): Promise<void> {
  await ConfigLoader.initialize();
  const config = ConfigLoader.getInstance().getConfig();

  let port = config.port ?? 6006;
  const argv = process.argv.slice(2);
  if (!argv.includes("--no-webserver")) {
    port = 0;
  }
  const listenAddrs = config.listen ?? ["/ip4/0.0.0.0/tcp/"];
  const networkService = new NodeService(
    new P2PClient(listenAddrs, port, config.roles.NODE)
  );

  if (!argv.includes("--no-webserver")) {
    createServer(networkService);
  }

  await networkService.startAsync();
}

process.on("uncaughtException", (err) => {
  console.error("Unhandled exception:", err);
  process.exit(1); // Завершение процесса с кодом ошибки
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled promise rejection at:", promise, "reason:", reason);
  process.exit(1); // Завершение процесса с кодом ошибки
});

main();
