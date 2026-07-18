import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Card, Checkbox, Empty, Input, Tag } from "antd";
import { api } from "../api";
import { AnimatedText } from "../components/AnimatedText";
import { AppShell } from "../components/AppShell";
import { InlineNotice } from "../components/InlineNotice";
import type { RelaySession } from "../types";

type CreatedLinks = { session: RelaySession; djUrl: string; listenerUrl: string };
type SessionListResponse = {
  sessions: RelaySession[];
  history: { loaded: number; total: number; hasMore: boolean };
};

const HISTORY_BATCH_SIZE = 6;
const SESSION_NAME_TIME_ZONE = "America/Los_Angeles";

export function defaultSessionName(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SESSION_NAME_TIME_ZONE,
    weekday: "long",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number(parts.find((part) => part.type === "hour")?.value);

  if (!weekday || !Number.isInteger(hour)) return "New Session";

  const timeOfDay = hour >= 5 && hour < 12
    ? "Morning"
    : hour >= 12 && hour < 17
      ? "Afternoon"
      : hour >= 17 && hour < 21
        ? "Evening"
        : "Night";

  return `${weekday} ${timeOfDay} Session`;
}

export function sessionAudienceLabel(session: RelaySession): string {
  if (session.state !== "ended" && session.state !== "expired") return `${session.listenerCount} listening`;
  if (!session.listenerHistoryAvailable) return "listener history unavailable";
  return session.uniqueListenerCount === 1 ? "1 person listened" : `${session.uniqueListenerCount} people listened`;
}

