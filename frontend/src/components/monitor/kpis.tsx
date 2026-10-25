"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";
import { BrainCircuit, Clock, Heart, ListChecks } from "lucide-react";
import { hrZone, isAbn } from "@/lib/format";
import { useLive } from "../live-provider";
import { Card, Chip, cx } from "../ui";

function KpiHead({ icon, label, children }: { icon: React.ReactNode; label: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-2 text-[12.5px] font-medium text-muted">{icon}{label}</span>
      {children}
    </div>
  );
}

function HeartRate() {
  const { beats } = useLive();
  const last = beats[beats.length - 1];
  const heart = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const el = heart.current;
    if (!el || !last) return;
    el.classList.remove("animate-thump");
    void el.getBoundingClientRect();
    el.classList.add("animate-thump");
  }, [last?.n]);

  const hrs = useMemo(() => beats.slice(-60).map((b) => b.bpm).filter(Boolean), [beats]);
  const spark = useMemo(() => hrs.slice(-40).map((v, i) => ({ i, v })), [hrs]);
  const zone = hrZone(last?.bpm);
  const avg = hrs.length ? Math.round(hrs.reduce((a, c) => a + c, 0) / hrs.length) : null;

  return (
    <Card className="relative overflow-hidden">
      <div className="pointer-events-none absolute -right-10 -top-10 size-40 rounded-full bg-danger/10 blur-3xl" />
      <KpiHead icon={<Heart size={15} />} label="Heart rate"><Chip tone={zone.tone}>{zone.label}</Chip></KpiHead>
      <div className="mt-3 flex items-end gap-3">
        <svg ref={heart} viewBox="0 0 32 32" className="mb-1.5 size-8 fill-danger drop-shadow-[0_0_10px_rgba(255,90,110,0.45)]">
          <path d="M16 28S3 20 3 11a6.5 6.5 0 0 1 13-1 6.5 6.5 0 0 1 13 1c0 9-13 17-13 17z" />
        </svg>
        <span className="text-5xl font-bold tabular-nums tracking-tight">{last?.bpm || "--"}</span>
        <span className="mb-1.5 text-muted">bpm</span>
      </div>
      <div className="mt-2 h-10">
        {spark.length > 1 && (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={spark} margin={{ top: 2, bottom: 2, left: 0, right: 0 }}>
              <defs>
                <linearGradient id="hrfill" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0" stopColor="var(--danger)" stopOpacity={0.35} />
                  <stop offset="1" stopColor="var(--danger)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <YAxis hide domain={["dataMin - 3", "dataMax + 3"]} />
              <Area type="monotone" dataKey="v" stroke="var(--danger)" strokeWidth={1.6} fill="url(#hrfill)" isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
      <div className="mt-2 flex gap-4 text-xs text-muted">
        <span>Avg <b className="text-fg tabular-nums">{avg ?? "--"}</b></span>
        <span>Min <b className="text-fg tabular-nums">{hrs.length ? Math.min(...hrs) : "--"}</b></span>
        <span>Max <b className="text-fg tabular-nums">{hrs.length ? Math.max(...hrs) : "--"}</b></span>
      </div>
    </Card>
  );
}

function Verdict() {
  const { beats, status } = useLive();
  const last = beats[beats.length - 1];
  const label = last ? last.model || last.device : null;
  const abn = isAbn(label);
  const conf = last?.conf ?? 0;
  const C = 2 * Math.PI * 27;
  return (
    <Card>
      <KpiHead icon={<BrainCircuit size={15} />} label="Model verdict">
        <Chip tone={status?.verdict_by === "SNN" ? "info" : "neutral"}>{status?.verdict_by ?? "Random Forest"}</Chip>
      </KpiHead>
      <div className="mt-3 flex items-center gap-4">
        <div className="relative size-[78px] shrink-0">
          <svg viewBox="0 0 64 64" className="size-full -rotate-90">
            <circle cx="32" cy="32" r="27" fill="none" strokeWidth="7" className="stroke-panel-2" />
            <circle
              cx="32" cy="32" r="27" fill="none" strokeWidth="7" strokeLinecap="round"
              stroke={label ? (abn ? "var(--danger)" : "var(--ok)") : "var(--faint)"}
              strokeDasharray={C} strokeDashoffset={C * (1 - conf)}
              style={{ transition: "stroke-dashoffset .4s, stroke .3s" }}
            />
          </svg>
          <div className="absolute inset-0 grid place-content-center text-center leading-tight">
            <b className="text-base tabular-nums">{last?.conf != null ? `${Math.round(conf * 100)}%` : "--"}</b>
            <small className="text-[10.5px] text-muted">conf.</small>
          </div>
        </div>
        <div className="min-w-0">
          <div className={cx("text-[clamp(1.35rem,1.9vw,1.9rem)] font-bold leading-tight tracking-tight",label ? (abn ? "text-danger" : "text-ok") : "text-muted")}>
            {label ?? "Waiting"}
          </div>
          <div className="mt-1 text-[12.5px] text-muted">
            Device screen: <b className={isAbn(last?.device) ? "text-danger" : "text-fg"}>{last?.device ?? "--"}</b>
          </div>
          {last?.truth && (
            <div className="mt-0.5 text-[12.5px] text-muted">
              Annotation: <b className="text-fg">{last.truth.sym}</b> ({last.truth.aami === "N" ? "normal" : `AAMI ${last.truth.aami}`}){" "}
              {isAbn(label) === last.truth.abnormal
                ? <span className="font-semibold text-ok">✓ match</span>
                : <span className="font-semibold text-danger">✗ mismatch</span>}
            </div>
          )}
        </div>
      </div>
      <div className="mt-4 text-xs">
        {last?.uncal ? (
          <span className="text-warn">Uncalibrated - press Calibrate on a clean live beat</span>
        ) : status && !status.model_ready ? (
          <span className="text-warn">Model not loaded - run python train_model.py</span>
        ) : (
          <span className="text-muted">
            {last?.via?.startsWith("SNN") ? "Classified from the beat waveform by the spiking network"
              : last?.via?.includes("no waveform") ? "Random Forest fallback: no waveform stream"
                : "Classified on P, Q, R amplitudes per beat"}
          </span>
        )}
      </div>
    </Card>
  );
}

function BeatCounts() {
  const { counts } = useLive();
  const p = counts.n ? (counts.abn / counts.n) * 100 : 0;
  return (
    <Card>
      <KpiHead icon={<ListChecks size={15} />} label="Beats analysed">
        <Chip tone={p > 20 ? "danger" : p > 0 ? "warn" : "ok"}>{p.toFixed(p && p < 10 ? 1 : 0)}% abnormal</Chip>
      </KpiHead>
      <div className="mt-3 text-5xl font-bold tabular-nums tracking-tight">{counts.n.toLocaleString()}</div>
      <div className="mt-5 flex h-2.5 overflow-hidden rounded-full bg-panel-2">
        <span className="bg-ok transition-all" style={{ width: counts.n ? `${100 - p}%` : 0 }} />
        <span className="bg-danger transition-all" style={{ width: `${p}%` }} />
      </div>
      <div className="mt-3 flex gap-4 text-xs text-muted">
        <span className="flex items-center gap-1.5"><i className="size-2.5 rounded-sm bg-ok" />Normal <b className="text-fg tabular-nums">{counts.n - counts.abn}</b></span>
        <span className="flex items-center gap-1.5"><i className="size-2.5 rounded-sm bg-danger" />Abnormal <b className="text-fg tabular-nums">{counts.abn}</b></span>
      </div>
    </Card>
  );
}

function Session() {
  const { status } = useLive();
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now() / 1000);
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, []);
  const s = status && now ? Math.max(0, Math.floor(now - status.started)) : 0;
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  const live = status?.source === "live";
  const calTone = live && !status?.calibrated && status?.dev_mode === "LIVE";
  return (
    <Card>
      <KpiHead icon={<Clock size={15} />} label="Session">
        <Chip tone={live ? (status?.dev_mode === "LIVE" ? "info" : "warn") : "warn"}>
          {status ? (live ? status.dev_mode : status.source === "replay" ? "MIT-BIH REPLAY" : "SYNTHETIC") : "--"}
        </Chip>
      </KpiHead>
      <div className="mt-3 font-mono text-5xl font-bold tabular-nums tracking-tight">
        {status ? `${hh ? `${hh}:` : ""}${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : "--:--"}
      </div>
      <dl className="mt-4 space-y-1.5 text-[12.5px]">
        <div className="flex justify-between gap-2"><dt className="text-muted">Source</dt>
          <dd className="truncate font-medium">{live ? `${status?.port ?? "auto"} · ${status?.connected ? "connected" : "offline"}` : status?.source === "replay" ? `MIT-BIH record ${status.replay?.record ?? "…"}` : "Synthetic generator"}</dd></div>
        <div className="flex justify-between gap-2"><dt className="text-muted">Calibration</dt>
          <dd className={cx("font-medium", calTone && "text-warn")}>
            {!live ? (status?.source === "replay" ? "n/a (recorded)" : "n/a (simulated)") : status?.calibrated ? "Calibrated" : status?.dev_mode !== "LIVE" ? "Test vector" : "Not calibrated"}
          </dd></div>
        <div className="flex justify-between gap-2"><dt className="text-muted">Recording</dt>
          <dd className={cx("truncate font-medium", status?.recording && "text-danger")} title={status?.recording ?? ""}>{status?.recording ?? "off"}</dd></div>
      </dl>
    </Card>
  );
}

export function Kpis() {
  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
      <HeartRate />
      <Verdict />
      <BeatCounts />
      <Session />
    </div>
  );
}
