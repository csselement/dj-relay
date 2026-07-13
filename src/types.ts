export type SessionState = "ready" | "live" | "interrupted" | "ended" | "expired";

export type RelaySession = {
  id: string;
  name: string;
  mediaPath: string;
  state: SessionState;
  createdAt: string;
  expiresAt: string;
  startedAt: string | null;
  endedAt: string | null;
  listenerCount: number;
  uniqueListenerCount: number;
  listenerHistoryAvailable: boolean;
};

export type SessionResponse = {
  role: "dj" | "listener";
  session: RelaySession;
};
