import { expect, test } from "@playwright/test";

const ownerPassword = process.env.E2E_OWNER_PASSWORD ?? "e2e-owner-password";
const mediaAuthSecret = process.env.E2E_MEDIA_AUTH_SECRET ?? "e2e-media-auth-secret";

test("theme defaults to dark and persists a light-mode choice", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("button", { name: "Use light mode" })).toBeVisible();

  await page.getByRole("button", { name: "Use light mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByRole("button", { name: "Use dark mode" })).toBeVisible();

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("owner creates a session and DJ reaches the ready screen", async ({ page, context }) => {
  const sessionName = `Saturday Night Relay ${Date.now()}`;
  await page.goto("/admin");
  await expect(page).toHaveTitle("DJ Relay");
  await page.getByLabel("Owner password").fill(ownerPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();

  await page.getByLabel("Session name").fill(sessionName);
  await page.getByRole("button", { name: "Create session" }).click();
  const djUrl = await page.locator(".copy-row").filter({ hasText: "DJ invite" }).locator("code").textContent();
  expect(djUrl).toBeTruthy();

  const listenerPagePromise = context.waitForEvent("page");
  await page.getByRole("link", { name: `Open ${sessionName} listener page` }).click();
  const listener = await listenerPagePromise;
  await expect(listener).toHaveURL(/\/listen$/);
  await expect(listener.getByRole("heading", { name: sessionName })).toBeVisible();
  await listener.close();

  const dj = await context.newPage();
  await dj.goto(djUrl!);
  await expect(dj.getByRole("heading", { name: "Choose your audio" })).toBeVisible();
  await dj.getByRole("button", { name: "Allow audio access" }).click();
  await expect(dj.getByLabel("Audio input")).toBeVisible();
  await expect(dj.getByRole("button", { name: "Start broadcast" })).toBeEnabled();
  await expect(dj.getByText(/Stereo|channel/)).toBeVisible();
  await dj.setViewportSize({ width: 390, height: 844 });
  await expect(dj.getByRole("button", { name: "Start broadcast" })).toBeVisible();
  const hasHorizontalOverflow = await dj.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(hasHorizontalOverflow).toBe(false);
  await dj.screenshot({ path: "/tmp/dj-relay-mobile.png" });
});

test("ended sessions retain the number of individual listener browsers", async ({ page, browser, request }) => {
  const sessionName = `Audience history ${Date.now()}`;
  await page.goto("/admin");
  await page.getByLabel("Owner password").fill(ownerPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("Session name").fill(sessionName);
  await page.getByRole("button", { name: "Create session" }).click();

  const listenerUrl = await page.locator(".copy-row").filter({ hasText: "Listener invite" }).locator("code").textContent();
  expect(listenerUrl).toBeTruthy();

  for (let index = 0; index < 2; index += 1) {
    const listenerContext = await browser.newContext();
    const listener = await listenerContext.newPage();
    await listener.goto(listenerUrl!);
    await expect(listener.getByRole("heading", { name: sessionName })).toBeVisible();
    const credential = await listener.evaluate(async () => {
      const response = await fetch("/api/session/media-token", { method: "POST" });
      return response.json() as Promise<{ token: string; path: string }>;
    });
    const auth = await request.post(`/internal/mediamtx-auth?secret=${mediaAuthSecret}`, {
      data: { token: credential.token, action: "read", path: credential.path },
    });
    expect(auth.ok()).toBe(true);
    await listenerContext.close();
  }

  const row = page.locator(".session-row").filter({ hasText: sessionName });
  await row.getByRole("button", { name: "End" }).click();
  await expect(row).toContainText("ended · 2 people listened");
});

test("invalid invite fails clearly", async ({ page }) => {
  await page.goto("/s/not-a-real-invite");
  await expect(page.getByRole("heading", { name: "Invite unavailable" })).toBeVisible();
  await expect(page.getByText("This invite is invalid, expired, or ended")).toBeVisible();
});
