"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid, Legend, Line, LineChart, ReferenceDot, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart,
  Tooltip, XAxis, YAxis, ZAxis,
} from "recharts";
import { BrainCircuit, Crosshair, Sigma, SlidersHorizontal, TriangleAlert } from "lucide-react";
import { apiPost } from "@/lib/api";
import { FEATURE_COLOR, isAbn } from "@/lib/format";
import { useLive } from "./live-provider";
import { axisProps, tooltipProps } from "./monitor/panels";
import { Button, Card, CardHeader, Segmented, cx } from "./ui";

type F = "P" | "Q" | "R";
const RANGES: Record<F, [number, number]> = { P: [0, 0.6], Q: [-0.6, 0], R: [0, 1.8] };
const PRESETS: [string, number, number, number][] = [
  ["Firmware SIM-NORMAL", 0.173, -0.245, 0.74],
  ["SIM-NORMAL 109 bpm", 0.132, -0.289, 0.7],
  ["Firmware SIM-ABNORMAL", 0.412, -0.413, 1.254],
  ["Normal class mean", 0.145, -0.251, 0.733],
  ["Abnormal class mean", 0.403, -0.448, 1.308],
  ["Borderline", 0.25, -0.33, 1.05],
];

type Prediction = { label: string; confidence: number; proba: Record<string, number> } | { error: string };

// same shape the backend's synthetic generator draws, from three amplitudes
function synthBeat(v: Record<F, number>) {
  const g = (t: number, m: number, s: number) => Math.exp(-0.5 * ((t - m) / s) ** 2);
  return Array.from({ length: 241 }, (_, i) => {
    const t = (i / 240) * 0.8;
    return {
      t: +t.toFixed(3),
      mv: v.P * g(t, 0.12, 0.022) + v.Q * g(t, 0.232, 0.009) + v.R * g(t, 0.26, 0.0105)
        - 0.25 * g(t, 0.29, 0.01) + 0.25 * g(t, 0.52, 0.045),
    };
  });
}

