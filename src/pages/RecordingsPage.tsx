import { useCallback, useEffect, useState } from "react";
import { Button, Empty, Tag } from "antd";
import { api } from "../api";
import { AppShell } from "../components/AppShell";
import { InlineNotice } from "../components/InlineNotice";
import type { RelaySession, RecordingStatus } from "../types";

type ArchiveResponse = {
  recordings: RelaySession[];
  nextCursor: string | null;
};

const STATUS_LABELS: Record<RecordingStatus, string> = {
  off: "Not recorded",
  scheduled: "Scheduled",
  recording: "Recording",
  finalizing: "Finalizing",
  ready: "Ready",
  deleted: "Deleted",
  unavailable: "Unavailable",
};

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "Duration pending";
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainder = rounded % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function mergeRecordings(current: RelaySession[], incoming: RelaySession[]): RelaySession[] {
  const byId = new Map(current.map((session) => [session.id, session]));
  incoming.forEach((session) => byId.set(session.id, session));
  return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function RecordingsPage() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [recordings, setRecordings] = useState<RelaySession[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [deletingId, setDeletingId] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async (cursor?: string, refresh = false) => {
    setLoading(true);
    try {
      const identity = await api<{ authenticated: boolean }>("/api/admin/me");
      if (!identity.authenticated) {
        setAuthenticated(false);
        return;
      }
      const result = await api<ArchiveResponse>(`/api/admin/recordings?limit=12${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      setRecordings((current) => cursor && !refresh ? mergeRecordings(current, result.recordings) : result.recordings);
      setNextCursor(result.nextCursor);
      setAuthenticated(true);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load recordings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(undefined, true), 5000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function deleteRecording(session: RelaySession) {
    if (!window.confirm(`Delete the recording of “${session.name}”? This cannot be undone.`)) return;
    setDeletingId(session.id);
    try {
      await api(`/api/admin/recordings/${session.id}`, { method: "DELETE" });
      setRecordings((current) => current.filter((item) => item.id !== session.id));
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete recording");
    } finally {
      setDeletingId("");
    }
  }

  if (authenticated === null) {
    return <AppShell footer=""><div className="message-view"><h1>Recordings</h1><p className="intro-copy">Loading archive…</p></div></AppShell>;
  }
  if (!authenticated) {
    return <AppShell footer="Producer access only"><div className="message-view"><h1>Producer sign-in required</h1><p className="intro-copy">Sign in before opening the recording archive.</p><Button type="primary" href="/admin">Go to sign in</Button></div></AppShell>;
  }

  return (
    <AppShell footer="Private Discus recording archive">
      <div className="admin-view recordings-view">
        <div className="admin-heading">
          <div><h1>Recordings</h1><p className="intro-copy">Private session replays remain available until you delete them.</p></div>
          <Button href="/admin">Sessions</Button>
        </div>
        {error && <InlineNotice tone="danger">{error}</InlineNotice>}
        {recordings.length === 0 && !loading ? (
          <Empty className="empty-state" image={Empty.PRESENTED_IMAGE_SIMPLE} description={<span><strong>No recordings yet</strong>Enable recording when you create a session.</span>} />
        ) : (
          <div className="recording-archive-list">
            {recordings.map((session) => {
              const status = session.recording.status;
              const ready = status === "ready";
              const partCount = Math.max(1, session.recording.partCount);
              return (
                <article className="recording-archive-row" key={session.id}>
                  <div className="recording-archive-copy">
                    <div className="recording-archive-title">
                      <h2>{session.name}</h2>
                      <Tag color={ready ? "success" : status === "recording" ? "error" : "default"}>{STATUS_LABELS[status]}</Tag>
                    </div>
                    <p>{new Date(session.startedAt ?? session.createdAt).toLocaleString()} · {formatDuration(session.recording.durationSeconds)} · {partCount} {partCount === 1 ? "part" : "parts"} · {session.uniqueListenerCount} listened</p>
                  </div>
                  <div className="recording-archive-actions">
                    <Button href={ready ? `/api/admin/sessions/${session.id}/listen` : undefined} target={ready ? "_blank" : undefined} disabled={!ready}>Play</Button>
                    <Button danger disabled={status === "recording" || status === "scheduled" || status === "finalizing"} loading={deletingId === session.id} onClick={() => void deleteRecording(session)}>Delete</Button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
        {nextCursor && <Button className="archive-load-more" loading={loading} onClick={() => void load(nextCursor)}>Load older recordings</Button>}
      </div>
    </AppShell>
  );
}
