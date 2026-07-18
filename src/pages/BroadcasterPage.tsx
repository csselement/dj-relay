import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, Select, Tag } from "antd";
import { CaretDown, CopySimple } from "@phosphor-icons/react";
import { sessionApi } from "../api";
import { copyText } from "../clipboard";
import { AnimatedText } from "../components/AnimatedText";
import { AppShell } from "../components/AppShell";
import { InlineNotice } from "../components/InlineNotice";
import { StereoMeter } from "../components/StereoMeter";
import { useAudioInput } from "../hooks/useAudioInput";
import { useSession } from "../hooks/useSession";
import { useStereoMeter } from "../hooks/useStereoMeter";
import { WhipPublisher, type MediaConnectionState } from "../media";

function formatElapsed(startedAt: string | null, now: number): string {
  const elapsed = startedAt ? Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000)) : 0;
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

export function BroadcasterPage() {
  const { data, error: sessionError, refresh } = useSession("dj");
  const audio = useAudioInput();
  const levels = useStereoMeter(audio.stream);
  const publisherRef = useRef<WhipPublisher | null>(null);
  const setupPageRef = useRef<HTMLDivElement>(null);
  const livePageRef = useRef<HTMLDivElement>(null);
  const [connection, setConnection] = useState<MediaConnectionState | "idle">("idle");
  const [connectionMessage, setConnectionMessage] = useState("");
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [ending, setEnding] = useState(false);
  const [testState, setTestState] = useState<"idle" | "recording" | "ready">("idle");
  const [testUrl, setTestUrl] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [shareError, setShareError] = useState("");
  const [copied, setCopied] = useState(false);
  const [stageHeight, setStageHeight] = useState<number>();
  const connected = connection === "connected";
  const broadcasting = connection === "connecting" || connection === "connected" || connection === "reconnecting";
  const showLiveStage = broadcasting || connection === "closed";
  const signalDetected = Math.max(...levels) > 0.055;

  useLayoutEffect(() => {
    if (audio.permission !== "granted") return;
    const activePage = showLiveStage ? livePageRef.current : setupPageRef.current;
    if (!activePage) return;

    const updateHeight = () => setStageHeight(activePage.scrollHeight);
    updateHeight();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateHeight);
    observer.observe(activePage);
    return () => observer.disconnect();
  }, [audio.permission, data?.session.id, showLiveStage]);

  useEffect(() => {
    if (!broadcasting) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [broadcasting]);

  useEffect(() => {
    if (!connected) return;
    const frame = requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "auto" }));
    return () => cancelAnimationFrame(frame);
  }, [connected]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!broadcasting) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [broadcasting]);

  useEffect(() => () => publisherRef.current?.close(), []);
  useEffect(() => {
    if (!data?.session.id || data.session.state === "ended" || data.session.state === "expired") return;
    void sessionApi.shareLink().then(({ url }) => {
      setShareUrl(url);
      setShareError("");
    }).catch(() => setShareError("Could not create the audience link."));
  }, [data?.session.id]);
  useEffect(() => {
    if (data?.session.state !== "ended") return;
    publisherRef.current?.close();
    publisherRef.current = null;
    setConnection("closed");
  }, [data?.session.state]);
  useEffect(() => () => {
    if (testUrl) URL.revokeObjectURL(testUrl);
  }, [testUrl]);

  const selectedInput = audio.devices.find((device) => device.deviceId === audio.selectedId);
  const inputLabel = selectedInput?.label || "Selected audio input";

  async function startBroadcast() {
    if (!audio.stream) return;
    setConnection("connecting");
    setConnectionMessage("");
    try {
      const credential = await sessionApi.mediaToken();
      const publisher = new WhipPublisher(credential.endpoint, credential.token, audio.stream, {
        onState: (state, message) => {
          setConnection(state);
          setConnectionMessage(message ?? "");
          if (state === "connected") {
            const connectedAt = new Date().toISOString();
            setStartedAt((current) => current ?? connectedAt);
            void sessionApi.setState("live").then(() => refresh());
            if ("wakeLock" in navigator) {
              void navigator.wakeLock.request("screen").catch(() => undefined);
            }
          } else if (state === "reconnecting") {
            void sessionApi.setState("interrupted").then(() => refresh());
          }
        },
      });
      publisherRef.current = publisher;
      publisher.start();
    } catch (caught) {
      setConnection("idle");
      setConnectionMessage(caught instanceof Error ? caught.message : "Could not start the broadcast");
    }
  }

  async function endBroadcast() {
    if (ending) return;
    setEnding(true);
    setConnectionMessage("");
    try {
      await sessionApi.setState("ended");
      publisherRef.current?.close();
      publisherRef.current = null;
      setConnection("closed");
      await refresh();
    } catch (caught) {
      setConnectionMessage(caught instanceof Error ? caught.message : "Could not end the broadcast");
      setEnding(false);
    }
  }

  async function copyShareLink() {
    if (!shareUrl) return;
    try {
      await copyText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setShareError("Could not copy the link. Select the link and copy it manually.");
    }
  }

  function testAudio() {
    if (!audio.stream || testState === "recording") return;
    if (testUrl) URL.revokeObjectURL(testUrl);
    const mimeType = "audio/webm;codecs=opus";
    const recorder = new MediaRecorder(
      audio.stream,
      MediaRecorder.isTypeSupported(mimeType) ? { mimeType } : undefined,
    );
    const chunks: Blob[] = [];
    recorder.addEventListener("dataavailable", (event) => chunks.push(event.data));
    recorder.addEventListener("stop", () => {
      const url = URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType }));
      setTestUrl(url);
      setTestState("ready");
    });
    setTestState("recording");
    recorder.start();
    window.setTimeout(() => recorder.state === "recording" && recorder.stop(), 5000);
  }

  if (sessionError) {
    return <MessageScreen title="Invite link required" message={sessionError} />;
  }
  if (!data) return <MessageScreen title="Loading session" message="Checking your private DJ invite…" />;
  if (data.session.state === "ended") {
    return <MessageScreen title="Broadcast ended" message="This session is closed. You can safely close this tab." />;
  }

  if (audio.permission !== "granted") {
    return (
      <AppShell>
        <div className="permission-view">
          <h1>Choose your audio</h1>
          <p className="intro-copy">Connect your mixer or audio interface, then allow access to select it.</p>
          {data.session.recording.requested && <InlineNotice tone="neutral">This session will be recorded and saved for private replay.</InlineNotice>}
          <Button className="primary-button success-button" type="primary" loading={audio.permission === "requesting"} onClick={() => void audio.request()}>
            {audio.permission === "requesting" ? "Waiting for permission…" : "Allow audio access"}
          </Button>
          {audio.error && <InlineNotice tone="danger">{audio.error}</InlineNotice>}
          <DjQuickStart />
        </div>
      </AppShell>
    );
  }

  const stateText = connected ? "Connection stable" : connection === "reconnecting" ? "Reconnecting…" :
    connection === "connecting" ? "Connecting…" : "Broadcast ended";

  return (
    <AppShell>
      <div className="broadcast-stage t-page-slide" data-page={showLiveStage ? "2" : "1"} style={stageHeight === undefined ? undefined : { height: stageHeight }}>
        <div className="ready-view t-page broadcast-setup-page" data-page-id="1" ref={setupPageRef} aria-hidden={showLiveStage} inert={showLiveStage}>
          <h1>Choose your audio</h1>
          <p className="intro-copy">Connect your mixer or audio interface, then select it below.</p>
          {data.session.recording.requested && <InlineNotice tone="neutral">This session will be recorded and saved for private replay.</InlineNotice>}
          <label className="field-label" htmlFor="audio-input">Audio input</label>
          <Select
            id="audio-input"
            value={audio.selectedId}
            onChange={(value) => void audio.select(value)}
            options={audio.devices.map((device) => ({ value: device.deviceId, label: device.label || "Audio input" }))}
          />
          <div className="meter-with-status">
            <StereoMeter levels={levels} />
            <Tag className={signalDetected ? "signal-good" : "signal-waiting"} color={signalDetected ? "success" : "default"}>{signalDetected ? "Signal detected" : "Play audio to check signal"}</Tag>
          </div>
          <p className="input-detail">{inputLabel} · {audio.channels === 2 ? "Stereo" : audio.channels ? `${audio.channels} channel` : "Channel count unknown"}{audio.sampleRate ? ` · ${Math.round(audio.sampleRate / 1000)} kHz` : ""}</p>
          <Button className="primary-button success-button" type="primary" onClick={() => void startBroadcast()} disabled={!audio.stream}>
            {data.session.recording.requested ? "Start broadcast and recording" : "Start broadcast"}
          </Button>
          <Button className="link-button" type="link" onClick={testAudio} disabled={testState === "recording"}>
            {testState === "recording" ? "Recording 5-second test…" : "Test my audio"}
          </Button>
          {testState === "ready" && <audio className="test-player" src={testUrl} controls autoPlay aria-label="Audio input test playback" />}
          {connectionMessage && <InlineNotice tone="danger">{connectionMessage}</InlineNotice>}
          {audio.error && <InlineNotice tone="danger">{audio.error}</InlineNotice>}
          <DjQuickStart />
        </div>
        <div className="live-view t-page broadcast-live-page" data-page-id="2" ref={livePageRef} aria-hidden={!showLiveStage} inert={!showLiveStage}>
          <h1 className="live-heading">You’re live</h1>
          <h2 className="session-name">{data.session.name}</h2>
          {data.session.recording.requested && <Tag className="live-recording-tag" color="error"><span className="recording-dot" aria-hidden="true" />Recording</Tag>}
          <div className="timer" aria-label="Broadcast duration">{formatElapsed(data.session.startedAt ?? startedAt, now)}</div>
          <StereoMeter levels={levels} />
          <Tag className={`connection-state ${connected ? "is-good" : "is-warn"}`} color={connected ? "success" : "warning"}><AnimatedText value={stateText} /></Tag>
          {connectionMessage && connection === "reconnecting" && <p className="connection-detail">{connectionMessage}</p>}
          <p className="listener-count"><span className="listener-icon" aria-hidden="true" />{data.session.listenerCount} listening</p>
          {shareUrl && (
            <section className="listener-share broadcast-share" aria-labelledby="broadcast-share-label">
              <div className="listener-share-copy">
                <strong id="broadcast-share-label">Audience link</strong>
                <a href={shareUrl} target="_blank" rel="noreferrer">{shareUrl}</a>
                <span>Anyone with this link can listen.</span>
              </div>
              <Button className="copy-button listener-copy-button" onClick={() => void copyShareLink()}>
                <CopySimple size={18} weight="bold" aria-hidden="true" />
                <AnimatedText value={copied ? "Copied" : "Copy link"} />
              </Button>
            </section>
          )}
          {shareError && <InlineNotice tone="danger">{shareError}</InlineNotice>}
          <Button className="primary-button danger-button" type="primary" danger loading={ending} onClick={() => void endBroadcast()}>
            {ending ? "Ending broadcast…" : "End broadcast"}
          </Button>
        </div>
      </div>
    </AppShell>
  );
}

