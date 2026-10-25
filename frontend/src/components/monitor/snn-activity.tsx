"use client";

import { Network } from "lucide-react";
import { useLive } from "../live-provider";
import { Card, CardHeader, Chip } from "../ui";

// raster geometry (SVG units == px vertically; stretched horizontally)
const COL = 10;                       // width of one time step
const TRACE_H = 72;
const IN_Y = 84, IN_ROW = 11;         // ON / OFF rows
const H1_Y = 118, H1_ROW = 5;
const GAP = 10;

export function SnnActivity() {
  const { status, snn } = useLive();
  if (status?.model_kind !== "snn-preview") return null;

  const steps = snn?.sizes.steps ?? 60;
  const h1n = snn?.sizes.h1 ?? 32;
  const h2n = snn?.sizes.h2 ?? 16;
  const H2_Y = H1_Y + h1n * H1_ROW + GAP;
  const H = H2_Y + h2n * H1_ROW + 4;
  const W = steps * COL;
  const rIdx = 20;                    // window starts 20 samples before R

  const trace = (() => {
    if (!snn) return "";
    const lo = Math.min(...snn.window), hi = Math.max(...snn.window);
    const y = (v: number) => 6 + (1 - (v - lo) / (hi - lo || 1)) * (TRACE_H - 12);
    return snn.window.map((v, i) => `${i * COL + COL / 2},${y(v).toFixed(1)}`).join(" ");
  })();

  const s = snn?.stats;
  const saving = s ? 1 - s.synops / s.dense_macs : 0;

  const labels = [
    { y: TRACE_H / 2, text: "beat" },
    { y: IN_Y + IN_ROW / 2, text: "ON" },
    { y: IN_Y + IN_ROW * 1.5, text: "OFF" },
    { y: H1_Y + (h1n * H1_ROW) / 2, text: `LIF 1 · ${h1n}` },
    { y: H2_Y + (h2n * H1_ROW) / 2, text: `LIF 2 · ${h2n}` },
  ];

  return (
    <Card>
      <CardHeader
        title="Spiking neural network"
        icon={<Network size={18} />}
        sub={snn
          ? `Beat #${snn.n} · level-crossing encoding → ${h1n} → ${h2n} LIF neurons · ${steps} time steps (10 ms each)`
          : "Waiting for the first complete beat (0.4 s after its R peak)…"}
      >
        <Chip tone="info">SNN preview</Chip>
      </CardHeader>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_280px]">
        <div className="min-w-0">
          <div className="grid grid-cols-[64px_minmax(0,1fr)] gap-2">
            <div className="relative" style={{ height: H }}>
              {labels.map((l) => (
                <span key={l.text} className="absolute right-0 -translate-y-1/2 whitespace-nowrap font-mono text-[10.5px] text-muted" style={{ top: l.y }}>
                  {l.text}
                </span>
              ))}
            </div>
            <div className="overflow-hidden rounded-xl border border-line bg-[var(--ecg-bg)]">
              <svg key={snn?.n} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block w-full animate-[fade_.35s_ease]" style={{ height: H }}>
                {/* time grid every 100 ms */}
                {Array.from({ length: steps / 10 + 1 }, (_, i) => (
                  <line key={i} x1={i * 10 * COL} x2={i * 10 * COL} y1={0} y2={H} stroke="var(--grid-major)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                ))}
                <line x1={rIdx * COL + COL / 2} x2={rIdx * COL + COL / 2} y1={0} y2={H} stroke="var(--danger)" strokeDasharray="3 3" strokeOpacity={0.6} vectorEffect="non-scaling-stroke" />
                {trace && <polyline points={trace} fill="none" stroke="var(--trace)" strokeWidth={1.8} vectorEffect="non-scaling-stroke" />}

                {/* input spikes */}
                <rect x={0} y={IN_Y} width={W} height={IN_ROW * 2} fill="var(--panel-2)" opacity={0.5} />
                {snn?.on.map((t) => <rect key={`on${t}`} x={t * COL + 2} y={IN_Y + 1.5} width={COL - 4} height={IN_ROW - 3} rx={1.5} fill="var(--ok)" />)}
                {snn?.off.map((t) => <rect key={`off${t}`} x={t * COL + 2} y={IN_Y + IN_ROW + 1.5} width={COL - 4} height={IN_ROW - 3} rx={1.5} fill="var(--danger)" />)}

                {/* hidden layers */}
                <rect x={0} y={H1_Y} width={W} height={h1n * H1_ROW} fill="var(--panel-2)" opacity={0.5} />
                <rect x={0} y={H2_Y} width={W} height={h2n * H1_ROW} fill="var(--panel-2)" opacity={0.5} />
                {snn?.h1.map(([t, i]) => <rect key={`a${t}-${i}`} x={t * COL + 2} y={H1_Y + i * H1_ROW + 0.5} width={COL - 4} height={H1_ROW - 1} fill="var(--accent)" />)}
                {snn?.h2.map(([t, i]) => <rect key={`b${t}-${i}`} x={t * COL + 2} y={H2_Y + i * H1_ROW + 0.5} width={COL - 4} height={H1_ROW - 1} fill="var(--violet)" />)}
              </svg>
            </div>
          </div>
          <div className="ml-[72px] mt-1.5 flex justify-between font-mono text-[10.5px] text-faint">
            <span>−200 ms</span><span className="text-danger">R</span><span>+200 ms</span><span>+400 ms</span>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <Tile label="Input spikes" value={s ? s.input_events : "--"} hint={s ? `of ${steps * 2} slots · ${(s.input_sparsity * 100).toFixed(0)}% sparse` : "ON + OFF channels"} />
          <Tile label="Hidden spikes" value={s ? s.h1_spikes + s.h2_spikes : "--"}
            hint={s ? `layer 1 ${(s.h1_rate * 100).toFixed(1)}% · layer 2 ${(s.h2_rate * 100).toFixed(1)}% firing` : "two LIF layers"} />
          <Tile label="Synaptic operations" value={s ? s.synops.toLocaleString() : "--"}
            hint={s ? `vs ${s.dense_macs.toLocaleString()} MACs dense · ${(saving * 100).toFixed(0)}% fewer` : "event-driven accumulates"} accent />
          <p className="text-[11.5px] leading-relaxed text-faint">
            Pipeline preview: real spike encoding of each live beat through an untrained network.
            Verdicts come from the {status?.verdict_by ?? "Random Forest"} until the trained SNN is loaded.
          </p>
        </div>
      </div>
    </Card>
  );
}

function Tile({ label, value, hint, accent }: { label: string; value: React.ReactNode; hint: string; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-line bg-panel-2 px-3.5 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className={`mt-0.5 text-2xl font-semibold tabular-nums tracking-tight ${accent ? "text-accent" : ""}`}>{value}</div>
      <div className="mt-0.5 text-[11.5px] text-faint">{hint}</div>
    </div>
  );
}
