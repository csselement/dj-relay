import { useCallback, useEffect, useRef, useState } from "react";

const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: { ideal: 2 },
  sampleRate: { ideal: 48_000 },
  sampleSize: { ideal: 24 },
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

export type AudioInputState = {
  permission: "prompt" | "requesting" | "granted" | "denied";
  devices: MediaDeviceInfo[];
  selectedId: string;
  stream: MediaStream | null;
  channels: number | null;
  sampleRate: number | null;
  error: string;
};

export function useAudioInput() {
  const [state, setState] = useState<AudioInputState>({
    permission: "prompt",
    devices: [],
    selectedId: "",
    stream: null,
    channels: null,
    sampleRate: null,
    error: "",
  });
  const streamRef = useRef<MediaStream | null>(null);

  const enumerate = useCallback(async () => {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "audioinput");
    setState((current) => ({ ...current, devices }));
    return devices;
  }, []);

  const select = useCallback(async (deviceId?: string) => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setState((current) => ({ ...current, permission: "denied", error: "Audio capture requires Chrome or Edge over HTTPS." }));
      return null;
    }
    setState((current) => ({ ...current, permission: "requesting", error: "" }));
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...AUDIO_CONSTRAINTS,
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        },
        video: false,
      });
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = stream;
      const track = stream.getAudioTracks()[0];
      const settings = track.getSettings();
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((device) => device.kind === "audioinput");
      const selectedId = settings.deviceId ?? deviceId ?? inputs[0]?.deviceId ?? "";
      setState({
        permission: "granted",
        devices: inputs,
        selectedId,
        stream,
        channels: settings.channelCount ?? null,
        sampleRate: settings.sampleRate ?? null,
        error: "",
      });
      track.addEventListener("ended", () => {
        setState((current) => ({ ...current, stream: null, error: "Audio input disconnected. Reconnect it, then choose the device again." }));
      }, { once: true });
      return stream;
    } catch (caught) {
      const denied = caught instanceof DOMException && caught.name === "NotAllowedError";
      setState((current) => ({
        ...current,
        permission: denied ? "denied" : "prompt",
        error: denied ? "Audio access was blocked. Allow microphone access in your browser, then try again." :
          (caught instanceof Error ? caught.message : "Unable to open that audio input."),
      }));
      return null;
    }
  }, []);

  useEffect(() => {
    if (!navigator.mediaDevices) return;
    const onChange = () => void enumerate();
    navigator.mediaDevices.addEventListener("devicechange", onChange);
    return () => navigator.mediaDevices.removeEventListener("devicechange", onChange);
  }, [enumerate]);

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  return { ...state, request: () => select(), select };
}
