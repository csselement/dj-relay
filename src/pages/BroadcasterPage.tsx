import { useEffect, useRef, useState } from "react";
import { Button, Select, Tag } from "antd";
import { sessionApi } from "../api";
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
  const [connection, setConnection] = useState<MediaConnectionState | "idle">("idle");
  const [connectionMessage, setConnectionMessage] = useState("");
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [endArmed, setEndArmed] = useState(false);
  const [testState, setTestState] = useState<"idle" | "recording" | "ready">("idle");
  const [testUrl, setTestUrl] = useState("");
  const connected = connection === "connected";
  const broadcasting = connection === "connecting" || connection === "connected" || connection === "reconnecting";
  const signalDetected = Math.max(...levels) > 0.055;

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
    if (!endArmed) {
      setEndArmed(true);
      window.setTimeout(() => setEndArmed(false), 3500);
      return;
    }
    publisherRef.current?.close();
    publisherRef.current = null;
    setConnection("closed");
    await sessionApi.setState("ended");
    await refresh();
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

  if (broadcasting || connection === "closed") {
    const stateText = connected ? "Connection stable" : connection === "reconnecting" ? "Reconnecting…" :
      connection === "connecting" ? "Connecting…" : "Broadcast ended";
    return (
      <AppShell>
        <div className="live-view">
          <h1 className="live-heading">You’re live</h1>
          <h2 className="session-name">{data.session.name}</h2>
          <div className="timer" aria-label="Broadcast duration">{formatElapsed(data.session.startedAt ?? startedAt, now)}</div>
          <StereoMeter levels={levels} />
          <Tag className={`connection-state ${connected ? "is-good" : "is-warn"}`} color={connected ? "success" : "warning"}>{stateText}</Tag>
          {connectionMessage && connection === "reconnecting" && <p className="connection-detail">{connectionMessage}</p>}
          <p className="listener-count"><span className="listener-icon" aria-hidden="true" />{data.session.listenerCount} listening</p>
          <Button className={`primary-button danger-button ${endArmed ? "is-armed" : ""}`} type="primary" danger onClick={() => void endBroadcast()}>
            {endArmed ? "Click again to end" : "End broadcast"}
          </Button>
        </div>
      </AppShell>
    );
  }

  if (audio.permission !== "granted") {
    return (
      <AppShell>
        <div className="permission-view">
          <h1>Choose your audio</h1>
          <p className="intro-copy">Connect your mixer or audio interface, then allow access to select it.</p>
          <Button className="primary-button success-button" type="primary" loading={audio.permission === "requesting"} onClick={() => void audio.request()}>
            {audio.permission === "requesting" ? "Waiting for permission…" : "Allow audio access"}
          </Button>
          {audio.error && <InlineNotice tone="danger">{audio.error}</InlineNotice>}
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="ready-view">
        <h1>Choose your audio</h1>
        <p className="intro-copy">Connect your mixer or audio interface, then select it below.</p>
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
        <Button className="primary-button success-button" type="primary" onClick={() => void startBroadcast()} disabled={!audio.stream}>Start broadcast</Button>
        <Button className="link-button" type="link" onClick={testAudio} disabled={testState === "recording"}>
          {testState === "recording" ? "Recording 5-second test…" : "Test my audio"}
        </Button>
        {testState === "ready" && <audio className="test-player" src={testUrl} controls autoPlay aria-label="Audio input test playback" />}
        {connectionMessage && <InlineNotice tone="danger">{connectionMessage}</InlineNotice>}
        {audio.error && <InlineNotice tone="danger">{audio.error}</InlineNotice>}
      </div>
    </AppShell>
  );
}

function MessageScreen({ title, message }: { title: string; message: string }) {
  return <AppShell footer=""><div className="message-view"><h1>{title}</h1><p className="intro-copy">{message}</p></div></AppShell>;
}
