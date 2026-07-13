import type { RelaySession, SessionResponse } from "./types";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
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
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new ApiError(payload.error ?? `Request failed (${response.status})`, response.status);
  return payload as T;
}

export const sessionApi = {
  get: () => api<SessionResponse>("/api/session"),
  mediaToken: () => api<{ token: string; path: string; endpoint: string }>("/api/session/media-token", { method: "POST" }),
  shareLink: () => api<{ url: string }>("/api/session/share-link", { method: "POST" }),
  setState: (state: "live" | "interrupted" | "ended") =>
    api<{ session: RelaySession }>("/api/session/state", { method: "POST", body: JSON.stringify({ state }) }),
};
