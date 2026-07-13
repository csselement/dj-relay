import { describe, expect, it } from "vitest";
import { configureListenerBuffer, LISTENER_JITTER_BUFFER_MS } from "./media";

describe("listener jitter buffer", () => {
  it("sets a stable playback target when the browser supports it", () => {
    const receiver = { jitterBufferTarget: null } as RTCRtpReceiver;

    expect(configureListenerBuffer(receiver)).toBe(true);
    expect(receiver.jitterBufferTarget).toBe(LISTENER_JITTER_BUFFER_MS);
  });

  it("falls back cleanly when the browser does not expose the control", () => {
    expect(configureListenerBuffer({} as RTCRtpReceiver)).toBe(false);
  });

  it("falls back cleanly when the browser rejects the target", () => {
    const receiver = {} as RTCRtpReceiver;
    Object.defineProperty(receiver, "jitterBufferTarget", {
      get: () => null,
      set: () => { throw new RangeError("unsupported target"); },
    });

    expect(configureListenerBuffer(receiver)).toBe(false);
  });
});
