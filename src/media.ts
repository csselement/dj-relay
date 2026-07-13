export type MediaConnectionState = "connecting" | "connected" | "reconnecting" | "closed";

type MediaCallbacks = {
  onState: (state: MediaConnectionState, message?: string) => void;
  onTrack?: (stream: MediaStream) => void;
};

export const LISTENER_JITTER_BUFFER_MS = 500;

export function configureListenerBuffer(receiver: RTCRtpReceiver, targetMs = LISTENER_JITTER_BUFFER_MS): boolean {
  if (!("jitterBufferTarget" in receiver)) return false;
  try {
    receiver.jitterBufferTarget = targetMs;
    return true;
  } catch {
    // Browsers can expose the draft property without accepting writes.
    return false;
  }
}

function authorization(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

function parseIceServers(link: string | null): RTCIceServer[] {
  if (!link) return [];
  return link.split(/,\s*(?=<)/).flatMap((item) => {
    const url = item.match(/<([^>]+)>/)?.[1];
    if (!url) return [];
    const username = item.match(/username="((?:\\.|[^"])*)"/)?.[1];
    const credential = item.match(/credential="((?:\\.|[^"])*)"/)?.[1];
    return [{
      urls: url,
      ...(username ? { username: JSON.parse(`"${username}"`) as string } : {}),
      ...(credential ? { credential: JSON.parse(`"${credential}"`) as string } : {}),
    }];
  });
}

async function iceServers(endpoint: string, token: string): Promise<RTCIceServer[]> {
  const response = await fetch(endpoint, { method: "OPTIONS", headers: authorization(token) });
  if (!response.ok) throw new Error(`Media server unavailable (${response.status})`);
  return parseIceServers(response.headers.get("Link"));
}

function tuneOpus(sdp: string, bitrateKbps = 192): string {
  const lines = sdp.split("\r\n");
  const opus = lines.find((line) => line.startsWith("a=rtpmap:") && line.toLowerCase().includes("opus/48000"));
  const payload = opus?.slice("a=rtpmap:".length).split(" ")[0];
  if (!payload) return sdp;
  const index = lines.findIndex((line) => line.startsWith(`a=fmtp:${payload} `));
  const settings = `stereo=1;sprop-stereo=1;maxplaybackrate=48000;maxaveragebitrate=${bitrateKbps * 1024}`;
  if (index >= 0) {
    const existing = lines[index].split(" ").slice(1).join(" ");
    const preserved = existing.split(";").filter((entry) =>
      !entry.startsWith("stereo=") && !entry.startsWith("sprop-stereo=") &&
      !entry.startsWith("maxplaybackrate=") && !entry.startsWith("maxaveragebitrate="),
    );
    lines[index] = `a=fmtp:${payload} ${[...preserved, settings].filter(Boolean).join(";")}`;
  } else {
    const insertAt = lines.findIndex((line) => line.startsWith(`a=rtpmap:${payload} `));
    lines.splice(insertAt + 1, 0, `a=fmtp:${payload} ${settings}`);
  }
  return lines.join("\r\n");
}

function waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 6000): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = window.setTimeout(done, timeoutMs);
    function done() {
      window.clearTimeout(timeout);
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    }
    function onChange() {
      if (pc.iceGatheringState === "complete") done();
    }
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

class WebRtcHttpSession {
  private pc: RTCPeerConnection | null = null;
  private sessionUrl: string | null = null;
  private stopped = false;
  private retryTimer: number | null = null;

  constructor(
    private readonly mode: "publish" | "read",
    private readonly endpoint: string,
    private readonly token: string,
    private readonly callbacks: MediaCallbacks,
    private readonly stream?: MediaStream,
  ) {}

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  close(): void {
    this.stopped = true;
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
    this.pc?.close();
    this.pc = null;
    if (this.sessionUrl) void fetch(this.sessionUrl, { method: "DELETE", headers: authorization(this.token) });
    this.sessionUrl = null;
    this.callbacks.onState("closed");
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.callbacks.onState(this.pc ? "reconnecting" : "connecting");
    this.pc?.close();

    try {
      const endpoint = new URL(this.endpoint, window.location.origin).toString();
      const pc = new RTCPeerConnection({ iceServers: await iceServers(endpoint, this.token) });
      this.pc = pc;
      pc.addEventListener("connectionstatechange", () => {
        if (this.stopped || pc !== this.pc) return;
        if (pc.connectionState === "connected") this.callbacks.onState("connected");
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          this.scheduleRetry("Connection lost");
        }
      });

      if (this.mode === "publish") {
        const stream = this.stream;
        if (!stream) throw new Error("No audio input is selected");
        stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));
      } else {
        const transceiver = pc.addTransceiver("audio", { direction: "recvonly" });
        configureListenerBuffer(transceiver.receiver);
        pc.addEventListener("track", (event) => {
          configureListenerBuffer(event.receiver);
          const remote = event.streams[0] ?? new MediaStream([event.track]);
          this.callbacks.onTrack?.(remote);
        });
      }

      const offer = await pc.createOffer();
      await pc.setLocalDescription({ type: "offer", sdp: tuneOpus(offer.sdp ?? "") });
      await waitForIceGathering(pc);
      if (this.stopped || pc !== this.pc) return;

      const response = await fetch(endpoint, {
        method: "POST",
        headers: { ...authorization(this.token), "Content-Type": "application/sdp" },
        body: pc.localDescription?.sdp,
      });
      if (response.status !== 201) {
        const details = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(details?.error ?? (response.status === 404 ? "The DJ is not live yet" : `Media connection failed (${response.status})`));
      }
      const location = response.headers.get("Location");
      if (location?.startsWith("/") && !location.startsWith("/media/")) {
        const endpointUrl = new URL(endpoint);
        const prefix = endpointUrl.pathname.split("/").slice(0, -2).join("/");
        this.sessionUrl = new URL(`${prefix}${location}`, endpointUrl.origin).toString();
      } else {
        this.sessionUrl = new URL(location ?? endpoint, endpoint).toString();
      }
      const answer = await response.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
    } catch (error) {
      this.scheduleRetry(error instanceof Error ? error.message : "Media connection failed");
    }
  }

  private scheduleRetry(message: string): void {
    if (this.stopped || this.retryTimer) return;
    this.pc?.close();
    this.pc = null;
    this.callbacks.onState("reconnecting", message);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, 2500);
  }
}

export class WhipPublisher {
  private readonly session: WebRtcHttpSession;
  constructor(endpoint: string, token: string, stream: MediaStream, callbacks: MediaCallbacks) {
    this.session = new WebRtcHttpSession("publish", endpoint, token, callbacks, stream);
  }
  start(): void { this.session.start(); }
  close(): void { this.session.close(); }
}

export class WhepReader {
  private readonly session: WebRtcHttpSession;
  constructor(endpoint: string, token: string, callbacks: MediaCallbacks) {
    this.session = new WebRtcHttpSession("read", endpoint, token, callbacks);
  }
  start(): void { this.session.start(); }
  close(): void { this.session.close(); }
}
