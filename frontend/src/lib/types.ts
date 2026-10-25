export type Status = {
  source: "synthetic" | "live" | "replay";
  /** MIT-BIH replay: the clip currently playing */
  replay?: { record: string; kind: "normal" | "abnormal"; beats: number } | null;
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
  /** "snn": spiking network view; the trained SNN classifies when snn_trained is true */
  model_kind?: "rf" | "snn";
  model_label?: string;
  verdict_by?: string;
  snn_trained?: boolean;
  snn_error?: string | null;
  snn_meta?: {
    trained: string | null; hidden: number; steps: number; threshold: number;
    test_f1: number; test_auc: number; test_sensitivity: number;
  } | null;
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
  /** which classifier produced the verdict */
  via?: string;
  /** samples between the R peak and the latest sample when the verdict was published */
  lag?: number | null;
  /** MIT-BIH replay only: the cardiologist annotation of this beat */
  truth?: { sym: string; aami: string; abnormal: boolean; record: string } | null;
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
  trained?: boolean;
  label?: string;
  conf?: number;
  p_abnormal?: number;
  threshold?: number;
  /** P(abnormal) of the readout accumulated up to each time step */
  evidence?: number[];
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