export function AdminPage() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [name, setName] = useState(defaultSessionName);
  const [recordingRequested, setRecordingRequested] = useState(false);
  const [sessions, setSessions] = useState<RelaySession[]>([]);
  const [created, setCreated] = useState<CreatedLinks | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"login" | "create" | null>(null);
  const [endingId, setEndingId] = useState("");
  const [deletingRecordingId, setDeletingRecordingId] = useState("");
  const [historyLimit, setHistoryLimit] = useState(HISTORY_BATCH_SIZE);
  const [historyLoaded, setHistoryLoaded] = useState(0);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const historyTriggerRef = useRef<HTMLDivElement>(null);

  const loadSessions = useCallback(async () => {
    try {
      const identity = await api<{ authenticated: boolean }>("/api/admin/me");
      if (!identity.authenticated) {
        setAuthenticated(false);
        return;
      }
      const result = await api<SessionListResponse>(`/api/admin/sessions?historyLimit=${historyLimit}`);
      setSessions(result.sessions);
      setHistoryLoaded(result.history.loaded);
      setHistoryHasMore(result.history.hasMore);
      setAuthenticated(true);
    } catch {
      setAuthenticated(false);
    }
  }, [historyLimit]);

  useEffect(() => {
    void loadSessions();
    const timer = window.setInterval(() => void loadSessions(), 3000);
    return () => window.clearInterval(timer);
  }, [loadSessions]);

  useEffect(() => {
    const trigger = historyTriggerRef.current;
    const requestPending = historyLoaded < historyLimit;
    if (!trigger || !historyHasMore || requestPending || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) setHistoryLimit((current) => current + HISTORY_BATCH_SIZE);
    }, { rootMargin: "240px 0px" });
    observer.observe(trigger);
    return () => observer.disconnect();
  }, [historyHasMore, historyLimit, historyLoaded]);

  async function login(event: React.FormEvent) {
    event.preventDefault();
    setBusy("login");
    try {
      await api("/api/admin/login", { method: "POST", body: JSON.stringify({ password }) });
      setPassword("");
      setError("");
      await loadSessions();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to sign in");
    } finally {
      setBusy(null);
    }
  }

  async function createSession(event: React.FormEvent) {
    event.preventDefault();
    setBusy("create");
    try {
      const result = await api<CreatedLinks>("/api/admin/sessions", {
        method: "POST",
        body: JSON.stringify({ name, recordingRequested }),
      });
      setCreated(result);
      setError("");
      await loadSessions();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to create session");
    } finally {
      setBusy(null);
    }
  }

  async function endSession(id: string) {
    setEndingId(id);
    try {
      await api(`/api/admin/sessions/${id}/end`, { method: "POST" });
      await loadSessions();
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to end session");
    } finally {
      setEndingId("");
    }
  }

  async function deleteRecording(session: RelaySession) {
    if (!window.confirm(`Delete the recording of “${session.name}”? This cannot be undone.`)) return;
    setDeletingRecordingId(session.id);
    try {
      await api(`/api/admin/recordings/${session.id}`, { method: "DELETE" });
      await loadSessions();
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to delete recording");
    } finally {
      setDeletingRecordingId("");
    }
  }

  if (authenticated === null) return <AppShell footer=""><div className="message-view"><h1>Producer console</h1><p className="intro-copy">Loading…</p></div></AppShell>;
  if (!authenticated) {
    return (
      <AppShell footer="Producer access only">
        <form className="admin-login" onSubmit={login}>
          <h1>Producer console</h1>
          <p className="intro-copy">Create private DJ and listener links.</p>
          <input type="text" name="username" value="producer" autoComplete="username" hidden readOnly />
          <label className="field-label" htmlFor="producer-password">Producer password</label>
          <Input.Password id="producer-password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          <Button className="primary-button success-button" type="primary" htmlType="submit" loading={busy === "login"}>{busy === "login" ? "Signing in…" : "Sign in"}</Button>
          {error && <InlineNotice tone="danger">{error}</InlineNotice>}
        </form>
      </AppShell>
    );
  }

  return (
    <AppShell footer="Discus producer console">
      <div className="admin-view">
        <div className="admin-heading">
          <div><h1>Sessions</h1><p className="intro-copy">Create one private relay at a time.</p></div>
          <Tag className="health-dot" color="success">System ready</Tag>
        </div>
        <Card className="create-session-card">
          <form className="create-session" onSubmit={createSession}>
            <div className="form-field session-name-field">
              <label className="field-label" htmlFor="session-name">Session name</label>
              <Input id="session-name" value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={80} required />
            </div>
            <Checkbox checked={recordingRequested} onChange={(event) => setRecordingRequested(event.target.checked)}>
              Record this session
            </Checkbox>
            <Button className="primary-button success-button" type="primary" htmlType="submit" loading={busy === "create"}>{busy === "create" ? "Creating…" : "Create session"}</Button>
          </form>
        </Card>
        {created && (
          <section aria-live="polite">
            <Card className="link-panel">
              <h2>{created.session.name}</h2>
              <CopyLink label="DJ invite" value={created.djUrl} />
              <CopyLink label="Listener invite" value={created.listenerUrl} />
              {created.session.recording.requested && <Tag className="recording-enabled-tag" color="error">Recording enabled</Tag>}
              <p>These private links are shown once. Copy them now.</p>
            </Card>
          </section>
        )}
        {error && <InlineNotice tone="danger">{error}</InlineNotice>}
        <div className="session-list">
          {sessions.length === 0 && (
            <Empty
              className="empty-state"
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={<span><strong>No sessions yet</strong>Create one above to generate private DJ and listener links.</span>}
            />
          )}
          {sessions.map((session) => {
            const active = session.state !== "ended" && session.state !== "expired";
            const recordingLabel = recordingArchiveLabel(session);
            const sessionDetails = <><h3>{session.name}</h3><p>{session.state} · {sessionAudienceLabel(session)}{recordingLabel} · expires {new Date(session.expiresAt).toLocaleString()}</p></>;
            const recordingReady = !active && session.recording.status === "ready";
            const recordingDeletable = !active && session.recording.requested &&
              session.recording.status !== "deleted" && session.recording.status !== "finalizing";
            return (
              <article className={`session-row ${active ? "is-active" : "is-history"}`} key={session.id}>
                {active ? (
                  <a
                    className="session-row-link"
                    href={`/api/admin/sessions/${session.id}/listen`}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Open ${session.name} listener page`}
                  >
                    {sessionDetails}
                  </a>
                ) : <div className="session-row-copy">{sessionDetails}</div>}
                <div className="session-row-actions">
                  {active && <Button className="small-danger-button" danger loading={endingId === session.id} onClick={() => void endSession(session.id)}>{endingId === session.id ? "Ending…" : "End"}</Button>}
                  {recordingReady && (
                    <Button href={`/api/admin/sessions/${session.id}/listen`} target="_blank">
                      Open session
                    </Button>
                  )}
                  {recordingDeletable && (
                    <Button danger loading={deletingRecordingId === session.id} onClick={() => void deleteRecording(session)}>
                      Delete recording
                    </Button>
                  )}
                </div>
              </article>
            );
          })}
          {historyHasMore && (
            <div className="history-lazy-loader" ref={historyTriggerRef}>
              <Button
                type="text"
                disabled={historyLoaded < historyLimit}
                onClick={() => setHistoryLimit((current) => current + HISTORY_BATCH_SIZE)}
              >
                {historyLoaded < historyLimit ? "Loading older sessions…" : "Load older sessions"}
              </Button>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}

function formatRecordingDuration(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainder = rounded % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

export function recordingArchiveLabel(session: RelaySession): string {
  if (!session.recording.requested) return "";
  if (session.recording.status !== "ready" || session.recording.durationSeconds === null) {
    return ` · recording ${session.recording.status}`;
  }
  const partLabel = session.recording.partCount === 1 ? "1 part" : `${session.recording.partCount} parts`;
  return ` · recording ready · ${formatRecordingDuration(session.recording.durationSeconds)} · ${partLabel}`;
}

function CopyLink({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div className="copy-row">
      <div><strong>{label}</strong><code>{value}</code></div>
      <Button className="copy-button" onClick={() => void copy()}><AnimatedText value={copied ? "Copied" : "Copy"} /></Button>
    </div>
  );
}
