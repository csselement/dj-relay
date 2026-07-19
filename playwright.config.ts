import { defineConfig, devices } from "@playwright/test";

const fakeAudioFile = process.env.E2E_AUDIO_FILE;
const externalServer = process.env.E2E_EXTERNAL_SERVER === "1";
const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  outputDir: "output/playwright",
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
      command: "NODE_ENV=production ADMIN_PASSWORD=e2e-owner-password TOKEN_SECRET=e2e-token-secret-with-at-least-thirty-two-bytes MEDIAMTX_AUTH_SECRET=e2e-media-auth-secret-with-padding DATABASE_PATH=:memory: RECORDINGS_PATH=./data RECORDING_HOST_FREE_FLOOR_BYTES=0 RECORDING_HOST_FREE_WARNING_BYTES=0 sh -c 'npm run build && exec node dist/server/index.js'",
      url: "http://127.0.0.1:3000/api/health",
      reuseExistingServer: false,
      timeout: 60_000,
    },
  }),
});
