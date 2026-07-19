export type AppConfig = {
  port: number;
  databasePath: string;
  adminPassword: string;
  tokenSecret: string;
  mediaAuthSecret: string;
  publicMediaBase: string;
  mediaMtxApiUrl: string;
  mediaMtxPlaybackUrl: string;
  maxListeners: number;
  djDisconnectGraceMs: number;
  discordWebhookUrl: string | null;
  secureCookies: boolean;
  loginWindowMs: number;
  loginClientFailureLimit: number;
  loginGlobalFailureLimit: number;
  loginTrackedClientLimit: number;
  transcodeMaxActive: number;
  transcodeMaxQueued: number;
  transcodeQueueWaitMs: number;
  transcodeTimeoutMs: number;
  recordingsPath: string;
  recordingSessionMaxBytes: number;
  recordingArchiveMaxBytes: number;
  recordingHostFreeFloorBytes: number;
  recordingHostFreeWarningBytes: number;
  recordingArchiveWarningRatio: number;
  recordingActiveScanMs: number;
  recordingArchiveScanMs: number;
  recordingIngressMaxBytesPerSecond: number;
  recordingIngressWindowMs: number;
  recordingIngressConsecutiveViolations: number;
};

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: Number(process.env.PORT ?? 3000),
    databasePath: process.env.DATABASE_PATH ?? "./data/dj-relay.sqlite",
    adminPassword: process.env.ADMIN_PASSWORD ?? "change-me-in-production",
    tokenSecret: process.env.TOKEN_SECRET ?? "dev-only-token-secret-change-me-now",
    mediaAuthSecret: process.env.MEDIAMTX_AUTH_SECRET ?? "dev-media-auth-secret",
    publicMediaBase: process.env.PUBLIC_MEDIA_BASE ?? "http://localhost:8889",
    mediaMtxApiUrl: process.env.MEDIAMTX_API_URL ?? "http://localhost:9997",
    mediaMtxPlaybackUrl: process.env.MEDIAMTX_PLAYBACK_URL ?? "http://localhost:9996",
    maxListeners: Number(process.env.MAX_LISTENERS ?? 20),
    djDisconnectGraceMs: Number(process.env.DJ_DISCONNECT_GRACE_MS ?? 60_000),
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL?.trim() || null,
    secureCookies: process.env.NODE_ENV === "production",
    loginWindowMs: Number(process.env.LOGIN_WINDOW_MS ?? 15 * 60_000),
    loginClientFailureLimit: Number(process.env.LOGIN_CLIENT_FAILURE_LIMIT ?? 10),
    loginGlobalFailureLimit: Number(process.env.LOGIN_GLOBAL_FAILURE_LIMIT ?? 200),
    loginTrackedClientLimit: Number(process.env.LOGIN_TRACKED_CLIENT_LIMIT ?? 10_000),
    transcodeMaxActive: Number(process.env.TRANSCODE_MAX_ACTIVE ?? 2),
    transcodeMaxQueued: Number(process.env.TRANSCODE_MAX_QUEUED ?? 4),
    transcodeQueueWaitMs: Number(process.env.TRANSCODE_QUEUE_WAIT_MS ?? 5_000),
    transcodeTimeoutMs: Number(process.env.TRANSCODE_TIMEOUT_MS ?? 15 * 60_000),
    recordingsPath: process.env.RECORDINGS_PATH ?? "/recordings",
    recordingSessionMaxBytes: Number(process.env.RECORDING_SESSION_MAX_BYTES ?? 8 * 1024 ** 3),
    recordingArchiveMaxBytes: Number(process.env.RECORDING_ARCHIVE_MAX_BYTES ?? 256 * 1024 ** 3),
    recordingHostFreeFloorBytes: Number(process.env.RECORDING_HOST_FREE_FLOOR_BYTES ?? 100 * 1024 ** 3),
    recordingHostFreeWarningBytes: Number(process.env.RECORDING_HOST_FREE_WARNING_BYTES ?? 150 * 1024 ** 3),
    recordingArchiveWarningRatio: Number(process.env.RECORDING_ARCHIVE_WARNING_RATIO ?? 0.9),
    recordingActiveScanMs: Number(process.env.RECORDING_ACTIVE_SCAN_MS ?? 5_000),
    recordingArchiveScanMs: Number(process.env.RECORDING_ARCHIVE_SCAN_MS ?? 60_000),
    recordingIngressMaxBytesPerSecond: Number(process.env.RECORDING_INGRESS_MAX_BYTES_PER_SECOND ?? 128 * 1024),
    recordingIngressWindowMs: Number(process.env.RECORDING_INGRESS_WINDOW_MS ?? 30_000),
    recordingIngressConsecutiveViolations: Number(process.env.RECORDING_INGRESS_CONSECUTIVE_VIOLATIONS ?? 2),
    ...overrides,
  };
}

export function assertProductionConfig(config: AppConfig): void {
  if (process.env.NODE_ENV !== "production") return;

  const unsafe = [
    config.adminPassword.startsWith("change-me"),
    config.tokenSecret.includes("dev-only"),
    config.mediaAuthSecret.includes("dev-media"),
    config.tokenSecret.length < 32,
    config.mediaAuthSecret.length < 24,
  ];
  if (unsafe.some(Boolean)) {
    throw new Error("Production secrets are missing or unsafe. Check .env.example.");
  }
}
