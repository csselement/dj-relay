import type { RecordingResponse, RelaySession, SessionResponse } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const payload = await response.json().catch(() => ({})) as { error?: string; code?: string };
  if (!response.ok) {
    const retryAfter = Number(response.headers.get("Retry-After"));
    throw new ApiError(
      payload.error ?? `Request failed (${response.status})`,
      response.status,
      typeof payload.code === "string" ? payload.code : null,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
    );
  }
  return payload as T;
}

function roleHeaders(role?: "dj" | "listener"): HeadersInit {
  if (!role) return {};
  return { "X-Discus-Role": role };
}

export const sessionApi = {
  get: (role: "dj" | "listener") => api<SessionResponse>("/api/session", { headers: roleHeaders(role) }),
  mediaToken: (role: "dj" | "listener") => api<{ token: string; path: string; endpoint: string }>("/api/session/media-token", { method: "POST", headers: roleHeaders(role) }),
  shareLink: (role: "dj" | "listener") => api<{ url: string }>("/api/session/share-link", { method: "POST", headers: roleHeaders(role) }),
  recording: () => api<RecordingResponse>("/api/session/recording"),
  setState: (state: "live" | "interrupted" | "ended") =>
    api<{ session: RelaySession }>("/api/session/state", { method: "POST", body: JSON.stringify({ state }), headers: roleHeaders("dj") }),
};
