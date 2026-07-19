import { expect, test, type Page } from "@playwright/test";

const widths = [900, 760, 620, 390] as const;
const states = ["home", "producer-sign-in", "empty-producer", "created-session", "dj-setup", "listener-waiting"] as const;
type VisualState = typeof states[number];

const baseSession = {
  id: "visual-session",
  name: "Saturday Evening Session",
  mediaPath: "session-visual",
  state: "ready",
  createdAt: "2026-07-18T20:00:00.000Z",
  expiresAt: "2026-07-19T04:00:00.000Z",
  startedAt: null,
  endedAt: null,
  endedReason: null,
  terminationCode: null,
  disconnectDeadline: null,
  listenerCount: 0,
  uniqueListenerCount: 0,
  listenerHistoryAvailable: true,
  recording: { requested: false, status: "off", durationSeconds: null, partCount: 0 },
};

const status = {
  mediaMtx: true,
  recording: {
    state: "ok",
    usedBytes: 8_388_608,
    maxBytes: 274_877_906_944,
    freeBytes: 1_717_986_918_400,
    sessionMaxBytes: 8_589_934_592,
    lastSuccessfulScanAt: "2026-07-18T20:00:00.000Z",
  },
  transcode: { active: 0, queued: 0, maxActive: 2, maxQueued: 4 },
};

async function mockState(page: Page, state: VisualState) {
  let created = false;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const fulfill = (body: unknown, responseStatus = 200) => route.fulfill({
      status: responseStatus,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
    if (pathname === "/api/admin/me") return fulfill({ authenticated: state !== "producer-sign-in" });
    if (pathname === "/api/admin/status") return fulfill(status);
    if (pathname === "/api/admin/sessions" && request.method() === "GET") {
      return fulfill({ sessions: created ? [baseSession] : [], history: { loaded: 0, total: 0, hasMore: false } });
    }
    if (pathname === "/api/admin/sessions" && request.method() === "POST") {
      created = true;
      return fulfill({
        session: baseSession,
        djUrl: "https://discus.example/s/private-dj-link",
        listenerUrl: "https://discus.example/s/private-listener-link",
      }, 201);
    }
    if (pathname === "/api/session") {
      return fulfill({ role: state === "dj-setup" ? "dj" : "listener", session: baseSession });
    }
    if (pathname === "/api/session/share-link") return fulfill({ url: "https://discus.example/s/private-listener-link" });
    return fulfill({ error: `Unhandled visual fixture: ${request.method()} ${pathname}` }, 500);
  });
}

function pathFor(state: VisualState): string {
  if (state === "home") return "/";
  if (state === "producer-sign-in" || state === "empty-producer" || state === "created-session") return "/admin";
  if (state === "dj-setup") return "/broadcast";
  return "/listen";
}

for (const state of states) {
  for (const width of widths) {
    test(`${state} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1_000 });
      await page.clock.install({ time: new Date("2026-07-18T20:00:00.000Z") });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await mockState(page, state);
      await page.goto(pathFor(state));

      if (state === "home") await expect(page.getByRole("heading", { name: "A private room for the mix." })).toBeVisible();
      if (state === "producer-sign-in") await expect(page.getByLabel("Producer password")).toBeVisible();
      if (state === "empty-producer") await expect(page.getByText("No sessions yet")).toBeVisible();
      if (state === "created-session") {
        await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
        await page.getByLabel("Session name").fill(baseSession.name);
        await page.getByRole("button", { name: "Create session" }).click();
        await expect(page.locator(".link-panel")).toBeVisible();
      }
      if (state === "dj-setup") await expect(page.getByRole("heading", { name: "Choose your audio" })).toBeVisible();
      if (state === "listener-waiting") await expect(page.getByText("Waiting for DJ", { exact: true })).toBeVisible();

      await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}" });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
      await expect(page).toHaveScreenshot(`${state}-${width}.png`, { fullPage: true, animations: "disabled" });
    });
  }
}

test("home does not load private route modules", async ({ page }) => {
  const scripts: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "script") scripts.push(request.url());
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "A private room for the mix." })).toBeVisible();
  expect(scripts.some((url) => /AdminRoute|BroadcasterRoute|ListenerRoute|InvitePage/.test(url))).toBe(false);
});

test("producer outage recovery does not masquerade as sign-out", async ({ page }) => {
  let unavailable = true;
  await page.route("**/api/admin/me", async (route) => {
    if (unavailable) {
      await route.abort("failed");
      return;
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ authenticated: false }) });
  });

  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Producer console unavailable" })).toBeVisible();
  await expect(page.getByLabel("Producer password")).toHaveCount(0);
  unavailable = false;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByLabel("Producer password")).toBeVisible();
});

test("producer status reports degradation, blocks recording, and signs out", async ({ page }) => {
  let recordingState: "ok" | "blocked" = "ok";
  let authenticated = true;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const fulfill = (body: unknown, responseStatus = 200) => route.fulfill({
      status: responseStatus,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
    if (pathname === "/api/admin/me") return fulfill({ authenticated });
    if (pathname === "/api/admin/sessions") return fulfill({ sessions: [], history: { loaded: 0, total: 0, hasMore: false } });
    if (pathname === "/api/admin/status") return fulfill({
      ...status,
      mediaMtx: false,
      recording: { ...status.recording, state: recordingState },
    });
    if (pathname === "/api/admin/logout" && request.method() === "POST") {
      authenticated = false;
      return fulfill({ ok: true });
    }
    return fulfill({ error: `Unhandled producer fixture: ${request.method()} ${pathname}` }, 500);
  });

  await page.goto("/admin");
  await expect(page.getByText("Media-relay degraded", { exact: true })).toBeVisible();
  await expect(page.getByText(/8\.0 MiB of 256 GiB archived/)).toBeVisible();

  recordingState = "blocked";
  await page.reload();
  await expect(page.getByText("Recording blocked", { exact: true })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Record" })).toBeDisabled();
  await expect(page.getByText(/Delete archived sessions/)).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByLabel("Producer password")).toBeVisible();
});
