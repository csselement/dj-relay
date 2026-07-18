import { useCallback, useEffect, useState } from "react";
import { Tag } from "antd";
import { sessionApi } from "../api";
import type { RecordingResponse } from "../types";
import { InlineNotice } from "./InlineNotice";

function formatDuration(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainder = rounded % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

export function RecordingPlayer({ sessionName }: { sessionName: string }) {
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

  if (error && !data) return <InlineNotice tone="danger">{error}</InlineNotice>;
  if (!data || data.recording.status === "finalizing") {
    return <InlineNotice tone="neutral">Preparing the session replay… This page will update automatically.</InlineNotice>;
  }
  if (data.recording.status === "deleted") {
    return <InlineNotice tone="neutral">This recording was deleted by the producer.</InlineNotice>;
  }
  if (data.recording.status !== "ready" || data.parts.length === 0) {
    return <InlineNotice tone="danger">The replay is temporarily unavailable. Discus will keep checking for it.</InlineNotice>;
  }

  const part = data.parts[partIndex];
  const hasNextPart = partIndex < data.parts.length - 1;
  return (
    <section className="recording-player" aria-labelledby="recording-player-title">
      <div className="recording-player-heading">
        <div>
          <Tag className="recording-ready-tag" color="success">Replay ready</Tag>
          <h2 id="recording-player-title">{sessionName}</h2>
        </div>
        <span>{data.recording.durationSeconds === null ? "" : formatDuration(data.recording.durationSeconds)}</span>
      </div>
      <audio
        key={part.url}
        className="archive-audio-player"
        controls
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
      <div className="recording-downloads" aria-label="Recording downloads">
        <strong>{data.parts.length > 1 ? "Download recording parts" : "Download recording"}</strong>
        <div>
          {data.parts.map((recordingPart) => (
            <a className="recording-download-link" href={recordingPart.downloadUrl} download key={recordingPart.index}>
              {data.parts.length > 1 ? `Download part ${recordingPart.index + 1}` : "Download MP4"}
            </a>
          ))}
        </div>
      </div>
      {error && <InlineNotice tone="danger">{error}</InlineNotice>}
    </section>
  );
}
