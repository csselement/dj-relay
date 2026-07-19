export type SessionState = "ready" | "live" | "interrupted" | "ended" | "expired";

export type RecordingStatus = "off" | "scheduled" | "recording" | "finalizing" | "ready" | "deleted" | "unavailable";

export type RecordingSummary = {
  requested: boolean;
  status: RecordingStatus;
  durationSeconds: number | null;
  partCount: number;
};

export type RelaySession = {
  id: string;
  name: string;
  mediaPath: string;
  state: SessionState;
  createdAt: string;
  expiresAt: string;
  startedAt: string | null;
  endedAt: string | null;
  endedReason: "dj" | "owner" | "timeout" | null;
  terminationCode: "recording_media_policy" | "recording_session_limit" | "recording_archive_limit" | null;
  disconnectDeadline: string | null;
  listenerCount: number;
  uniqueListenerCount: number;
  listenerHistoryAvailable: boolean;
  recording: RecordingSummary;
};

export type AdminStatus = {
  mediaMtx: boolean;
  recording: {
    state: "ok" | "warning" | "blocked" | "unavailable";
    usedBytes: number | null;
    maxBytes: number;
    freeBytes: number | null;
    sessionMaxBytes: number;
    lastSuccessfulScanAt: string | null;
  };
  transcode: { active: number; queued: number; maxActive: number; maxQueued: number };
};

export type SessionResponse = {
  role: "dj" | "listener";
  session: RelaySession;
};

export type RecordingResponse = {
  recording: RecordingSummary;
  parts: Array<{
    index: number;
    start: string;
    durationSeconds: number;
    filename?: string;
    url: string;
    downloadUrl: string;
  }>;
};
