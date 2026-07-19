import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionApi } from "../api";
import { RecordingPlayer } from "./RecordingPlayer";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.spyOn(sessionApi, "shareLink").mockResolvedValue({ url: "https://discus.test/s/shared-replay" });
});

describe("RecordingPlayer", () => {
  it("loads a replay and advances through reconnect parts", async () => {
    vi.spyOn(sessionApi, "recording").mockResolvedValue({
      recording: { requested: true, status: "ready", durationSeconds: 20, partCount: 2 },
      parts: [
        { index: 0, start: "2026-07-17T20:00:00Z", durationSeconds: 12, url: "/api/session/recording/parts/0", downloadUrl: "/api/session/recording/parts/0?download=mp3" },
        { index: 1, start: "2026-07-17T20:01:00Z", durationSeconds: 8, url: "/api/session/recording/parts/1", downloadUrl: "/api/session/recording/parts/1?download=mp3" },
      ],
    });

    render(<RecordingPlayer sessionId="session-1" sessionName="Friday session" />);
    const first = await screen.findByLabelText("Friday session recording part 1");
    expect(first).toHaveAttribute("src", "/api/session/recording/parts/0");
    expect(first).toHaveAttribute("controlslist", "nodownload");
    expect(screen.getByText("This session has concluded. Recorded playback is ready.")).toBeVisible();
    const downloadButton = screen.getByRole("button", { name: "Download recording MP3 parts" });
    expect(downloadButton.querySelector("svg")).not.toBeNull();
    expect((await screen.findByRole("button", { name: "Copy session link" })).querySelector("svg")).not.toBeNull();
    fireEvent.click(downloadButton);
    expect(await screen.findByRole("link", { name: "Download part 1 MP3" })).toHaveAttribute("href", "/api/session/recording/parts/0?download=mp3");
    expect(screen.getByRole("link", { name: "Download part 2 MP3" })).toHaveAttribute("href", "/api/session/recording/parts/1?download=mp3");
    fireEvent.ended(first);
    await waitFor(() => expect(screen.getByLabelText("Friday session recording part 2")).toHaveAttribute("src", "/api/session/recording/parts/1"));
  });

  it("clearly explains that a concluded recording is being transcoded", async () => {
    vi.spyOn(sessionApi, "recording").mockResolvedValue({
      recording: { requested: true, status: "finalizing", durationSeconds: null, partCount: 0 },
      parts: [],
    });
    render(<RecordingPlayer sessionId="session-1" sessionName="Friday session" />);
    expect(await screen.findByText("Transcoding recording, please wait… This page will update automatically.")).toBeVisible();
    expect(await screen.findByRole("button", { name: "Copy session link" })).toBeVisible();
  });

  it("offers a single concluded recording as an MP3", async () => {
    vi.spyOn(sessionApi, "recording").mockResolvedValue({
      recording: { requested: true, status: "ready", durationSeconds: 43, partCount: 1 },
      parts: [{
        index: 0,
        start: "2026-07-17T20:00:00Z",
        durationSeconds: 43,
        url: "/api/session/recording/parts/0",
        downloadUrl: "/api/session/recording/parts/0?download=mp3",
      }],
    });

    render(<RecordingPlayer sessionId="session-1" sessionName="Friday session" />);
    expect(await screen.findByText("This session has concluded. Recorded playback is ready.")).toBeVisible();
    expect(screen.getByRole("link", { name: "Download MP3" })).toHaveAttribute(
      "href",
      "/api/session/recording/parts/0?download=mp3",
    );
  });
});
