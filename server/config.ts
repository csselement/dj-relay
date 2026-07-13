export type AppConfig = {
  port: number;
  databasePath: string;
  adminPassword: string;
  tokenSecret: string;
  mediaAuthSecret: string;
  publicMediaBase: string;
  mediaMtxApiUrl: string;
  maxListeners: number;
  secureCookies: boolean;
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
    maxListeners: Number(process.env.MAX_LISTENERS ?? 20),
    secureCookies: process.env.NODE_ENV === "production",
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
