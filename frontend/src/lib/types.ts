export type Status = {
  source: "synthetic" | "live";
  port: string | null;
  connected: boolean;
  error: string | null;
  dev_mode: string;
  calibrated: boolean;
  stream_on: boolean;
  auto: boolean;
  scenario: "NORMAL" | "ABNORMAL";
  recording: string | null;
  model_ready: boolean;
  model_error: string | null;
  /** "snn-preview": spike encoding + untrained LIF net shown, verdicts still from the RF */
  model_kind?: "rf" | "snn-preview";
  model_label?: string;
  verdict_by?: string;
  n_beats: number;
  n_abnormal: number;
  alarm: boolean;
  started: number;
  fs: number;
};

export type Beat = {
  n: number;
  t: number;
  ms: number;
  bpm: number;
  P: number;
  Q: number;
  R: number;
  S: number;
  device: string;
  model: string | null;
  conf: number | null;
  abnormal: boolean;
  uncal: boolean;
  scenario: string;
  source: string;
};

export type LogEntry = { t: number; text: string; level: "info" | "ok" | "warn" | "error" };

export type ModelInfo = {
  ready: boolean;
  error: string | null;
  features: string[];
  rows: [number, number, number, string][];
  ranges: Record<string, Record<"P" | "Q" | "R", [number, number]>>;
  counts: Record<string, number>;
  classes?: string[];
  n_estimators?: number;
  importances?: Record<string, number>;
};

export type SessionSummary = {
  name: string;
  beats: number;
  start: string | null;
  end: string | null;
  sources: string[];
  avg_bpm: number | null;
  abnormal: number;
  uncal: number;
  size: number;
  error?: string;
};

export type SessionRow = {
  timestamp: string;
  source: string;
  scenario: string;
  bpm: number | null;
  P: number | null;
  Q: number | null;
  R: number | null;
  S: number | null;
  device: string;
  model: string;
  conf: number | null;
  uncal: boolean;
};

export type SnnActivity = {
  n: number;
  window: number[];
  on: number[];
  off: number[];
  h1: [number, number][];
  h2: [number, number][];
  sizes: { steps: number; h1: number; h2: number };
  stats: {
    input_events: number; input_sparsity: number;
    h1_spikes: number; h2_spikes: number; h1_rate: number; h2_rate: number;
    synops: number; dense_macs: number;
  };
};

export type StreamEvent =
  | { type: "hello"; status: Status; beats: Beat[]; wave: number[]; logs: LogEntry[]; snn?: SnnActivity | null }
  | ({ type: "snn" } & SnnActivity)
  | { type: "wave"; v: number[] }
  | { type: "beat"; beat: Beat }
  | { type: "status"; status: Status }
  | ({ type: "log" } & LogEntry)
  | { type: "reset" };
