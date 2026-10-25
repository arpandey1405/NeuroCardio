"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { API_URL, apiGet, apiPost } from "@/lib/api";
import type { Beat, LogEntry, ModelInfo, SnnActivity, Status, StreamEvent } from "@/lib/types";
import { wave } from "@/lib/wave-store";

type Live = {
  /** null until the first connection attempt resolves */
  online: boolean | null;
  status: Status | null;
  beats: Beat[];
  logs: LogEntry[];
  counts: { n: number; abn: number };
  model: ModelInfo | null;
  /** latest spiking-network activity (null unless the SNN model is selected) */
  snn: SnnActivity | null;
  sound: boolean;
  setSound: (on: boolean) => void;
  send: (cmd: string) => Promise<void>;
  setSource: (mode: "live" | "synthetic" | "replay", port?: string | null) => Promise<void>;
  setRecording: (on: boolean) => Promise<void>;
  /** resolves to an error message, or null when the backend switched */
  setModelKind: (kind: "rf" | "snn") => Promise<string | null>;
};

const LiveContext = createContext<Live | null>(null);

export function useLive() {
  const ctx = useContext(LiveContext);
  if (!ctx) throw new Error("useLive must be used inside <LiveProvider>");
  return ctx;
}

const MAX_BEATS = 600;

export function LiveProvider({ children }: { children: React.ReactNode }) {
  const [online, setOnline] = useState<boolean | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [beats, setBeats] = useState<Beat[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [counts, setCounts] = useState({ n: 0, abn: 0 });
  const [model, setModel] = useState<ModelInfo | null>(null);
  const [snnAct, setSnnAct] = useState<SnnActivity | null>(null);
  const [sound, setSoundState] = useState(false);
  const audio = useRef<AudioContext | null>(null);
  const alarmWas = useRef(false);

  const beep = useCallback((freq: number, dur: number, when = 0) => {
    const ac = audio.current;
    if (!ac) return;
    const t = ac.currentTime + when;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = "square";
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.08, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(ac.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  }, []);

  const setSound = useCallback((on: boolean) => {
    if (on && !audio.current) {
      try { audio.current = new AudioContext(); } catch { audio.current = null; }
    }
    if (!on) audio.current = null;
    setSoundState(on);
  }, []);

  const applyStatus = useCallback((st: Status) => {
    setStatus(st);
    setCounts({ n: st.n_beats, abn: st.n_abnormal });
    if (st.alarm && !alarmWas.current) {
      beep(1400, 0.12); beep(1400, 0.12, 0.2); beep(1400, 0.12, 0.4);
    }
    alarmWas.current = st.alarm;
  }, [beep]);

  useEffect(() => {
    const es = new EventSource(`${API_URL}/api/stream`);
    es.onmessage = (m) => {
      const ev = JSON.parse(m.data) as StreamEvent;
      switch (ev.type) {
        case "hello":
          setOnline(true);
          wave.reset();
          wave.prefill(ev.wave);
          setBeats(ev.beats.slice(-MAX_BEATS));
          setLogs(ev.logs);
          setSnnAct(ev.snn ?? null);
          applyStatus(ev.status);
          break;
        case "wave":
          wave.receive(ev.v);
          break;
        case "beat":
          wave.markBeat(ev.beat.abnormal, ev.beat.bpm, ev.beat.lag);
          setBeats((b) => (b.length >= MAX_BEATS ? [...b.slice(1), ev.beat] : [...b, ev.beat]));
          setCounts((c) => ({ n: ev.beat.n, abn: c.abn + (ev.beat.abnormal ? 1 : 0) }));
          break;
        case "status":
          applyStatus(ev.status);
          break;
        case "snn": {
          const { type: _t, ...act } = ev;
          setSnnAct(act);
          break;
        }
        case "log": {
          const { type: _t, ...entry } = ev;
          setLogs((l) => [...l.slice(-199), entry]);
          break;
        }
        case "reset":
          wave.reset();
          setBeats([]);
          setCounts({ n: 0, abn: 0 });
          setSnnAct(null);
          break;
      }
    };
    es.onerror = () => setOnline(false);
    return () => es.close();
  }, [applyStatus]);

  useEffect(() => {
    if (online) apiGet<ModelInfo>("/api/model").then(setModel).catch(() => setModel(null));
  }, [online]);

  const value: Live = {
    online, status, beats, logs, counts, model, snn: snnAct, sound, setSound,
    send: async (cmd) => { await apiPost("/api/command", { cmd }).catch(() => undefined); },
    setSource: async (mode, port) => { await apiPost("/api/source", { mode, port: port || null }).catch(() => undefined); },
    setRecording: async (on) => { await apiPost("/api/record", { on }).catch(() => undefined); },
    setModelKind: async (kind) => {
      try {
        const r = await apiPost<{ error?: string; model_kind?: string }>("/api/model-kind", { kind });
        if (r.model_kind === kind) return null;
        return r.error === "not found"
          ? "The backend is running older code without the model switch. Stop it (Ctrl+C) and start python host/dashboard.py again."
          : r.error ?? "The backend did not switch models.";
      } catch {
        return "Can't reach the backend.";
      }
    },
  };

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}
