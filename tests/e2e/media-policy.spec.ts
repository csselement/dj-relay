import { expect, test } from "@playwright/test";

test.skip(process.env.E2E_MEDIA_POLICY !== "1", "Requires a deployed MediaMTX recording watchdog");
const ownerPassword = process.env.E2E_OWNER_PASSWORD ?? "e2e-owner-password";

test("rejects a recording publisher that advertises video", async ({ page, context }) => {
  test.setTimeout(45_000);
  const sessionName = `Video policy ${Date.now()}`;
  await page.goto("/admin");
  await page.getByLabel("Producer password").fill(ownerPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("Session name").fill(sessionName);
  await expect(page.getByRole("switch", { name: "Record" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Create session" }).click();

  const djUrl = await page.locator(".copy-row").filter({ hasText: "DJ invite" }).locator("code").textContent();
  expect(djUrl).toBeTruthy();
  const dj = await context.newPage();
  await dj.goto(djUrl!);
  await expect(dj.getByRole("heading", { name: "Choose your audio" })).toBeVisible();

  const publishStatus = await dj.evaluate(async () => {
    const credentialResponse = await fetch("/api/session/media-token", {
      method: "POST",
      headers: { "X-Discus-Role": "dj" },
    });
    if (!credentialResponse.ok) throw new Error(`Could not create media credential (${credentialResponse.status})`);
    const credential = await credentialResponse.json() as { endpoint: string; token: string };

    const audioContext = new AudioContext();
    const oscillator = audioContext.createOscillator();
    const audioDestination = audioContext.createMediaStreamDestination();
    oscillator.connect(audioDestination);
    oscillator.start();

    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const drawing = canvas.getContext("2d");
    drawing?.fillRect(0, 0, canvas.width, canvas.height);
    const videoStream = canvas.captureStream(1);
    let frame = 0;
    window.setInterval(() => {
      if (!drawing) return;
      drawing.fillStyle = frame % 2 === 0 ? "#000" : "#fff";
      drawing.fillRect(0, 0, canvas.width, canvas.height);
      frame += 1;
    }, 250);
    const media = new MediaStream([
      ...audioDestination.stream.getAudioTracks(),
      ...videoStream.getVideoTracks(),
    ]);
    const peer = new RTCPeerConnection();
    media.getTracks().forEach((track) => peer.addTrack(track, media));
    await peer.setLocalDescription(await peer.createOffer());
    if (peer.iceGatheringState !== "complete") {
      await new Promise<void>((resolve) => {
        const timeout = window.setTimeout(resolve, 6_000);
        peer.addEventListener("icegatheringstatechange", () => {
          if (peer.iceGatheringState !== "complete") return;
          window.clearTimeout(timeout);
          resolve();
        });
      });
    }
    const response = await fetch(new URL(credential.endpoint, window.location.origin), {
      method: "POST",
      headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/sdp" },
      body: peer.localDescription?.sdp,
    });
    const answer = await response.text();
    if (response.status === 201) {
      await peer.setRemoteDescription({ type: "answer", sdp: answer });
      await fetch("/api/session/state", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Discus-Role": "dj" },
        body: JSON.stringify({ state: "live" }),
      });
      if (peer.connectionState !== "connected") {
        await new Promise<void>((resolve) => {
          const timeout = window.setTimeout(resolve, 10_000);
          peer.addEventListener("connectionstatechange", () => {
            if (peer.connectionState !== "connected") return;
            window.clearTimeout(timeout);
            resolve();
          });
        });
      }
    }
    (window as typeof window & { policyPublisher?: RTCPeerConnection }).policyPublisher = peer;
    return response.status;
  });
  expect(publishStatus).toBe(201);

  await expect.poll(async () => page.evaluate(async (name) => {
    const response = await fetch("/api/admin/sessions?historyLimit=20");
    const payload = await response.json() as {
      sessions: Array<{ id: string; name: string; state: string; terminationCode: string | null }>;
    };
    return payload.sessions.find((session) => session.name === name) ?? null;
  }, sessionName), { timeout: 25_000 }).toMatchObject({
    state: "ended",
    terminationCode: "recording_media_policy",
  });

  await dj.evaluate(() => {
    (window as typeof window & { policyPublisher?: RTCPeerConnection }).policyPublisher?.close();
  });
  const session = await page.evaluate(async (name) => {
    const response = await fetch("/api/admin/sessions?historyLimit=20");
    const payload = await response.json() as { sessions: Array<{ id: string; name: string }> };
    return payload.sessions.find((candidate) => candidate.name === name) ?? null;
  }, sessionName);
  expect(session).toBeTruthy();
  const deleted = await page.evaluate(async (id) => fetch(`/api/admin/sessions/${id}`, { method: "DELETE" }).then((response) => response.status), session!.id);
  expect(deleted).toBe(204);
});