function DjQuickStart() {
  const [routingOpen, setRoutingOpen] = useState(false);

  return (
    <aside className="dj-help" aria-labelledby="dj-help-title">
      <h2 id="dj-help-title">First time? Start here.</h2>
      <ol className="dj-help-steps">
        <li><strong>Connect</strong> your mixer or audio interface to this computer.</li>
        <li><strong>Allow</strong> audio access, select the input, then play a track and check for signal.</li>
        <li><strong>Go live</strong> by clicking Start broadcast. Keep this tab open.</li>
      </ol>
      <div className={`dj-help-routing ${routingOpen ? "is-open" : ""}`}>
        <button className="dj-help-routing-summary" type="button" aria-expanded={routingOpen} aria-controls="dj-help-routing-content" onClick={() => setRoutingOpen((open) => !open)}>
          <span>Playing music only from this Mac?</span>
          <CaretDown className="dj-help-routing-chevron" size={16} weight="bold" aria-hidden="true" />
        </button>
        <div className="dj-help-routing-grid" id="dj-help-routing-content" aria-hidden={!routingOpen} inert={!routingOpen}>
          <div className="dj-help-routing-body">
            <div className="dj-help-routing-inner">
              <p>Use this only when your mixer or interface is not available as an input.</p>
              <ol>
                <li>Install <a href="https://existential.audio/blackhole/download/" target="_blank" rel="noreferrer">BlackHole 2ch</a>, then reopen your audio apps.</li>
                <li>Open <strong>Audio MIDI Setup</strong> → Window → Show Audio Devices.</li>
                <li>Click <strong>+</strong> → Create Multi-Output Device. Check BlackHole 2ch and your headphones or interface.</li>
                <li>Make your headphones or interface the Primary Device. Turn on Drift Correction for BlackHole.</li>
                <li>In your DJ app, choose the Multi-Output Device. Here, choose BlackHole 2ch as the Audio input.</li>
              </ol>
              <a className="dj-help-link" href="https://support.apple.com/guide/audio-midi-setup/play-audio-through-multiple-devices-at-once-ams7c093f372/mac" target="_blank" rel="noreferrer">Apple’s Multi-Output Device guide</a>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}

function MessageScreen({ title, message }: { title: string; message: string }) {
  return <AppShell footer=""><div className="message-view"><h1>{title}</h1><p className="intro-copy">{message}</p></div></AppShell>;
}
