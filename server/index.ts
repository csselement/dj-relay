import { existsSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import { createApp } from "./app.js";
import { assertProductionConfig, loadConfig } from "./config.js";
import { SessionStore } from "./db.js";
import { MediaMtxControlClient, RecordingWatchdog } from "./recordingWatchdog.js";
import { MediaMtxRecordingBackend, RecordingFinalizer } from "./recordings.js";

const config = loadConfig();
assertProductionConfig(config);
const store = new SessionStore(config.databasePath);
const mediaMtx = new MediaMtxControlClient(config.mediaMtxApiUrl);
const recordings = new MediaMtxRecordingBackend(
  config.mediaMtxPlaybackUrl,
  config.mediaMtxApiUrl,
  config.recordingsPath,
  config.recordingPlaybackPath,
);
const recordingFinalizer = new RecordingFinalizer({ store, recordings });
const recordingGuard = new RecordingWatchdog({
  config,
  store,
  mediaMtx,
});
await recordingGuard.initialize();
const app = createApp({ config, store, recordingGuard, mediaMtx, recordings });
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
  recordingGuard.start();
  recordingFinalizer.start();
  console.log(JSON.stringify({ level: "info", message: "Discus listening", port: config.port }));
});

function shutdown(): void {
  recordingGuard.stop();
  recordingFinalizer.stop();
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
