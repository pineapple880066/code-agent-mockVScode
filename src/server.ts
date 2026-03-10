import { config as loadEnv } from "dotenv";

import { createApp } from "./api/app.js";
import { resolveChatConfig, resolveEmbeddingConfig, resolveServerConfig } from "./config.js";
import { IndexManager } from "./rag/index-manager.js";

loadEnv();

const serverConfig = resolveServerConfig();
const chatConfig = resolveChatConfig();
const indexManager = new IndexManager(serverConfig.workspaceRoot, resolveEmbeddingConfig());

await indexManager.initialize();
indexManager.startWatching();

const app = createApp({
  serverConfig,
  chatConfig,
  indexManager,
});

const server = app.listen(serverConfig.port, () => {
  process.stdout.write(
    `Code Agent server running at http://127.0.0.1:${serverConfig.port} for ${serverConfig.workspaceRoot}\n`,
  );
});

const shutdown = async () => {
  server.close();
  await indexManager.close();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
