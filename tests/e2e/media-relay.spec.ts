import { expect, test } from "@playwright/test";

test.skip(process.env.E2E_MEDIA !== "1", "Requires the local MediaMTX validation container");
const ownerPassword = process.env.E2E_OWNER_PASSWORD ?? "e2e-owner-password";

test("relays browser audio from a DJ to a listener and ends cleanly", async ({ page, context, browser }) => {
  await page.goto("/admin");
  await page.getByLabel("Owner password").fill(ownerPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
  await page.getByLabel("Session name").fill("Saturday Night Relay");
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
  await dj.getByRole("button", { name: "Start broadcast" }).click();
  await expect(dj.getByRole("heading", { name: "You’re live" })).toBeVisible({ timeout: 15_000 });
  await expect(dj.getByText("Connection stable")).toBeVisible({ timeout: 15_000 });
  await dj.screenshot({ path: "/tmp/dj-relay-live.png" });

  const listenerContext = await browser.newContext({
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000",
    ignoreHTTPSErrors: process.env.E2E_EXTERNAL_SERVER === "1",
  });
  const listener = await listenerContext.newPage();
  await listener.goto(listenerUrl!);
  await expect(listener.getByRole("heading", { name: "Saturday Night Relay" })).toBeVisible();
  await listener.getByRole("button", { name: "Listen live" }).click();
  await expect(listener.getByText("Connection stable")).toBeVisible({ timeout: 15_000 });
  const receivedChannels = await listener.locator("audio").evaluate((element) => {
    const stream = (element as HTMLAudioElement).srcObject as MediaStream | null;
    return stream?.getAudioTracks()[0]?.getSettings().channelCount;
  });
  expect(receivedChannels).toBe(2);
  await expect(dj.getByText("1 listening")).toBeVisible({ timeout: 10_000 });

  await dj.getByRole("button", { name: "End broadcast" }).click();
  await expect(dj.getByRole("button", { name: "Click again to end" })).toBeVisible();
  await dj.getByRole("button", { name: "Click again to end" }).click();
  await expect(listener.getByRole("heading", { name: "Broadcast ended" })).toBeVisible({ timeout: 10_000 });
  await listenerContext.close();
});
