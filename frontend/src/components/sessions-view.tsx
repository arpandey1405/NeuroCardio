"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CartesianGrid, Legend, Line, LineChart, ReferenceArea, ResponsiveContainer, Scatter, ScatterChart,
  Tooltip, XAxis, YAxis, ZAxis,
} from "recharts";
import { Download, FileSpreadsheet, FolderOpen, RefreshCw, TriangleAlert } from "lucide-react";
import { API_URL, apiGet } from "@/lib/api";
import { BPM_BRADY, BPM_TACHY, FEATURE_COLOR, duration, isAbn, pct, prettySession, signed } from "@/lib/format";
import type { SessionRow, SessionSummary } from "@/lib/types";
import { useLive } from "./live-provider";
import { axisProps, hrDomain, tooltipProps, verdictDot } from "./monitor/panels";
import { Card, CardHeader, Chip, Segmented, Stat, cx } from "./ui";

type Detail = { summary: SessionSummary; rows: SessionRow[] };

export function SessionsView() {
  const { status, online } = useLive();
  const [list, setList] = useState<SessionSummary[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);

  const load = useCallback(async () => {
    try {
      const l = await apiGet<SessionSummary[]>("/api/sessions");
      setList(l);
      setActive((a) => a ?? l[0]?.name ?? null);
    } catch { setList([]); }
  }, []);

  useEffect(() => { if (online) load(); }, [online, load]);

  useEffect(() => {
    if (!active) return;
    let stale = false;
    apiGet<Detail>(`/api/sessions/${encodeURIComponent(active)}`)
      .then((d) => { if (!stale) setDetail(d); })
      .catch(() => undefined);
    return () => { stale = true; };
  }, [active]);

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[330px_minmax(0,1fr)]">
      <Card className="lg:sticky lg:top-24">
        <CardHeader title="Recordings" icon={<FolderOpen size={18} />} sub={list ? `${list.length} files in host/` : "Loading…"}>
          <button onClick={load} title="Refresh" className="grid size-9 place-items-center rounded-xl border border-line bg-panel-2 text-muted hover:text-fg">
            <RefreshCw size={15} />
          </button>
        </CardHeader>
        <ul className="scroll-thin flex max-h-[calc(100vh-260px)] flex-col gap-2 overflow-auto">
          {list?.length === 0 && <li className="p-6 text-center text-muted">No recordings yet. Press Record on the monitor.</li>}
          {list?.map((s) => (
            <li key={s.name}>
              <button
                onClick={() => setActive(s.name)}
                className={cx(
                  "w-full rounded-xl border p-3 text-left transition",
                  s.name === active ? "border-accent bg-accent/10" : "border-line bg-panel-2 hover:border-line-strong",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-semibold">{prettySession(s.name)}</span>
                  {s.name === status?.recording ? <Chip tone="danger">● rec</Chip> : s.sources?.map((x) => (
                    <Chip key={x} tone={x.startsWith("SYN") ? "warn" : "info"}>{x.startsWith("SYN") ? "Synthetic" : "Live"}</Chip>
                  ))}
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-3 text-xs text-muted">
                  <span>{s.beats ?? "?"} beats</span>
                  <span>{s.avg_bpm ?? "--"} bpm avg</span>
                  <span className={s.abnormal ? "text-warn" : ""}>{s.abnormal ?? 0} abnormal</span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </Card>

      {detail ? <SessionDetail d={detail} /> : (
        <Card className="grid min-h-80 place-items-center text-muted">Select a recording to review it.</Card>
      )}
    </div>
  );
}

function SessionDetail({ d }: { d: Detail }) {
  const { summary: s, rows } = d;
  const [mode, setMode] = useState<"hr" | "amp" | "scatter">("hr");
  const data = useMemo(() => rows.map((r, i) => ({ ...r, i: i + 1, abn: isAbn(r.model || r.device) })), [rows]);
  const confs = rows.map((r) => r.conf).filter((c): c is number => c != null);
  const meanConf = confs.length ? confs.reduce((a, c) => a + c, 0) / confs.length : null;
  const abnPct = s.beats ? (s.abnormal / s.beats) * 100 : 0;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <Card>
        <CardHeader title={prettySession(s.name)} icon={<FileSpreadsheet size={18} />} sub={`${s.name} · ${(s.sources ?? []).join(", ")}`}>
          <a
            href={`${API_URL}/api/sessions/${encodeURIComponent(s.name)}?download`}
            className="inline-flex items-center gap-2 rounded-xl border border-line-strong bg-panel-2 px-3 py-1.5 text-[13px] font-medium hover:border-accent"
          >
            <Download size={15} /> Download CSV
          </a>
        </CardHeader>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-5">
          <Stat label="Beats" value={s.beats} />
          <Stat label="Duration" value={duration(s.start, s.end)} />
          <Stat label="Average HR" value={<>{s.avg_bpm ?? "--"}<span className="text-sm font-normal text-muted"> bpm</span></>} />
          <Stat label="Abnormal" value={`${abnPct.toFixed(1)}%`} tone={s.abnormal ? "danger" : "ok"} hint={`${s.abnormal} beats`} />
          <Stat label="Mean confidence" value={pct(meanConf)} />
        </div>
        {s.uncal > 0 && (
          <div className="mt-4 flex gap-3 rounded-xl border border-warn/40 bg-warn/10 p-3 text-[13px]">
            <TriangleAlert size={18} className="shrink-0 text-warn" />
            <span><b className="text-warn">{s.uncal} of {s.beats} beats were recorded uncalibrated.</b>{" "}
              <span className="text-muted">Their amplitudes may be on the wrong scale, so treat those verdicts with caution.</span></span>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="Recording timeline" sub="Per beat, coloured by model verdict">
          <Segmented value={mode} onChange={setMode} options={[
            { value: "hr", label: "Heart rate" }, { value: "amp", label: "Amplitudes" }, { value: "scatter", label: "P vs R" },
          ]} />
        </CardHeader>
        <div className="h-[300px]">
          <ResponsiveContainer width="100%" height="100%">
            {mode === "scatter" ? (
              <ScatterChart margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
                <CartesianGrid stroke="var(--line)" />
                <XAxis type="number" dataKey="P" name="P" unit=" mV" domain={["auto", "auto"]} {...axisProps} tickFormatter={(t: number) => t.toFixed(2)} />
                <YAxis type="number" dataKey="R" name="R" unit=" mV" domain={["auto", "auto"]} {...axisProps} tickFormatter={(t: number) => t.toFixed(1)} />
                <ZAxis range={[36, 36]} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
                <Tooltip {...tooltipProps} cursor={{ strokeDasharray: "3 3" }} />
                <Scatter name="Normal" data={data.filter((r) => !r.abn)} fill="var(--ok)" isAnimationActive={false} />
                <Scatter name="Abnormal" data={data.filter((r) => r.abn)} fill="var(--danger)" isAnimationActive={false} />
              </ScatterChart>
            ) : (
              <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -12 }}>
                <CartesianGrid stroke="var(--line)" vertical={false} />
                <XAxis dataKey="i" {...axisProps} />
                {mode === "hr" ? <>
                  <YAxis {...axisProps} domain={hrDomain(data.map((r) => r.bpm ?? 0))} />
                  <ReferenceArea y1={BPM_BRADY} y2={BPM_TACHY} fill="var(--ok)" fillOpacity={0.07} />
                  <Line dataKey="bpm" name="HR (bpm)" stroke="var(--accent)" strokeWidth={1.8} dot={verdictDot(2.6)} isAnimationActive={false} />
                </> : <>
                  <YAxis {...axisProps} tickFormatter={(t: number) => t.toFixed(1)} />
                  <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
                  {(["R", "P", "S", "Q"] as const).map((f) => (
                    <Line key={f} dataKey={f} stroke={FEATURE_COLOR[f]} strokeWidth={1.7} dot={false} isAnimationActive={false} />
                  ))}
                </>}
                <Tooltip {...tooltipProps} labelFormatter={(l) => `Beat #${l}`} />
              </LineChart>
            )}
          </ResponsiveContainer>
        </div>
      </Card>

      <Card>
        <CardHeader title="Beats" sub={`${rows.length} rows`} />
        <div className="scroll-thin max-h-[440px] overflow-auto rounded-xl border border-line">
          <table className="w-full whitespace-nowrap text-left text-[13px] tabular-nums">
            <thead className="sticky top-0 z-10 bg-panel-2 text-[11px] uppercase tracking-wider text-muted">
              <tr>{["#", "Time", "Scenario", "HR", "P", "Q", "R", "S", "Device", "Model", "Conf."].map((h) => <th key={h} className="px-3 py-2.5 font-semibold">{h}</th>)}</tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.i} className={cx("border-t border-line hover:bg-panel-2", r.abn && "shadow-[inset_3px_0_0_var(--danger)]")}>
                  <td className="px-3 py-2 font-mono text-[12.5px] text-muted">{r.i}</td>
                  <td className="px-3 py-2 font-mono text-[12.5px]">{r.timestamp?.slice(11)}</td>
                  <td className="px-3 py-2 text-muted">{r.scenario || "--"}</td>
                  <td className="px-3 py-2 font-mono text-[12.5px]">{r.bpm ?? "--"}</td>
                  {(["P", "Q", "R", "S"] as const).map((f) => <td key={f} className="px-3 py-2 font-mono text-[12.5px]">{signed(r[f])}</td>)}
                  <td className="px-3 py-2">{r.device}{r.uncal && <Chip tone="warn" className="ml-1.5">UNCAL</Chip>}</td>
                  <td className="px-3 py-2">{r.model ? <Chip tone={isAbn(r.model) ? "danger" : "ok"}>{r.model}</Chip> : "--"}</td>
                  <td className="px-3 py-2 font-mono text-[12.5px]">{pct(r.conf)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