export function LabView() {
  const { model, beats } = useLive();
  const [v, setV] = useState<Record<F, number>>({ P: 0.173, Q: -0.245, R: 0.74 });
  const [pred, setPred] = useState<Prediction | null>(null);
  const [xf, setXf] = useState<"P" | "Q">("P");

  useEffect(() => {
    const t = setTimeout(() => {
      apiPost<Prediction>("/api/predict", v).then(setPred).catch(() => setPred({ error: "Backend offline" }));
    }, 90);
    return () => clearTimeout(t);
  }, [v]);

  const set = (f: F, x: number) => { if (!Number.isNaN(x)) setV((o) => ({ ...o, [f]: +x.toFixed(4) })); };
  const beat = useMemo(() => synthBeat(v), [v]);
  const train = useMemo(() => (model?.rows ?? []).map(([P, Q, R, label]) => ({ P, Q, R, label })), [model]);
  const liveBeats = useMemo(() => beats.slice(-80).map((b) => ({ P: b.P, Q: b.Q, R: b.R })), [beats]);
  const last = beats[beats.length - 1];
  const ok = pred && "label" in pred;
  const abn = ok && isAbn(pred.label);

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader title="Feature input" icon={<SlidersHorizontal size={18} />} sub="Amplitudes in mV, as the firmware reports them" />
        <div className="flex flex-col gap-5">
          {(["P", "Q", "R"] as F[]).map((f) => (
            <div key={f} className="grid grid-cols-[26px_1fr_92px] items-center gap-4">
              <b className="text-base" style={{ color: FEATURE_COLOR[f] }}>{f}</b>
              <input type="range" min={RANGES[f][0]} max={RANGES[f][1]} step={0.001} value={v[f]} onChange={(e) => set(f, +e.target.value)} className="w-full" />
              <input
                type="number" step={0.01} value={v[f]} onChange={(e) => set(f, +e.target.value)}
                className="w-full rounded-xl border border-line-strong bg-panel-2 px-2.5 py-1.5 text-right font-mono text-[13px]"
              />
            </div>
          ))}
        </div>
        <div className="mt-6 text-xs font-medium text-muted">Presets</div>
        <div className="mt-2 flex flex-wrap gap-2">
          {PRESETS.map(([name, P, Q, R]) => <Button key={name} onClick={() => setV({ P, Q, R })}>{name}</Button>)}
          <Button variant="primary" disabled={!last} onClick={() => last && setV({ P: last.P, Q: last.Q, R: last.R })}>
            <Crosshair size={15} /> Latest live beat
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Prediction" icon={<BrainCircuit size={18} />}
          sub={model?.ready ? `Random Forest · ${model.n_estimators} trees · trained on ${model.rows.length} rows` : "Random Forest"}
        />
        <div className={cx("text-4xl font-bold tracking-tight", ok ? (abn ? "text-danger" : "text-ok") : "text-muted")}>
          {pred ? ("error" in pred ? pred.error : `${pred.label} · ${Math.round(pred.confidence * 100)}%`) : "…"}
        </div>
        <div className="mt-4 space-y-2.5">
          {ok && Object.entries(pred.proba).sort().reverse().map(([k, p]) => (
            <div key={k} className="grid grid-cols-[80px_1fr_56px] items-center gap-3 text-[13px]">
              <span>{k}</span>
              <div className="h-2.5 overflow-hidden rounded-full bg-panel-2">
                <div className={cx("h-full rounded-full transition-all duration-300", isAbn(k) ? "bg-danger" : "bg-ok")} style={{ width: `${p * 100}%` }} />
              </div>
              <span className="text-right font-mono">{(p * 100).toFixed(1)}%</span>
            </div>
          ))}
        </div>
        <div className="mt-5 text-xs font-semibold text-muted">Synthesised beat</div>
        <div className="mt-2 h-[150px] rounded-xl border border-line bg-[var(--ecg-bg)]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={beat} margin={{ top: 14, right: 12, bottom: 4, left: 12 }}>
              <CartesianGrid stroke="var(--grid-major)" />
              <XAxis dataKey="t" type="number" domain={[0, 0.8]} hide />
              <YAxis domain={[(m: number) => Math.min(-0.7, m) - 0.1, (m: number) => Math.max(1, m) + 0.15]} hide />
              <Line dataKey="mv" stroke="var(--trace)" strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader
          title="Where this beat sits in the training data" icon={<Sigma size={18} />}
          sub={model ? `data.csv · ${Object.entries(model.counts).map(([k, n]) => `${n} ${k}`).join(" · ")} · your beat is the ring` : "data.csv"}
        >
          <Segmented value={xf} onChange={setXf} options={[{ value: "P", label: "P vs R" }, { value: "Q", label: "Q vs R" }]} />
        </CardHeader>
        <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(260px,1fr)]">
          <div className="h-[340px]">
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
                <CartesianGrid stroke="var(--line)" />
                <XAxis type="number" dataKey={xf} name={xf} unit=" mV" domain={["auto", "auto"]} {...axisProps} tickFormatter={(t: number) => t.toFixed(2)} />
                <YAxis type="number" dataKey="R" name="R" unit=" mV" domain={["auto", "auto"]} {...axisProps} tickFormatter={(t: number) => t.toFixed(1)} />
                <ZAxis range={[40, 40]} />
                <Tooltip {...tooltipProps} cursor={{ strokeDasharray: "3 3" }} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
                <Scatter name="Normal (training)" data={train.filter((r) => !isAbn(r.label))} fill="var(--ok)" fillOpacity={0.75} isAnimationActive={false} />
                <Scatter name="Abnormal (training)" data={train.filter((r) => isAbn(r.label))} fill="var(--danger)" fillOpacity={0.75} isAnimationActive={false} />
                {liveBeats.length > 0 && <Scatter name="Live beats" data={liveBeats} fill="var(--accent)" fillOpacity={0.45} shape="diamond" isAnimationActive={false} />}
                <ReferenceLine x={v[xf]} stroke="var(--accent)" strokeDasharray="4 4" />
                <ReferenceLine y={v.R} stroke="var(--accent)" strokeDasharray="4 4" />
                <ReferenceDot x={v[xf]} y={v.R} r={9} fill="none" stroke="var(--accent)" strokeWidth={3} />
                <ReferenceDot x={v[xf]} y={v.R} r={4} fill={abn ? "var(--danger)" : "var(--ok)"} stroke="none" />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
          <div>
            <div className="text-xs font-semibold text-muted">Feature importance</div>
            <div className="mt-3 space-y-3">
              {model?.importances ? Object.entries(model.importances).sort((a, b) => b[1] - a[1]).map(([f, x]) => (
                <div key={f} className="grid grid-cols-[20px_1fr_44px] items-center gap-3 text-[13px]">
                  <b style={{ color: FEATURE_COLOR[f] }}>{f}</b>
                  <div className="h-2 overflow-hidden rounded-full bg-panel-2">
                    <div className="h-full rounded-full" style={{ width: `${x * 100}%`, background: FEATURE_COLOR[f] }} />
                  </div>
                  <span className="text-right font-mono text-muted">{Math.round(x * 100)}%</span>
                </div>
              )) : <p className="text-muted">Not available</p>}
            </div>
            <div className="mt-6 flex gap-3 rounded-xl border border-warn/40 bg-warn/10 p-3.5 text-[12.5px] leading-relaxed">
              <TriangleAlert size={18} className="shrink-0 text-warn" />
              <div>
                <b className="text-warn">Read this before quoting accuracy.</b>
                <p className="mt-1 text-muted">
                  data.csv is 100 synthetic rows and the two classes don&apos;t overlap on any feature, so every model
                  scores 100%. That number isn&apos;t meaningful; real figures need annotated records (MIT-BIH / PTB-XL) in Review 2.
                </p>
              </div>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
