export const isAbn = (s: string | null | undefined) => String(s ?? "").toUpperCase().startsWith("ABNORM");

export const signed = (v: number | null | undefined, d = 3) =>
  v == null || Number.isNaN(v) ? "--" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}`;

export const pct = (v: number | null | undefined) => (v == null ? "--" : `${Math.round(v * 100)}%`);

export const clockTime = (epochSeconds: number) =>
  new Date(epochSeconds * 1000).toLocaleTimeString([], { hour12: false });

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

// firmware constants (NeuroCardio_Review1.ino)
export const DEVICE_TH = { P: 0.28, Q: -0.33, R: 1.05 } as const;
export const BPM_BRADY = 50;
export const BPM_TACHY = 120;

export const FEATURE_COLOR: Record<string, string> = {
  P: "var(--violet)",
  Q: "var(--amber)",
  R: "var(--accent)",
  S: "var(--pink)",
};

export function hrZone(bpm: number | null | undefined): { label: string; tone: Tone } {
  if (!bpm) return { label: "No rate", tone: "neutral" };
  if (bpm < BPM_BRADY) return { label: "Bradycardia", tone: "warn" };
  if (bpm > BPM_TACHY) return { label: "Tachycardia", tone: "danger" };
  if (bpm > 100) return { label: "Elevated", tone: "warn" };
  return { label: "Normal range", tone: "ok" };
}

export type Tone = "neutral" | "ok" | "danger" | "warn" | "info";

export function prettySession(name: string) {
  const m = /session_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(name);
  if (!m) return name;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return d.toLocaleString([], {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

export function duration(a: string | null, b: string | null) {
  if (!a || !b) return "--";
  const s = Math.max(0, (new Date(b).getTime() - new Date(a).getTime()) / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`;
}
