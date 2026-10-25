"use client";

import { useCallback, useEffect, useState } from "react";
import { Cable, RefreshCw, SlidersHorizontal, Volume2, VolumeX } from "lucide-react";
import { apiGet } from "@/lib/api";
import { useLive } from "../live-provider";
import { Button, Card, CardHeader, Chip, Kbd, Segmented } from "../ui";

const LIVE_CMDS = [
  { cmd: "t", label: "Test signal", title: "Cycle LIVE / SIM-NORMAL / SIM-ABNORMAL" },
  { cmd: "c", label: "Calibrate", title: "Calibrate gain on the next clean beat", primary: true },
  { cmd: "s", label: "Stream", title: "Toggle waveform streaming" },
  { cmd: "b", label: "Beep", title: "Toggle the per-beat beep" },
  { cmd: "d", label: "Pin finder", title: "Analog pin finder" },
  { cmd: "h", label: "Debug", title: "Human-readable debug line" },
  { cmd: "r", label: "Reset", title: "Reset detector and calibration", danger: true },
];

type Port = { device: string; description: string };

export function Controls() {
  const { status, send, setSource, setModelKind, sound, setSound } = useLive();
  const [picked, setPicked] = useState<"synthetic" | "live" | null>(null);
  const [ports, setPorts] = useState<Port[]>([]);
  const [pyserial, setPyserial] = useState(true);
  const [port, setPort] = useState("");
  const [modelErr, setModelErr] = useState<string | null>(null);
  const shown = picked ?? status?.source ?? "synthetic";
  const live = status?.source === "live";

  const loadPorts = useCallback(async () => {
    try {
      const r = await apiGet<{ ports: Port[]; pyserial: boolean }>("/api/ports");
      setPorts(r.ports);
      setPyserial(r.pyserial);
    } catch { /* backend offline */ }
  }, []);

  useEffect(() => { if (shown === "live") loadPorts(); }, [shown, loadPorts]);

  // same single-letter shortcuts as host_monitor.py
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.ctrlKey || e.metaKey || e.altKey || /INPUT|SELECT|TEXTAREA/.test(el.tagName) || !status) return;
      const k = e.key.toLowerCase();
      const allowed = status.source === "live" ? "tscbrdh" : "nax";
      if (k.length === 1 && allowed.includes(k)) send(k);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [status, send]);

  const synValue = !status ? "x" : status.auto ? "x" : status.scenario === "NORMAL" ? "n" : "a";

  return (
    <Card>
      <CardHeader title="Controls" icon={<SlidersHorizontal size={18} />} sub="Signal source and device commands" />

      <div className="space-y-4">
        <div>
          <div className="mb-1.5 text-xs font-medium text-muted">Model</div>
          <Segmented
            full
            value={status?.model_kind ?? "rf"}
            onChange={async (k) => setModelErr(await setModelKind(k))}
            options={[{ value: "rf", label: "Random Forest" }, { value: "snn-preview", label: "SNN" }]}
          />
          {modelErr && (
            <p className="mt-1.5 rounded-lg border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-[12px] text-warn">{modelErr}</p>
          )}
          {status?.model_kind === "snn-preview" && (
            <p className="mt-1.5 text-[11.5px] text-faint">SNN preview: spiking activity shown, verdicts from the Random Forest until the trained SNN is loaded.</p>
          )}
        </div>

        <div>
          <div className="mb-1.5 text-xs font-medium text-muted">Source</div>
          <Segmented
            full
            value={shown}
            onChange={async (v) => {
              if (v === "synthetic") {
                setPicked(null);
                if (status?.source !== "synthetic") await setSource("synthetic");
              } else setPicked("live");
            }}
            options={[{ value: "synthetic", label: "Synthetic demo" }, { value: "live", label: "Arduino (serial)" }]}
          />
        </div>

        {shown === "live" && (
          <div>
            <div className="mb-1.5 text-xs font-medium text-muted">Serial port</div>
            <div className="flex gap-2">
              <select
                value={port}
                onChange={(e) => setPort(e.target.value)}
                className="min-w-0 flex-1 rounded-xl border border-line-strong bg-panel-2 px-3 py-1.5 text-[13px]"
              >
                <option value="">{pyserial ? "Auto-detect" : "pyserial not installed"}</option>
                {ports.map((p) => <option key={p.device} value={p.device}>{p.device} - {p.description}</option>)}
                {pyserial && ports.length === 0 && <option disabled>No ports found - is the board plugged in?</option>}
              </select>
              <button onClick={loadPorts} title="Refresh ports" className="grid size-9 shrink-0 place-items-center rounded-xl border border-line bg-panel-2 text-muted hover:text-fg">
                <RefreshCw size={15} />
              </button>
              <Button variant="primary" onClick={async () => { setPicked(null); await setSource("live", port); }}>
                <Cable size={15} /> {live && status?.connected ? "Reconnect" : "Connect"}
              </Button>
            </div>
          </div>
        )}

        {!live && (
          <div>
            <div className="mb-1.5 text-xs font-medium text-muted">Synthetic scenario <Kbd>x</Kbd> <Kbd>n</Kbd> <Kbd>a</Kbd></div>
            <Segmented
              full
              value={synValue}
              onChange={(v) => send(v)}
              options={[{ value: "x", label: "Auto episodes" }, { value: "n", label: "Normal" }, { value: "a", label: "Abnormal" }]}
            />
          </div>
        )}

        {live && (
          <div>
            <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-muted">
              Device commands
              <Chip tone={status?.dev_mode === "LIVE" ? "info" : "warn"}>{status?.dev_mode}</Chip>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-2 2xl:grid-cols-3">
              {LIVE_CMDS.map((c) => (
                <Button
                  key={c.cmd}
                  title={c.title}
                  variant={c.primary ? "primary" : c.danger ? "danger" : "default"}
                  disabled={!status?.connected}
                  onClick={() => send(c.cmd)}
                  className="justify-between"
                >
                  {c.label} <Kbd>{c.cmd}</Kbd>
                </Button>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between border-t border-line pt-4">
          <Button variant={sound ? "primary" : "default"} onClick={() => setSound(!sound)}>
            {sound ? <Volume2 size={15} /> : <VolumeX size={15} />} Sound alarm {sound ? "on" : "off"}
          </Button>
          <Button variant="ghost" onClick={() => send("clear")}>Clear counters</Button>
        </div>
      </div>
    </Card>
  );
}
