import { useEffect, useRef, useState } from "react";
import { Button, Tag } from "antd";
import { CopySimple, WifiSlash } from "@phosphor-icons/react";
import { sessionApi } from "../api";
import { AppShell } from "../components/AppShell";
import { InlineNotice } from "../components/InlineNotice";
import { useSession } from "../hooks/useSession";
import { WhepReader, type MediaConnectionState } from "../media";

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.appendChild(field);
    field.select();
    const copied = document.execCommand("copy");
    field.remove();
    if (!copied) throw new Error("Clipboard unavailable");
  }
}

function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function ListenerPage() {
  const { data, error } = useSession("listener");
  const [connection, setConnection] = useState<MediaConnectionState | "idle">("idle");
  const [message, setMessage] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [shareError, setShareError] = useState("");
  const [copied, setCopied] = useState(false);
  const [hasAudio, setHasAudio] = useState(false);
  const [countdownNow, setCountdownNow] = useState(Date.now());
  const readerRef = useRef<WhepReader | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => () => readerRef.current?.close(), []);
  useEffect(() => {
    if (!data?.session.id || data.session.state === "ended" || data.session.state === "expired") return;
    void sessionApi.shareLink().then(({ url }) => {
      setShareUrl(url);
      setShareError("");
    }).catch(() => setShareError("Could not create the listener invite link."));
  }, [data?.session.id]);
  const waitingForDj = connection === "reconnecting" || data?.session.state === "interrupted";
  useEffect(() => {
    if (!waitingForDj) return;
    setCountdownNow(Date.now());
    const timer = window.setInterval(() => setCountdownNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [waitingForDj, data?.session.disconnectDeadline]);
  useEffect(() => {
    if (data?.session.state !== "ended") return;
    readerRef.current?.close();
    readerRef.current = null;
    setConnection("closed");
  }, [data?.session.state]);

  async function listen() {
    setConnection("connecting");
    setMessage("");
    try {
      const credential = await sessionApi.mediaToken();
      const reader = new WhepReader(credential.endpoint, credential.token, {
        onState: (state, detail) => {
          setConnection(state);
          setMessage(state === "reconnecting" ? "" : detail ?? "");
        },
        onTrack: (stream) => {
          if (!audioRef.current) return;
          setHasAudio(true);
          audioRef.current.srcObject = stream;
          void audioRef.current.play().catch(() => setMessage("Press play to hear the broadcast."));
        },
      });
      readerRef.current = reader;
      reader.start();
    } catch (caught) {
      setConnection("idle");
      setMessage(caught instanceof Error ? caught.message : "Unable to connect");
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

  if (error) return <ListenerMessage title="Invite link required" message={error} />;
  if (!data) return <ListenerMessage title="Loading session" message="Checking your private listener invite…" />;
  if (data.session.state === "ended") {
    const endedMessage = data.session.endedReason === "dj" ? "The DJ ended this stream." :
      data.session.endedReason === "owner" ? "This stream was ended by the host." :
      data.session.endedReason === "timeout" ? "The DJ disconnected and did not return." :
      "This stream has ended.";
    return <ListenerMessage title="Broadcast ended" message={endedMessage} />;
  }

  const live = data.session.state === "live";
  const connected = connection === "connected";
  const deadline = data.session.disconnectDeadline ? new Date(data.session.disconnectDeadline).getTime() : countdownNow + 60_000;
  const remainingSeconds = Math.max(0, Math.ceil((deadline - countdownNow) / 1000));
  const statusLabel = waitingForDj ? "DJ disconnected" : live ? "Live now" : "Waiting for DJ";
  const waitingToStart = !live && !waitingForDj;
  return (
    <AppShell footer="Private session · Share this page only with invited listeners.">
      <div className="listener-view">
        <Tag className={`listener-live-label ${live ? "is-live" : ""} ${waitingForDj ? "is-interrupted" : ""}`} color={live ? "error" : "default"}>
          {statusLabel}
          {waitingToStart && (
            <span className="waiting-activity" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          )}
        </Tag>
        <h1>{data.session.name}</h1>
        <p className="intro-copy">
          {waitingForDj ? "The DJ connection was lost. This page will reconnect automatically." : connected ? "You’re listening live." : live ? "The DJ is live. Press listen when you’re ready." : "This page will update when the broadcast starts."}
        </p>
        {waitingForDj ? (
          <div className="listener-connection-status is-interrupted" role="status" aria-live="polite">
            <WifiSlash size={22} weight="bold" aria-hidden="true" />
            <div>
              <strong>Trying to reconnect</strong>
              <span>Session closes in <time dateTime={`PT${remainingSeconds}S`}>{formatCountdown(remainingSeconds)}</time> if the DJ does not return.</span>
            </div>
          </div>
        ) : connection === "connecting" ? (
          <div className="listener-connection-status" role="status">
            <span className="listener-status-dot" aria-hidden="true" />
            <div><strong>Connecting</strong><span>Opening the live audio stream…</span></div>
          </div>
        ) : connection === "idle" && live ? (
          <Button className="primary-button success-button" type="primary" onClick={() => void listen()}>Listen live</Button>
        ) : connection === "idle" ? (
          <Button className="primary-button muted-button" disabled>Waiting for broadcast</Button>
        ) : null}
        {connected && !waitingForDj && <Tag className="connection-state is-good" color="success">Connection stable</Tag>}
        {connection !== "idle" && connection !== "closed" && <audio ref={audioRef} className={`listener-player ${hasAudio ? "" : "is-pending"}`} controls aria-label="Discus live audio" />}
        {message && !waitingForDj && <InlineNotice tone={connection === "connected" ? "neutral" : "danger"}>{message}</InlineNotice>}
        <p className="listener-count compact"><span className="listener-icon" aria-hidden="true" />{data.session.listenerCount} listening</p>
        {shareUrl && (
          <section className="listener-share" aria-labelledby="listener-share-label">
            <div className="listener-share-copy">
              <strong id="listener-share-label">Listener invite</strong>
              <a href={shareUrl} target="_blank" rel="noreferrer">{shareUrl}</a>
              <span>Anyone with this link can listen.</span>
            </div>
            <Button className="copy-button listener-copy-button" onClick={() => void copyShareLink()}>
              <CopySimple size={18} weight="bold" aria-hidden="true" />
              {copied ? "Copied" : "Copy link"}
            </Button>
          </section>
        )}
        {shareError && <InlineNotice tone="danger">{shareError}</InlineNotice>}
      </div>
    </AppShell>
  );
}

function ListenerMessage({ title, message }: { title: string; message: string }) {
  return <AppShell footer=""><div className="message-view"><h1>{title}</h1><p className="intro-copy">{message}</p></div></AppShell>;
}
