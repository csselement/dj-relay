import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Card, Empty, Input, Tag } from "antd";
import { Check, CopySimple, Trash } from "@phosphor-icons/react";
import { ApiError, api } from "../api";
import { copyText } from "../clipboard";
import { AnimatedText } from "../components/AnimatedText";
import { AppShell } from "../components/AppShell";
import { InlineNotice } from "../components/InlineNotice";
import type { AdminStatus, RelaySession } from "../types";

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
  const timeOfDay = hour >= 5 && hour < 12 ? "Morning" : hour >= 12 && hour < 17 ? "Afternoon" :
    hour >= 17 && hour < 21 ? "Evening" : "Night";
  return `${weekday} ${timeOfDay} Session`;
}

export function sessionAudienceLabel(session: RelaySession): string {
  if (session.state !== "ended" && session.state !== "expired") return `${session.listenerCount} listening`;
  if (!session.listenerHistoryAvailable) return "listener history unavailable";
  return session.uniqueListenerCount === 1 ? "1 person listened" : `${session.uniqueListenerCount} people listened`;
}

function clearProtectedState(
  setSessions: (sessions: RelaySession[]) => void,
  setCreated: (created: CreatedLinks | null) => void,
  setStatus: (status: AdminStatus | null) => void,
): void {
  setSessions([]);
  setCreated(null);
  setStatus(null);
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "Unavailable";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function runtimeStatusLabel(status: AdminStatus | null, unavailable: boolean): { label: string; color: string } {
  if (unavailable || !status || status.recording.state === "unavailable") return { label: "Unavailable", color: "default" };
  if (status.recording.state === "blocked") return { label: "Recording blocked", color: "error" };
  if (status.recording.state === "warning") return { label: "Recording-storage warning", color: "warning" };
  if (!status.mediaMtx) return { label: "Media-relay degraded", color: "warning" };
  return { label: "Ready", color: "success" };
}

export function terminationLabel(code: RelaySession["terminationCode"]): string {
  if (code === "recording_media_policy") return "ended by recording media policy";
  if (code === "recording_session_limit") return "ended at the 8 GiB session recording limit";
  if (code === "recording_archive_limit") return "ended because recording storage reached its limit";
  return "";
}

export function AdminPage() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [initialUnavailable, setInitialUnavailable] = useState(false);
  const [password, setPassword] = useState("");
  const [name, setName] = useState(defaultSessionName);
  const [recordingRequested, setRecordingRequested] = useState(true);
  const [recordingToggleInitialized, setRecordingToggleInitialized] = useState(false);
  const [sessions, setSessions] = useState<RelaySession[]>([]);
  const [created, setCreated] = useState<CreatedLinks | null>(null);
  const [loginError, setLoginError] = useState("");
  const [actionError, setActionError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [lastSuccessfulRefresh, setLastSuccessfulRefresh] = useState<Date | null>(null);
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [busy, setBusy] = useState<"login" | "create" | "logout" | null>(null);
  const [endingId, setEndingId] = useState("");
  const [deletingSessionId, setDeletingSessionId] = useState("");
  const [historyLimit, setHistoryLimit] = useState(HISTORY_BATCH_SIZE);
  const [historyLoaded, setHistoryLoaded] = useState(0);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const historyTriggerRef = useRef<HTMLDivElement>(null);

  const signOutLocally = useCallback(() => {
    setAuthenticated(false);
    setInitialUnavailable(false);
    setRefreshError("");
    setStatusError("");
    setLastSuccessfulRefresh(null);
    clearProtectedState(setSessions, setCreated, setStatus);
  }, []);

  const handleProtectedError = useCallback((caught: unknown, fallback: string): string => {
    if (caught instanceof ApiError && caught.status === 401) {
      signOutLocally();
      return "";
    }
    return caught instanceof Error ? caught.message : fallback;
  }, [signOutLocally]);

  const loadSessions = useCallback(async () => {
    try {
      const result = await api<SessionListResponse>(`/api/admin/sessions?historyLimit=${historyLimit}`);
      setSessions(result.sessions);
      setHistoryLoaded(result.history.loaded);
      setHistoryHasMore(result.history.hasMore);
      setLastSuccessfulRefresh(new Date());
      setRefreshError("");
    } catch (caught) {
      const message = handleProtectedError(caught, "Could not refresh sessions");
      if (message) setRefreshError(message);
    }
  }, [handleProtectedError, historyLimit]);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api<AdminStatus>("/api/admin/status"));
      setStatusError("");
    } catch (caught) {
      const message = handleProtectedError(caught, "Runtime status is unavailable");
      if (message) setStatusError(message);
    }
  }, [handleProtectedError]);

  const checkIdentity = useCallback(async () => {
    setInitialUnavailable(false);
    try {
      const identity = await api<{ authenticated: boolean }>("/api/admin/me");
      if (!identity.authenticated) {
        signOutLocally();
        return;
      }
      setAuthenticated(true);
      await Promise.all([loadSessions(), loadStatus()]);
    } catch {
      setAuthenticated(null);
      setInitialUnavailable(true);
    }
  }, [loadSessions, loadStatus, signOutLocally]);

  useEffect(() => { void checkIdentity(); }, [checkIdentity]);

  useEffect(() => {
    if (!status || (status.recording.state !== "blocked" && status.recording.state !== "unavailable")) return;
    setRecordingRequested(false);
  }, [status]);

  useEffect(() => {
    if (!authenticated) return;
    const sessionTimer = window.setInterval(() => void loadSessions(), 3000);
    const statusTimer = window.setInterval(() => void loadStatus(), 15_000);
    return () => {
      window.clearInterval(sessionTimer);
      window.clearInterval(statusTimer);
    };
  }, [authenticated, loadSessions, loadStatus]);

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
      setLoginError("");
      setAuthenticated(true);
      await Promise.all([loadSessions(), loadStatus()]);
    } catch (caught) {
      const retry = caught instanceof ApiError && caught.retryAfterSeconds ? ` Try again in ${caught.retryAfterSeconds} seconds.` : "";
      setLoginError(`${caught instanceof Error ? caught.message : "Unable to sign in"}${retry}`);
    } finally {
      setBusy(null);
    }
  }

  async function logout() {
    setBusy("logout");
    setActionError("");
    try {
      await api("/api/admin/logout", { method: "POST" });
      signOutLocally();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Unable to sign out");
    } finally {
      setBusy(null);
    }
  }

  async function createSession(event: React.FormEvent) {
    event.preventDefault();
    setBusy("create");
    setActionError("");
    try {
      const result = await api<CreatedLinks>("/api/admin/sessions", {
        method: "POST",
        body: JSON.stringify({ name, recordingRequested }),
      });
      setCreated(result);
      await loadSessions();
    } catch (caught) {
      setActionError(handleProtectedError(caught, "Unable to create session"));
    } finally {
      setBusy(null);
    }
  }

  async function endSession(id: string) {
    setEndingId(id);
    setActionError("");
    try {
      await api(`/api/admin/sessions/${id}/end`, { method: "POST" });
      await loadSessions();
    } catch (caught) {
      setActionError(handleProtectedError(caught, "Unable to end session"));
    } finally {
      setEndingId("");
    }
  }

  async function deleteSession(session: RelaySession) {
    const recordingCopy = session.recording.requested ? " and its recording" : "";
    if (!window.confirm(`Delete “${session.name}”${recordingCopy}? This cannot be undone.`)) return;
    setDeletingSessionId(session.id);
    setActionError("");
    try {
      await api(`/api/admin/sessions/${session.id}`, { method: "DELETE" });
      await Promise.all([loadSessions(), loadStatus()]);
    } catch (caught) {
      setActionError(handleProtectedError(caught, "Unable to delete session"));
    } finally {
      setDeletingSessionId("");
    }
  }

  if (authenticated === null && !initialUnavailable) {
    return <AppShell footer="" showProducerLink={false}><div className="message-view"><h1>Producer console</h1><p className="intro-copy">Loading…</p></div></AppShell>;
  }
  if (initialUnavailable) {
    return (
      <AppShell footer="Producer access only" showProducerLink={false}>
        <div className="message-view unavailable-view">
          <h1>Producer console unavailable</h1>
          <p className="intro-copy">Discus could not reach the server. Your sign-in state has not been changed.</p>
          <Button className="primary-button" onClick={() => void checkIdentity()}>Retry</Button>
        </div>
      </AppShell>
    );
  }
  if (!authenticated) {
    return (
      <AppShell footer="Producer access only" showProducerLink={false}>
        <form className="admin-login" onSubmit={login}>
          <h1>Producer console</h1>
          <p className="intro-copy">Create private DJ and listener links.</p>
          <input type="text" name="username" value="producer" autoComplete="username" hidden readOnly />
          <label className="field-label" htmlFor="producer-password">Producer password</label>
          <Input.Password id="producer-password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          <Button className="primary-button success-button" type="primary" htmlType="submit" loading={busy === "login"}>{busy === "login" ? "Signing in…" : "Sign in"}</Button>
          {loginError && <InlineNotice tone="danger">{loginError}</InlineNotice>}
        </form>
      </AppShell>
    );
  }

  const runtime = runtimeStatusLabel(status, Boolean(statusError));
  const recordingAvailable = Boolean(status && !statusError && (status.recording.state === "ok" || status.recording.state === "warning"));
  return (
    <AppShell
      footer="Discus producer console"
      showProducerLink={false}
      headerAction={<Button className="header-console-link header-signout-button" type="text" loading={busy === "logout"} onClick={() => void logout()}>Sign out</Button>}
    >
      <div className="admin-view">
        <div className="admin-heading">
          <div><h1>Sessions</h1><p className="intro-copy">Create one private relay at a time.</p></div>
          <div className="runtime-status">
            <Tag className="health-dot" color={runtime.color}>{runtime.label}</Tag>
            {status && <span>{formatBytes(status.recording.usedBytes)} of {formatBytes(status.recording.maxBytes)} archived</span>}
          </div>
        </div>
        {statusError && <InlineNotice tone="danger">Runtime status is unavailable. <button className="inline-retry" type="button" onClick={() => void loadStatus()}>Retry</button></InlineNotice>}
        <Card className="create-session-card">
          <form className="create-session" onSubmit={createSession}>
            <div className="form-field session-name-field">
              <label className="field-label" htmlFor="session-name">Session name</label>
              <Input id="session-name" value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={80} required />
            </div>
            <div className="recording-toggle-field">
              <button
                className={`t-toggle recording-toggle${recordingToggleInitialized ? " is-init" : ""}`}
                type="button"
                role="switch"
                aria-checked={recordingRequested}
                aria-labelledby="record-session-label"
                aria-describedby={!recordingAvailable ? "recording-unavailable-help" : undefined}
                data-on={recordingRequested ? "true" : "false"}
                disabled={busy === "create" || !recordingAvailable}
                onClick={() => {
                  setRecordingToggleInitialized(true);
                  setRecordingRequested((current) => !current);
                }}
              ><span className="t-toggle-thumb" aria-hidden="true" /></button>
              <span id="record-session-label">Record</span>
            </div>
            <Button className="primary-button success-button" type="primary" htmlType="submit" loading={busy === "create"}>{busy === "create" ? "Creating…" : "Create session"}</Button>
          </form>
          {!recordingAvailable && (
            <p className="recording-unavailable-help" id="recording-unavailable-help">
              Recording is unavailable. Delete archived sessions to restore capacity; unrecorded sessions can still be created.
            </p>
          )}
        </Card>
        {created && (
          <section>
            <Card className="link-panel">
              <h2>{created.session.name}</h2>
              <CopyLink label="DJ invite" copyName="DJ link" value={created.djUrl} />
              <CopyLink label="Listener invite" copyName="listener link" value={created.listenerUrl} />
              {created.session.recording.requested && <Tag className="recording-enabled-tag" color="error">Recording enabled</Tag>}
              <p>These private links are shown once. Copy them now.</p>
            </Card>
          </section>
        )}
        {actionError && <InlineNotice tone="danger">{actionError}</InlineNotice>}
        {refreshError && (
          <InlineNotice tone="neutral">
            Session list is stale{lastSuccessfulRefresh ? ` · last updated ${lastSuccessfulRefresh.toLocaleTimeString()}` : ""}.{" "}
            <button className="inline-retry" type="button" onClick={() => void loadSessions()}>Retry</button>
          </InlineNotice>
        )}
        <div className="session-list">
          {sessions.length === 0 && !refreshError && (
            <Empty className="empty-state" image={Empty.PRESENTED_IMAGE_SIMPLE} description={<span><strong>No sessions yet</strong>Create one above to generate private DJ and listener links.</span>} />
          )}
          {sessions.map((session) => {
            const active = session.state !== "ended" && session.state !== "expired";
            const recordingLabel = recordingArchiveLabel(session);
            const stateLabel = active ? session.state : "concluded";
            const timingLabel = active ? `expires ${new Date(session.expiresAt).toLocaleString()}` : `ended ${new Date(session.endedAt ?? session.expiresAt).toLocaleString()}`;
            const enforcement = terminationLabel(session.terminationCode);
            const sessionDeletable = !active && session.recording.status !== "finalizing";
            return (
              <article className={`session-row ${active ? "is-active" : "is-history"}`} key={session.id}>
                <div className="session-row-copy">
                  <h3 className="session-row-title">
                    <a className="session-title-link" href={`/api/admin/sessions/${session.id}/listen`} target="_blank" rel="noreferrer" aria-label={`Open ${session.name} listener page`}>{session.name}</a>
                    {sessionCarriesRecording(session) && <span className="session-recording-badge" aria-label="Recording attached" title="Recording attached"><span className="session-recording-badge-dot" aria-hidden="true" /><span aria-hidden="true">REC</span></span>}
                  </h3>
                  <p>{stateLabel} · {sessionAudienceLabel(session)}{recordingLabel} · {timingLabel}{enforcement ? ` · ${enforcement}` : ""}</p>
                </div>
                <div className="session-row-actions">
                  {active && <Button className="small-danger-button" danger loading={endingId === session.id} onClick={() => void endSession(session.id)}>{endingId === session.id ? "Ending…" : "End"}</Button>}
                  {!active && <Button className="session-delete-button" danger disabled={!sessionDeletable} loading={deletingSessionId === session.id} aria-label={`Delete session ${session.name}`} title={sessionDeletable ? "Delete session" : "Recording is still finalizing"} onClick={() => void deleteSession(session)}><Trash aria-hidden="true" size={19} weight="bold" /></Button>}
                </div>
              </article>
            );
          })}
          {historyHasMore && (
            <div className="history-lazy-loader" ref={historyTriggerRef}>
              <Button type="text" disabled={historyLoaded < historyLimit} onClick={() => setHistoryLimit((current) => current + HISTORY_BATCH_SIZE)}>{historyLoaded < historyLimit ? "Loading older sessions…" : "Load older sessions"}</Button>
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
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}` : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

export function recordingArchiveLabel(session: RelaySession): string {
  if (!session.recording.requested) return "";
  if (session.recording.status !== "ready" || session.recording.durationSeconds === null) return ` · recording ${session.recording.status}`;
  const partLabel = session.recording.partCount === 1 ? "1 part" : `${session.recording.partCount} parts`;
  return ` · recording ready · ${formatRecordingDuration(session.recording.durationSeconds)} · ${partLabel}`;
}

export function sessionCarriesRecording(session: RelaySession): boolean {
  return session.recording.requested && ["scheduled", "recording", "finalizing", "ready"].includes(session.recording.status);
}

export function CopyLink({ label, copyName, value }: { label: string; copyName: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const copiedTimerRef = useRef<number>(undefined);
  const copyLabel = `Copy ${copyName}`;
  const copiedLabel = `${copyName.charAt(0).toUpperCase()}${copyName.slice(1)} copied`;
  useEffect(() => () => window.clearTimeout(copiedTimerRef.current), []);
  async function copy() {
    try {
      await copyText(value);
      setCopied(true);
      setCopyError("");
      window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopyError(`Could not copy the ${copyName}. Select it and copy it manually.`);
    }
  }
  return (
    <div className="copy-row-wrap">
      <div className="copy-row">
        <div><strong>{label}</strong><code>{value}</code></div>
        <Button className="copy-button" aria-label={copied ? copiedLabel : copyLabel} onClick={() => void copy()}>
          <span className="t-icon-swap" data-state={copied ? "b" : "a"} aria-hidden="true"><CopySimple className="t-icon" data-icon="a" size={17} weight="bold" /><Check className="t-icon" data-icon="b" size={17} weight="bold" /></span>
          <AnimatedText value={copied ? copiedLabel : copyLabel} />
        </Button>
      </div>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{copied ? copiedLabel : ""}</span>
      {copyError && <InlineNotice tone="danger">{copyError}</InlineNotice>}
    </div>
  );
}
