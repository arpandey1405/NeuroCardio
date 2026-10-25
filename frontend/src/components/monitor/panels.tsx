"use client";

import { useMemo, useState } from "react";
import {
  CartesianGrid, Legend, Line, LineChart, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { LineChart as LineIcon, ScrollText, Shapes, Terminal } from "lucide-react";
import {
  BPM_BRADY, BPM_TACHY, DEVICE_TH, FEATURE_COLOR, clamp, clockTime, isAbn, pct, signed,
} from "@/lib/format";
import type { Beat } from "@/lib/types";
import { useLive } from "../live-provider";
import { Card, CardHeader, Chip, Segmented, cx } from "../ui";

/* ------------------------------------------------------------ morphology */
const F_MIN = -0.6, F_MAX = 1.6;
const fx = (v: number) => ((clamp(v, F_MIN, F_MAX) - F_MIN) / (F_MAX - F_MIN)) * 100;

export function Morphology() {
  const { beats, model } = useLive();
  const b = beats[beats.length - 1];
  return (
    <Card>
      <CardHeader title="Beat morphology" icon={<Shapes size={18} />} sub="Latest beat, measured against the local isoelectric line" />
      <div className="flex flex-col gap-4">
        {(["P", "Q", "R", "S"] as const).map((f) => {
          const v = b?.[f];
          const a = v == null ? fx(0) : fx(Math.min(0, v));
          const z = v == null ? fx(0) : fx(Math.max(0, v));
          const th = f !== "S" ? DEVICE_TH[f] : null;
          return (
            <div key={f} className="grid grid-cols-[28px_1fr_86px] items-center gap-3">
              <span className="text-base font-bold" style={{ color: FEATURE_COLOR[f] }}>{f}</span>
              <div className="relative h-7 overflow-hidden rounded-lg bg-panel-2">
                {model && f !== "S" && Object.entries(model.ranges).map(([lab, r]) => (
                  <div
                    key={lab}
                    title={`${lab} class: ${r[f][0]} to ${r[f][1]} mV`}
                    className={cx("absolute inset-y-0", isAbn(lab) ? "bg-danger/15" : "bg-ok/15")}
                    style={{ left: `${fx(r[f][0])}%`, width: `${fx(r[f][1]) - fx(r[f][0])}%` }}
                  />
                ))}
                <div className="absolute inset-y-0 w-px bg-line-strong" style={{ left: `${fx(0)}%` }} />
                {th != null && (
                  <div title={`Device threshold ${th} mV`} className="absolute inset-y-0 border-l-2 border-dashed border-warn/80" style={{ left: `${fx(th)}%` }} />
                )}
                <div
                  className="absolute top-2 h-3 rounded transition-all duration-300"
                  style={{ left: `${a}%`, width: `${z - a}%`, background: FEATURE_COLOR[f] }}
                />
                {v != null && (
                  <div className="absolute inset-y-1 w-[3px] rounded bg-fg transition-all duration-300" style={{ left: `calc(${fx(v)}% - 1.5px)` }} />
                )}
              </div>
              <span className="text-right font-mono text-sm tabular-nums">{signed(v)} <small className="text-muted">mV</small></span>
            </div>
          );
        })}
        <div className="grid grid-cols-[28px_1fr_86px] gap-3">
          <span />
          <div className="relative h-4 font-mono text-[10.5px] text-faint">
            {[-0.5, 0, 0.5, 1, 1.5].map((t) => (
              <span key={t} className="absolute -translate-x-1/2" style={{ left: `${fx(t)}%` }}>{t}</span>
            ))}
          </div>
          <span />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-xs text-muted">
        <span className="flex items-center gap-1.5"><i className="h-2.5 w-3.5 rounded-sm border border-ok bg-ok/15" />Normal class range</span>
        <span className="flex items-center gap-1.5"><i className="h-2.5 w-3.5 rounded-sm border border-danger bg-danger/15" />Abnormal class range</span>
        <span className="flex items-center gap-1.5"><i className="h-3 border-l-2 border-dashed border-warn" />Device threshold</span>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------ charts */
export const axisProps = {
  stroke: "var(--faint)",
  tick: { fill: "var(--muted)", fontSize: 11 },
  tickLine: false,
  axisLine: { stroke: "var(--line)" },
  minTickGap: 24,
};

export const tooltipProps = {
  contentStyle: {
    background: "var(--panel)", border: "1px solid var(--line-strong)", borderRadius: 12,
    fontSize: 12, boxShadow: "0 10px 30px -10px rgba(0,0,0,.4)",
  },
  labelStyle: { color: "var(--muted)" },
  itemStyle: { padding: 0 },
};

// beat dots coloured by verdict
export function verdictDot(r = 3) {
  function VerdictDot(props: { cx?: number; cy?: number; payload?: { abnormal?: boolean; abn?: boolean }; index?: number }) {
    const { cx: x, cy: y, payload, index } = props;
    if (x == null || y == null) return <g key={index} />;
    const bad = payload?.abnormal ?? payload?.abn;
    return <circle key={index} cx={x} cy={y} r={r} fill={bad ? "var(--danger)" : "var(--ok)"} stroke="var(--panel)" strokeWidth={1} />;
  }
  return VerdictDot;
}

export function hrDomain(vals: number[]): [number, number] {
  const v = vals.filter(Boolean);
  return [Math.min(40, ...v) - 5, Math.max(130, ...v) + 5];
}

export function Trends() {
  const { beats } = useLive();
  const [mode, setMode] = useState<"hr" | "amp" | "conf">("hr");
  const data = useMemo(() => beats.slice(-120), [beats]);
  return (
    <Card>
      <CardHeader title="Trends" icon={<LineIcon size={18} />} sub={data.length ? `Last ${data.length} beats` : "Last 120 beats"}>
        <Segmented
          value={mode}
          onChange={setMode}
          options={[{ value: "hr", label: "Heart rate" }, { value: "amp", label: "Amplitudes" }, { value: "conf", label: "Confidence" }]}
        />
      </CardHeader>
      <div className="h-[250px]">
        {data.length === 0 ? (
          <div className="grid h-full place-items-center text-muted">No beats yet</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
              <CartesianGrid stroke="var(--line)" vertical={false} />
              <XAxis dataKey="n" {...axisProps} />
              {mode === "hr" && <>
                <YAxis {...axisProps} domain={hrDomain(data.map((b) => b.bpm))} />
                <ReferenceArea y1={BPM_BRADY} y2={BPM_TACHY} fill="var(--ok)" fillOpacity={0.07} />
                <Line type="monotone" dataKey="bpm" name="HR (bpm)" stroke="var(--accent)" strokeWidth={1.8} dot={verdictDot()} isAnimationActive={false} />
              </>}
              {mode === "amp" && <>
                <YAxis {...axisProps} domain={["auto", "auto"]} tickFormatter={(t: number) => t.toFixed(1)} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
                {(["R", "P", "S", "Q"] as const).map((f) => (
                  <Line key={f} type="monotone" dataKey={f} stroke={FEATURE_COLOR[f]} strokeWidth={1.7} dot={false} isAnimationActive={false} />
                ))}
              </>}
              {mode === "conf" && <>
                <YAxis {...axisProps} domain={[0.4, 1.02]} tickFormatter={(t: number) => `${Math.round(t * 100)}%`} />
                <Line type="monotone" dataKey="conf" name="confidence" stroke="var(--faint)" strokeWidth={1.2} dot={verdictDot()} isAnimationActive={false} />
              </>}
              <Tooltip {...tooltipProps} labelFormatter={(l) => `Beat #${l}`}
                formatter={(v) => (typeof v === "number" ? (mode === "conf" ? pct(v) : mode === "amp" ? `${signed(v)} mV` : v) : v)} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------ beat log */
function BeatRow({ b }: { b: Beat }) {
  return (
    <tr className={cx("border-t border-line hover:bg-panel-2", b.abnormal && "shadow-[inset_3px_0_0_var(--danger)]")}>
      <td className="px-3 py-2 font-mono text-[12.5px] text-muted">{b.n}</td>
      <td className="px-3 py-2 font-mono text-[12.5px]">{clockTime(b.t)}</td>
      <td className="px-3 py-2 font-mono text-[12.5px]">{b.bpm || "--"}</td>
      {(["P", "Q", "R", "S"] as const).map((f) => <td key={f} className="px-3 py-2 font-mono text-[12.5px]">{signed(b[f])}</td>)}
      <td className="px-3 py-2">
        <span className={isAbn(b.device) ? "text-warn" : ""}>{b.device}</span>
        {b.uncal && <Chip tone="warn" className="ml-1.5">UNCAL</Chip>}
      </td>
      <td className="px-3 py-2">{b.model ? <Chip tone={isAbn(b.model) ? "danger" : "ok"}>{b.model}</Chip> : "--"}</td>
      <td className="px-3 py-2 font-mono text-[12.5px]">{pct(b.conf)}</td>
    </tr>
  );
}

export function BeatLog() {
  const { beats } = useLive();
  const [onlyAbn, setOnlyAbn] = useState(false);
  const rows = useMemo(() => {
    const list = onlyAbn ? beats.filter((b) => b.abnormal) : beats;
    return list.slice(-200).reverse();
  }, [beats, onlyAbn]);
  return (
    <Card>
      <CardHeader title="Beat log" icon={<ScrollText size={18} />} sub="Newest first · amplitudes in mV">
        <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-muted">
          <input type="checkbox" checked={onlyAbn} onChange={(e) => setOnlyAbn(e.target.checked)} className="accent-[var(--accent)]" />
          Abnormal only
        </label>
      </CardHeader>
      <div className="scroll-thin max-h-[400px] overflow-auto rounded-xl border border-line">
        <table className="w-full whitespace-nowrap text-left text-[13px] tabular-nums">
          <thead className="sticky top-0 z-10 bg-panel-2 text-[11px] uppercase tracking-wider text-muted">
            <tr>{["#", "Time", "HR", "P", "Q", "R", "S", "Device", "Model", "Conf."].map((h) => <th key={h} className="px-3 py-2.5 font-semibold">{h}</th>)}</tr>
          </thead>
          <tbody>{rows.map((b) => <BeatRow key={b.n} b={b} />)}</tbody>
        </table>
        {rows.length === 0 && <div className="p-8 text-center text-muted">No beats yet.</div>}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------ event log */
const levelCls = { info: "text-muted", ok: "text-ok", warn: "text-warn", error: "text-danger" } as const;

export function EventLog() {
  const { logs } = useLive();
  const list = useMemo(() => logs.slice(-100).reverse(), [logs]);
  return (
    <Card className="flex min-h-[240px] flex-col">
      <CardHeader title="Event log" icon={<Terminal size={18} />} sub="Device status lines and alarms, newest first" />
      <ol className="scroll-thin max-h-[280px] flex-1 overflow-auto rounded-xl border border-line bg-panel-2 p-3 font-mono text-xs">
        {list.length === 0 && <li className="text-faint">No events yet.</li>}
        {list.map((e, i) => (
          <li key={`${e.t}-${i}`} className="flex gap-3 py-0.5">
            <time className="shrink-0 text-faint">{clockTime(e.t)}</time>
            <span className={levelCls[e.level] ?? "text-muted"}>{e.text}</span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

