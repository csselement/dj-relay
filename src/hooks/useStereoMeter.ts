import { useEffect, useState } from "react";

function rms(data: Float32Array<ArrayBuffer>): number {
  let total = 0;
  for (const value of data) total += value * value;
  const value = Math.sqrt(total / data.length);
  const db = 20 * Math.log10(Math.max(value, 0.0001));
  return Math.max(0, Math.min(1, (db + 54) / 54));
}

export function useStereoMeter(stream: MediaStream | null): [number, number] {
  const [levels, setLevels] = useState<[number, number]>([0, 0]);

  useEffect(() => {
    if (!stream) {
      setLevels([0, 0]);
      return;
    }
    const context = new AudioContext({ sampleRate: 48_000 });
    const source = context.createMediaStreamSource(stream);
    const splitter = context.createChannelSplitter(2);
    const left = context.createAnalyser();
    const right = context.createAnalyser();
    left.fftSize = right.fftSize = 1024;
    left.smoothingTimeConstant = right.smoothingTimeConstant = 0.72;
    source.connect(splitter);
    splitter.connect(left, 0);
    splitter.connect(right, 1);
    const leftData = new Float32Array(left.fftSize);
    const rightData = new Float32Array(right.fftSize);
    let frame = 0;
    let lastUpdate = 0;
    const read = (timestamp: number) => {
      frame = requestAnimationFrame(read);
      if (timestamp - lastUpdate < 50) return;
      lastUpdate = timestamp;
      left.getFloatTimeDomainData(leftData);
      right.getFloatTimeDomainData(rightData);
      setLevels([rms(leftData), rms(rightData)]);
    };
    frame = requestAnimationFrame(read);
    return () => {
      cancelAnimationFrame(frame);
      source.disconnect();
      splitter.disconnect();
      void context.close();
    };
  }, [stream]);

  return levels;
}
