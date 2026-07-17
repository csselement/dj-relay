import { expect, test } from "@playwright/test";

test.skip(process.env.E2E_MEDIA !== "1", "Requires the local MediaMTX validation container");
const ownerPassword = process.env.E2E_OWNER_PASSWORD ?? "e2e-owner-password";

test("records a browser relay, replays it, and deletes the archive", async ({ page, context, browser }) => {
  const sessionName = `Recorded relay ${Date.now()}`;
  await page.goto("/admin");
  await page.getByLabel("Producer password").fill(ownerPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
  await page.getByLabel("Session name").fill(sessionName);
  await page.getByLabel("Record this session").check();
  await page.getByRole("button", { name: "Create session" }).click();

  const djUrl = await page.locator(".copy-row").filter({ hasText: "DJ invite" }).locator("code").textContent();
  const listenerUrl = await page.locator(".copy-row").filter({ hasText: "Listener invite" }).locator("code").textContent();
  expect(djUrl).toBeTruthy();
  expect(listenerUrl).toBeTruthy();

  const dj = await context.newPage();
  await dj.setViewportSize({ width: 1440, height: 900 });
  await dj.goto(djUrl!);
  await dj.getByRole("button", { name: "Allow audio access" }).click();
  await expect(dj.getByLabel("Audio input")).toBeVisible();
  await expect(dj.getByText("Signal detected")).toBeVisible({ timeout: 5_000 });
  await expect(dj.getByText(/Stereo/)).toBeVisible();
  await dj.screenshot({ path: "/tmp/dj-relay-ready.png" });
  await expect(dj.getByText("This session will be recorded")).toBeVisible();
  const initialWhipResponse = dj.waitForResponse((response) => response.status() === 201 && response.url().includes("/whip"));
  await dj.getByRole("button", { name: "Start broadcast and recording" }).click();
  await expect(dj.getByRole("heading", { name: "You’re live" })).toBeVisible({ timeout: 15_000 });
  await expect(dj.getByText("Connection stable")).toBeVisible({ timeout: 15_000 });
  const whipResponse = await initialWhipResponse;
  await dj.screenshot({ path: "/tmp/dj-relay-live.png" });

  const listenerContext = await browser.newContext({
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000",
    ignoreHTTPSErrors: process.env.E2E_EXTERNAL_SERVER === "1",
  });
  const listener = await listenerContext.newPage();
  await listener.goto(listenerUrl!);
  await expect(listener.getByRole("heading", { name: sessionName })).toBeVisible();
  await listener.getByRole("button", { name: "Listen live" }).click();
  await expect(listener.getByText("Connection stable")).toBeVisible({ timeout: 15_000 });
  const receivedChannels = await listener.locator("audio").evaluate((element) => {
    const stream = (element as HTMLAudioElement).srcObject as MediaStream | null;
    return stream?.getAudioTracks()[0]?.getSettings().channelCount;
  });
  expect(receivedChannels).toBe(2);
  await expect(dj.getByText("1 listening")).toBeVisible({ timeout: 10_000 });

  const location = whipResponse.headers()["location"];
  const authorization = whipResponse.request().headers()["authorization"];
  if (!location || !authorization) throw new Error("WHIP response did not expose its session credentials");
  const endpoint = new URL(whipResponse.url());
  const prefix = endpoint.pathname.split("/").slice(0, -2).join("/");
  const sessionUrl = location.startsWith("/") && !location.startsWith("/media/")
    ? new URL(`${prefix}${location}`, endpoint.origin).toString()
    : new URL(location, endpoint).toString();
  await dj.evaluate(async ({ sessionUrl: url, authorization: auth }) => {
    const response = await fetch(url, { method: "DELETE", headers: { Authorization: auth } });
    if (!response.ok) throw new Error(`Could not interrupt WHIP session (${response.status})`);
  }, { sessionUrl, authorization });
  await dj.close();
  await page.waitForTimeout(1_000);
  const reconnectedDj = await context.newPage();
  await reconnectedDj.goto(djUrl!);
  await reconnectedDj.getByRole("button", { name: "Allow audio access" }).click();
  await expect(reconnectedDj.getByText("Signal detected")).toBeVisible({ timeout: 5_000 });
  await reconnectedDj.getByRole("button", { name: "Start broadcast and recording" }).click();
  await expect(reconnectedDj.getByRole("heading", { name: "You’re live" })).toBeVisible({ timeout: 15_000 });
  await expect(reconnectedDj.getByText("Connection stable")).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(2_000);

  await reconnectedDj.getByRole("button", { name: "End broadcast" }).click();
  await expect(listener.getByText("Replay ready")).toBeVisible({ timeout: 45_000 });
  await expect(listener.locator("audio")).toHaveAttribute("src", /\/api\/session\/recording\/parts\/0/);
  const recordingMetadata = await listener.evaluate(async () => {
    const response = await fetch("/api/session/recording");
    return response.json() as Promise<{ recording: { partCount: number }; parts: unknown[] }>;
  });
  expect(recordingMetadata.recording.partCount).toBeGreaterThanOrEqual(2);
  expect(recordingMetadata.parts).toHaveLength(recordingMetadata.recording.partCount);
  await expect(listener.getByText(new RegExp(`Part 1 of ${recordingMetadata.recording.partCount}`))).toBeVisible();
  const replayResponse = await listener.evaluate(async () => {
    const response = await fetch("/api/session/recording/parts/0");
    const bytes = await response.arrayBuffer();
    return {
      ok: response.ok,
      size: bytes.byteLength,
      contentType: response.headers.get("content-type"),
    };
  });
  expect(replayResponse.ok).toBe(true);
  expect(replayResponse.size).toBeGreaterThan(0);
  expect(replayResponse.contentType).toContain("video/mp4");
  await listener.screenshot({ path: "/tmp/discus-recording-live-replay.png" });

  await page.getByRole("link", { name: "Recordings" }).click();
  await expect(page.getByRole("heading", { name: "Recordings" })).toBeVisible();
  const recording = page.locator("article").filter({ hasText: sessionName });
  await expect(recording.getByText("Ready")).toBeVisible();
  page.once("dialog", (dialog) => void dialog.accept());
  await recording.getByRole("button", { name: "Delete" }).click();
  await expect(recording).toHaveCount(0, { timeout: 15_000 });
  await expect(listener.getByText("This recording was deleted by the producer.")).toBeVisible({ timeout: 15_000 });
  await listenerContext.close();
});
