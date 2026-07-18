import { useCallback, useEffect, useState } from "react";
import { Button, Dropdown } from "antd";
import { DownloadSimple } from "@phosphor-icons/react";
import { sessionApi } from "../api";
import type { RecordingResponse } from "../types";
import { InlineNotice } from "./InlineNotice";
import { SessionShare } from "./SessionShare";

function formatDuration(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainder = rounded % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function RecordingDownloadAction({ parts }: { parts: RecordingResponse["parts"] }) {
  if (parts.length === 1) {
    return (
      <Button
        className="recording-icon-action"
        href={parts[0].downloadUrl}
        download
        aria-label="Download MP3"
        title="Download MP3"
      >
        <DownloadSimple size={19} weight="bold" aria-hidden="true" />
      </Button>
    );
  }

  return (
    <Dropdown
      placement="bottomRight"
      trigger={["click"]}
      menu={{
        items: parts.map((part) => ({
          key: part.index,
          label: <a href={part.downloadUrl} download>{`Download part ${part.index + 1} MP3`}</a>,
        })),
      }}
    >
      <Button className="recording-icon-action" aria-label="Download recording MP3 parts" title="Download recording MP3 parts">
        <DownloadSimple size={19} weight="bold" aria-hidden="true" />
      </Button>
    </Dropdown>
  );
}

export function RecordingPlayer({ sessionId, sessionName }: { sessionId: string; sessionName: string }) {
  const [data, setData] = useState<RecordingResponse | null>(null);
  const [error, setError] = useState("");
  const [partIndex, setPartIndex] = useState(0);

  const load = useCallback(async () => {
    try {
      const next = await sessionApi.recording();
      setData(next);
      setError("");
      setPartIndex((current) => Math.min(current, Math.max(0, next.parts.length - 1)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load this recording");
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [load]);

  const ready = data?.recording.status === "ready" && data.parts.length > 0;
  const part = ready ? data.parts[partIndex] : null;
  const hasNextPart = ready && partIndex < data.parts.length - 1;
  let content;

  if (error && !data) {
    content = <InlineNotice tone="danger">{error}</InlineNotice>;
  } else if (!data || data.recording.status === "finalizing") {
    content = <InlineNotice tone="neutral">Preparing the session replay… This page will update automatically.</InlineNotice>;
  } else if (data.recording.status === "deleted") {
    content = <InlineNotice tone="neutral">This recording was deleted by the producer.</InlineNotice>;
  } else if (!ready || !part) {
    content = <InlineNotice tone="danger">The replay is temporarily unavailable. Discus will keep checking for it.</InlineNotice>;
  } else {
    content = (
      <>
        <div className="recording-player-heading">
          <div>
            <p className="recording-ready-copy">This session has concluded. Recorded playback is ready.</p>
            <h2 id="recording-player-title">{sessionName}</h2>
          </div>
          <span>{data.recording.durationSeconds === null ? "" : formatDuration(data.recording.durationSeconds)}</span>
        </div>
        <audio
          key={part.url}
          className="archive-audio-player"
          controls
          controlsList="nodownload"
          autoPlay={partIndex > 0}
          src={part.url}
          aria-label={`${sessionName} recording${data.parts.length > 1 ? ` part ${partIndex + 1}` : ""}`}
          onEnded={() => {
            if (hasNextPart) setPartIndex((current) => current + 1);
          }}
        />
        {data.parts.length > 1 && (
          <p className="recording-part-label">Part {partIndex + 1} of {data.parts.length} · reconnects continue automatically</p>
        )}
        {error && <InlineNotice tone="danger">{error}</InlineNotice>}
      </>
    );
  }

  return (
    <section className="recording-player" aria-labelledby={ready ? "recording-player-title" : undefined}>
      <div className="recording-player-actions" aria-label="Session actions">
        {ready && <RecordingDownloadAction parts={data.parts} />}
        <SessionShare
          sessionId={sessionId}
          label="Share session"
          description="Anyone with this link can listen to the replay."
          errorMessage="Could not create the session link."
          className="recording-icon-action"
          variant="icon"
        />
      </div>
      {content}
    </section>
  );
}
