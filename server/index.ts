import { existsSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import { createApp } from "./app.js";
import { assertProductionConfig, loadConfig } from "./config.js";
import { SessionStore } from "./db.js";

const config = loadConfig();
assertProductionConfig(config);
const store = new SessionStore(config.databasePath);
const app = createApp({ config, store });
const root = process.cwd();

if (process.env.NODE_ENV === "development") {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({ root, server: { middlewareMode: true }, appType: "spa" });
  app.use(vite.middlewares);
} else {
  const clientDir = join(root, "dist/client");
  if (!existsSync(clientDir)) throw new Error(`Client build not found at ${clientDir}`);
  app.use(express.static(clientDir, { index: false, maxAge: "1h" }));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api/") || req.path.startsWith("/internal/")) return next();
    res.sendFile(join(clientDir, "index.html"));
  });
}

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(JSON.stringify({ level: "info", message: "DJ Relay listening", port: config.port }));
});

function shutdown(): void {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
