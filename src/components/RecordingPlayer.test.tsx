import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionApi } from "../api";
import { RecordingPlayer } from "./RecordingPlayer";

afterEach(() => vi.restoreAllMocks());

describe("RecordingPlayer", () => {
  it("loads a replay and advances through reconnect parts", async () => {
    vi.spyOn(sessionApi, "recording").mockResolvedValue({
      recording: { requested: true, status: "ready", durationSeconds: 20, partCount: 2 },
      parts: [
        { index: 0, start: "2026-07-17T20:00:00Z", durationSeconds: 12, url: "/api/session/recording/parts/0" },
        { index: 1, start: "2026-07-17T20:01:00Z", durationSeconds: 8, url: "/api/session/recording/parts/1" },
      ],
    });

    render(<RecordingPlayer sessionName="Friday session" />);
    const first = await screen.findByLabelText("Friday session recording part 1");
    expect(first).toHaveAttribute("src", "/api/session/recording/parts/0");
    fireEvent.ended(first);
    await waitFor(() => expect(screen.getByLabelText("Friday session recording part 2")).toHaveAttribute("src", "/api/session/recording/parts/1"));
  });

  it("keeps polling copy visible while MediaMTX finalizes", async () => {
    vi.spyOn(sessionApi, "recording").mockResolvedValue({
      recording: { requested: true, status: "finalizing", durationSeconds: null, partCount: 0 },
      parts: [],
    });
    render(<RecordingPlayer sessionName="Friday session" />);
    expect(await screen.findByText(/Preparing the session replay/)).toBeVisible();
  });
});
