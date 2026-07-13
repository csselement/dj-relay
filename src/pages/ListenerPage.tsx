import { useEffect, useRef, useState } from "react";
import { Button, Tag } from "antd";
import { sessionApi } from "../api";
import { AppShell } from "../components/AppShell";
import { InlineNotice } from "../components/InlineNotice";
import { useSession } from "../hooks/useSession";
import { WhepReader, type MediaConnectionState } from "../media";

export function ListenerPage() {
  const { data, error } = useSession("listener");
  const [connection, setConnection] = useState<MediaConnectionState | "idle">("idle");
  const [message, setMessage] = useState("");
  const readerRef = useRef<WhepReader | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => () => readerRef.current?.close(), []);
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
          setMessage(detail ?? "");
        },
        onTrack: (stream) => {
          if (!audioRef.current) return;
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

  if (error) return <ListenerMessage title="Invite link required" message={error} />;
  if (!data) return <ListenerMessage title="Loading session" message="Checking your private listener invite…" />;
  if (data.session.state === "ended") return <ListenerMessage title="Broadcast ended" message="Thanks for listening." />;

  const live = data.session.state === "live" || data.session.state === "interrupted";
  const connected = connection === "connected";
  return (
    <AppShell footer="Private session · Share this page only with invited listeners.">
      <div className="listener-view">
        <Tag className={`listener-live-label ${live ? "is-live" : ""}`} color={live ? "error" : "default"}>{live ? "Live now" : "Waiting for DJ"}</Tag>
        <h1>{data.session.name}</h1>
        <p className="intro-copy">
          {connected ? "You’re listening live." : live ? "The DJ is live. Press listen when you’re ready." : "This page will update when the broadcast starts."}
        </p>
        {connection === "idle" && live && <Button className="primary-button success-button" type="primary" onClick={() => void listen()}>Listen live</Button>}
        {connection === "idle" && !live && <Button className="primary-button muted-button" disabled>Waiting for broadcast</Button>}
        {(connection === "connecting" || connection === "reconnecting") && <Button className="primary-button muted-button" loading disabled>{connection === "connecting" ? "Connecting…" : "Reconnecting…"}</Button>}
        {connected && <Tag className="connection-state is-good" color="success">Connection stable</Tag>}
        {connection !== "idle" && connection !== "closed" && <audio ref={audioRef} className="listener-player" controls aria-label="DJ Relay live audio" />}
        {message && <InlineNotice tone={connection === "connected" ? "neutral" : "danger"}>{message}</InlineNotice>}
        <p className="listener-count compact"><span className="listener-icon" aria-hidden="true" />{data.session.listenerCount} listening</p>
      </div>
    </AppShell>
  );
}

function ListenerMessage({ title, message }: { title: string; message: string }) {
  return <AppShell footer=""><div className="message-view"><h1>{title}</h1><p className="intro-copy">{message}</p></div></AppShell>;
}
