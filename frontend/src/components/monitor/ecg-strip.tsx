"use client";

import { useEffect, useRef, useState } from "react";
import { HeartPulse, Pause, Play } from "lucide-react";
import { FS, N, SECONDS, wave } from "@/lib/wave-store";
import { useLive } from "../live-provider";
import { Button, Card, CardHeader, Segmented } from "../ui";

type Palette = Record<"trace" | "minor" | "major" | "ok" | "danger" | "faint" | "glow", string>;

function readPalette(): Palette {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return {
    trace: v("--trace"), minor: v("--grid-minor"), major: v("--grid-major"),
    ok: v("--ok"), danger: v("--danger"), faint: v("--faint"), glow: v("--glow"),
  };
}

const GAP = 22; // erased samples ahead of the sweep head

export function EcgStrip() {
  const { status, online } = useLive();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<"sweep" | "scroll">("sweep");
  const [frozen, setFrozen] = useState(false);
  const [overlay, setOverlay] = useState<string | null>("Waiting for signal…");
  const modeRef = useRef(mode);
  const frozenRef = useRef(frozen);
  const statusRef = useRef(status);
  const onlineRef = useRef(online);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { frozenRef.current = frozen; }, [frozen]);
  useEffect(() => { statusRef.current = status; onlineRef.current = online; }, [status, online]);

  useEffect(() => {
    let pal = readPalette();
    const onTheme = () => { pal = readPalette(); };
    window.addEventListener("nc-theme", onTheme);
    let raf = 0, lastT = 0, carry = 0, yMin = -0.6, yMax = 1.6, lastOverlay: string | null = "";

    const tick = (ts: number) => {
      const dt = lastT ? (ts - lastT) / 1000 : 0;
      lastT = ts;
      if (!frozenRef.current && wave.pending.length) {
        const n = dt * FS + carry;
        let take = Math.floor(n);
        carry = n - take;
        if (wave.pending.length > 30) take += Math.ceil((wave.pending.length - 20) / 10); // catch up on lag
        if (dt > 0.5) take = wave.pending.length;
        wave.advance(Math.min(take, wave.pending.length));
      } else if (!wave.pending.length) carry = 0;

      draw();

      const st = statusRef.current;
      const stale = performance.now() - wave.lastSampleAt > 2500;
      let ov: string | null = null;
      if (onlineRef.current === false) ov = "Backend offline";
      else if (onlineRef.current === null) ov = "Connecting to the backend…";
      else if (st?.error) ov = st.error;
      else if (stale) {
        ov = st?.source === "live" && !st.connected ? "Connecting to the Arduino…"
          : st?.source === "live" && !st.stream_on ? "Connected - waveform streaming is off (press Stream)"
            : "Waiting for signal…";
      }
      if (ov !== lastOverlay) { lastOverlay = ov; setOverlay(ov); }
      raf = requestAnimationFrame(tick);
    };

    const draw = () => {
      const c = canvas.current;
      if (!c || !c.clientWidth) return;
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth, h = c.clientHeight;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
      }
      const ctx = c.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const total = wave.total, buf = wave.buf, sweep = modeRef.current === "sweep";

      // eased autoscale with headroom for the R markers
      let lo = Infinity, hi = -Infinity;
      for (const v of buf) if (!Number.isNaN(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
      if (lo === Infinity) { lo = -0.5; hi = 1.2; }
      const span = Math.max(1.4, hi - lo), mid = (hi + lo) / 2;
      yMin += (mid - span * 0.62 - yMin) * 0.06;
      yMax += (mid + span * 0.74 - yMax) * 0.06;
      const Y = (v: number) => (1 - (v - yMin) / (yMax - yMin)) * h;
      const pxPerS = w / SECONDS;

      // ECG paper: 0.04 s / 0.1 mV minor, 0.2 s / 0.5 mV major
      const grid = (dt: number, dv: number, color: string) => {
        ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath();
        for (let t = 0; t <= SECONDS + 1e-6; t += dt) { const x = Math.round(t * pxPerS) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, h); }
        for (let v = Math.ceil(yMin / dv) * dv; v <= yMax; v += dv) { const y = Math.round(Y(v)) + 0.5; ctx.moveTo(0, y); ctx.lineTo(w, y); }
        ctx.stroke();
      };
      if (pxPerS * 0.04 > 3.5) grid(0.04, 0.1, pal.minor);
      grid(0.2, 0.5, pal.major);

      ctx.font = "10.5px ui-monospace, Consolas, monospace"; // canvas fonts cannot use CSS vars
      ctx.fillStyle = pal.faint; ctx.textBaseline = "bottom"; ctx.textAlign = "left";
      for (let v = Math.ceil(yMin / 0.5) * 0.5; v <= yMax; v += 0.5) {
        const y = Y(v);
        if (y > 14 && y < h - 4) ctx.fillText(`${v.toFixed(1)} mV`, 6, y - 2);
      }

      const xOf = sweep ? (abs: number) => ((abs % N) / N) * w : (abs: number) => ((abs - (total - N)) / (N - 1)) * w;

      ctx.strokeStyle = pal.trace; ctx.lineWidth = 1.8; ctx.lineJoin = "round"; ctx.lineCap = "round";
      if (pal.glow && pal.glow !== "transparent") { ctx.shadowColor = pal.glow; ctx.shadowBlur = 8; }
      ctx.beginPath();
      if (sweep) {
        const head = total % N;
        let pen = false;
        for (let i = 0; i < N; i++) {
          const ahead = (i - head + N) % N, v = buf[i];
          if ((total >= N && ahead < GAP) || (total < N && i >= head) || Number.isNaN(v)) { pen = false; continue; }
          const x = (i / N) * w, y = Y(v);
          if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y);
          pen = true;
        }
      } else {
        let pen = false;
        for (let k = Math.max(0, total - N); k < total; k++) {
          const v = buf[k % N];
          if (Number.isNaN(v)) { pen = false; continue; }
          if (pen) ctx.lineTo(xOf(k), Y(v)); else ctx.moveTo(xOf(k), Y(v));
          pen = true;
        }
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      if (total > 0) {
        const v = buf[(total - 1) % N];
        if (!Number.isNaN(v)) {
          ctx.fillStyle = pal.trace;
          ctx.beginPath(); ctx.arc(xOf(total - 1), Y(v), 3.4, 0, Math.PI * 2); ctx.fill();
        }
      }

      ctx.font = "600 11px system-ui, sans-serif";
      ctx.textAlign = "center";
      const oldest = total - N + (sweep ? GAP : 0);
      for (const m of wave.markers) {
        if (m.abs >= total || m.abs < oldest) continue;
        const v = buf[m.abs % N];
        if (Number.isNaN(v)) continue;
        const x = xOf(m.abs), y = Math.max(20, Y(v) - 8);
        ctx.fillStyle = m.abn ? pal.danger : pal.ok;
        ctx.beginPath(); ctx.moveTo(x - 4.5, y - 6); ctx.lineTo(x + 4.5, y - 6); ctx.lineTo(x, y); ctx.closePath(); ctx.fill();
        if (m.bpm) ctx.fillText(String(m.bpm), x, y - 8);
      }
    };

    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("nc-theme", onTheme); };
  }, []);

  return (
    <Card>
      <CardHeader
        title="ECG strip"
        icon={<HeartPulse size={18} />}
        sub="Single lead · filtered on-device · 100 Hz stream · 25 mm/s grid (0.2 s × 0.5 mV major)"
      >
        <span className="hidden items-center gap-1.5 text-xs text-muted sm:inline-flex"><i className="size-2.5 rounded-sm bg-ok" />normal R</span>
        <span className="hidden items-center gap-1.5 text-xs text-muted sm:inline-flex"><i className="size-2.5 rounded-sm bg-danger" />abnormal R</span>
        <Segmented value={mode} onChange={setMode} options={[{ value: "sweep", label: "Sweep" }, { value: "scroll", label: "Scroll" }]} />
        <Button variant={frozen ? "primary" : "default"} onClick={() => {
          if (frozen) wave.pending.splice(0, Math.max(0, wave.pending.length - 10));
          setFrozen(!frozen);
        }}>
          {frozen ? <Play size={14} /> : <Pause size={14} />} {frozen ? "Resume" : "Freeze"}
        </Button>
      </CardHeader>
      <div className="relative overflow-hidden rounded-xl border border-line bg-[var(--ecg-bg)]">
        <canvas ref={canvas} className="block h-[230px] w-full sm:h-[310px]" />
        {overlay && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center p-6 text-center text-sm text-muted">
            {overlay}
          </div>
        )}
        <span className="pointer-events-none absolute bottom-2 right-3 font-mono text-[10.5px] text-faint">
          {mode} · {SECONDS} s
        </span>
      </div>
    </Card>
  );
}
