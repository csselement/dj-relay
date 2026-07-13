import { defineConfig, devices } from "@playwright/test";

const fakeAudioFile = process.env.E2E_AUDIO_FILE;
const externalServer = process.env.E2E_EXTERNAL_SERVER === "1";
const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: 0,
  reporter: "line",
  use: {
    baseURL,
    ignoreHTTPSErrors: externalServer,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    ...devices["Desktop Chrome"],
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        ...(fakeAudioFile ? [`--use-file-for-fake-audio-capture=${fakeAudioFile}`] : []),
      ],
    },
  },
  ...(externalServer ? {} : {
    webServer: {
      command: "ADMIN_PASSWORD=e2e-owner-password TOKEN_SECRET=e2e-token-secret-with-at-least-thirty-two-bytes MEDIAMTX_AUTH_SECRET=e2e-media-auth-secret DATABASE_PATH=./data/e2e.sqlite npm run dev",
      url: "http://127.0.0.1:3000/api/health",
      reuseExistingServer: true,
      timeout: 30_000,
    },
  }),
});
