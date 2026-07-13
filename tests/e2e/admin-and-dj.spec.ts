import { expect, test } from "@playwright/test";

const ownerPassword = process.env.E2E_OWNER_PASSWORD ?? "e2e-owner-password";
const mediaAuthSecret = process.env.E2E_MEDIA_AUTH_SECRET ?? "e2e-media-auth-secret";

test("theme defaults to dark and persists a light-mode choice", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("button", { name: "Use light mode" })).toBeVisible();
  await expect(page.getByLabel("DJ Relay home").locator("svg")).toBeVisible();
  await expect(page.getByRole("button", { name: "Use light mode" }).locator("svg")).toBeVisible();

  await page.getByRole("button", { name: "Use light mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByRole("button", { name: "Use dark mode" })).toBeVisible();

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("owner creates a session and DJ reaches the ready screen", async ({ page, context, browser }) => {
  const sessionName = `Saturday Night Relay ${Date.now()}`;
  await page.goto("/admin");
  await expect(page).toHaveTitle("DJ Relay");
  await page.getByLabel("Owner password").fill(ownerPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();

  await page.getByLabel("Session name").fill(sessionName);
  await page.getByRole("button", { name: "Create session" }).click();
  const djUrl = await page.locator(".copy-row").filter({ hasText: "DJ invite" }).locator("code").textContent();
  const listenerUrl = await page.locator(".copy-row").filter({ hasText: "Listener invite" }).locator("code").textContent();
  expect(djUrl).toBeTruthy();
  expect(listenerUrl).toBeTruthy();

  const listenerPagePromise = context.waitForEvent("page");
  await page.getByRole("link", { name: `Open ${sessionName} listener page` }).click();
  const listener = await listenerPagePromise;
  await expect(listener).toHaveURL(/\/listen$/);
  await expect(listener.getByRole("heading", { name: sessionName })).toBeVisible();
  await expect(listener.getByText("Listener invite", { exact: true })).toBeVisible();
  await expect(listener.getByRole("link", { name: /\/s\// })).toHaveAttribute("href", /\/s\//);
  await expect(listener.getByRole("button", { name: "Copy link" })).toBeVisible();
  await listener.getByRole("button", { name: "Copy link" }).click();
  await expect(listener.getByRole("button", { name: "Copied" })).toBeVisible();
  await listener.setViewportSize({ width: 390, height: 844 });
  expect(await listener.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await listener.screenshot({ path: "/tmp/dj-relay-listener-share.png", fullPage: true });
  await listener.close();

  const dj = await context.newPage();
  await dj.goto(djUrl!);
  await expect(dj.getByRole("heading", { name: "Choose your audio" })).toBeVisible();
  await expect(dj.getByRole("heading", { name: "First time? Start here." })).toBeVisible();
  await dj.getByText("Playing music only from this Mac?").click();
  await expect(dj.getByText("Create Multi-Output Device", { exact: false })).toBeVisible();
  await dj.getByRole("button", { name: "Allow audio access" }).click();
  await expect(dj.getByLabel("Audio input")).toBeVisible();
  await expect(dj.getByRole("button", { name: "Start broadcast" })).toBeEnabled();
  await expect(dj.getByText(/Stereo|channel/)).toBeVisible();
  await dj.setViewportSize({ width: 390, height: 844 });
  await dj.getByText("Playing music only from this Mac?").click();
  await expect(dj.getByRole("link", { name: "Apple’s Multi-Output Device guide" })).toBeVisible();
  await expect(dj.getByRole("button", { name: "Start broadcast" })).toBeVisible();
  const hasHorizontalOverflow = await dj.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(hasHorizontalOverflow).toBe(false);
  await dj.screenshot({ path: "/tmp/dj-relay-mobile.png", fullPage: true });

  const observerContext = await browser.newContext();
  const observer = await observerContext.newPage();
  await observer.goto(listenerUrl!);
  await expect(observer.getByRole("heading", { name: sessionName })).toBeVisible();

  const row = page.locator(".session-row").filter({ hasText: sessionName });
  await dj.evaluate(() => fetch("/api/session/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: "live" }),
  }));
  await expect(row).toContainText("live", { timeout: 6_000 });
  await expect(observer.getByRole("button", { name: "Listen live" })).toBeVisible({ timeout: 6_000 });
  await observer.getByRole("button", { name: "Listen live" }).click();
  await expect(observer.getByText("Trying to reconnect")).toBeVisible({ timeout: 10_000 });
  await expect(observer.getByText("no stream is available", { exact: false })).toHaveCount(0);
  await dj.evaluate(() => fetch("/api/session/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: "interrupted" }),
  }));
  await expect(observer.getByText("DJ disconnected", { exact: true })).toBeVisible({ timeout: 6_000 });
  await expect(observer.getByText("Session closes in", { exact: false })).toBeVisible();
  await observer.screenshot({ path: "/tmp/dj-relay-disconnected.png", fullPage: true });
  await dj.evaluate(() => fetch("/api/session/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: "ended" }),
  }));
  await expect(row).toContainText("ended", { timeout: 6_000 });
  await expect(observer.getByRole("heading", { name: "Broadcast ended" })).toBeVisible({ timeout: 6_000 });
  await expect(observer.getByText("The DJ ended this stream.")).toBeVisible();
  await observerContext.close();
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
