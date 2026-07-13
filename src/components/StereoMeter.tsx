const MARKS = ["-24", "-12", "-6", "-3", "0"];

function MeterRow({ label, level }: { label: string; level: number }) {
  const active = Math.round(level * 32);
  return (
    <div className="meter-row">
      <span className="channel-label">{label}</span>
      <div className="meter-segments" aria-label={`${label} level ${Math.round(level * 100)} percent`}>
        {Array.from({ length: 32 }, (_, index) => (
          <span key={index} className={`meter-segment meter-segment-${index} ${index < active ? "active" : ""}`} />
        ))}
      </div>
    </div>
  );
}

export function StereoMeter({ levels, showScale = true }: { levels: [number, number]; showScale?: boolean }) {
  return (
    <div className="stereo-meter">
      <MeterRow label="L" level={levels[0]} />
      <MeterRow label="R" level={levels[1]} />
      {showScale && <div className="meter-scale" aria-hidden="true">{MARKS.map((mark) => <span key={mark}>{mark}</span>)}</div>}
    </div>
  );
}
