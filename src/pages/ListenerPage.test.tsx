import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ListenerPage } from "./ListenerPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ListenerPage accessibility", () => {
  it("announces connection state atomically without making counts live and hides the producer shortcut", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/session") return new Response(JSON.stringify({
        role: "listener",
        session: {
          id: "session-1",
          name: "Private mix",
          mediaPath: "session-path",
          state: "ready",
          createdAt: "2026-07-18T20:00:00.000Z",
          expiresAt: "2026-07-19T04:00:00.000Z",
          startedAt: null,
          endedAt: null,
          endedReason: null,
          terminationCode: null,
          disconnectDeadline: null,
          listenerCount: 3,
          uniqueListenerCount: 3,
          listenerHistoryAvailable: true,
          recording: { requested: false, status: "off", durationSeconds: null, partCount: 0 },
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url === "/api/session/share-link") return new Response(JSON.stringify({ url: "https://example.test/s/listen" }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<ListenerPage />);
    const status = (await screen.findByText("Waiting for DJ", { exact: true })).closest('[role="status"]');
    expect(status).not.toBeNull();
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAttribute("aria-atomic", "true");
    const count = screen.getByText("3 listening");
    expect(count).not.toHaveAttribute("aria-live");
    expect(screen.queryByRole("link", { name: "Producer console" })).not.toBeInTheDocument();
  });
});
