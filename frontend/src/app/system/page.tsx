import type { Metadata } from "next";
import {
  Activity, AudioWaveform, BrainCircuit, Cable, Check, Cpu, Filter, Gauge, MoveDown, Ruler, ShieldAlert, Spline, Workflow,
} from "lucide-react";
import { Card, CardHeader, Kbd, cx } from "@/components/ui";
import { API_URL } from "@/lib/api";

export const metadata: Metadata = { title: "System" };

const CHAIN = [
  { icon: AudioWaveform, name: "ADC", sub: "200 Hz, 10-bit" },
  { icon: Filter, name: "4-tap moving avg.", sub: "nulls at 50 & 100 Hz" },
  { icon: MoveDown, name: "IIR high-pass", sub: "~0.12 Hz, baseline wander" },
  { icon: Activity, name: "R-peak detector", sub: "3/5 envelope · 250 ms refractory" },
  { icon: Ruler, name: "P / Q / R / S", sub: "vs. local TP isoelectric line" },
  { icon: Cable, name: "USB serial", sub: "115200 baud · B, D lines" },
  { icon: BrainCircuit, name: "Random Forest", sub: "200 trees on (P, Q, R) · SNN next", hl: true },
];

const SPECS = [
  { icon: Gauge, title: "Sampling · 200 Hz", body: <>Covers QRS detection and rate, and was chosen together with the 4-tap average so its spectral zeros land exactly on 50 Hz mains and its 100 Hz harmonic.</> },
  { icon: Spline, title: "Baseline removal", body: <><code className="font-mono text-[12px] text-fg">baseAcc += maSum − (baseAcc &gt;&gt; 8)</code> tracks a 1.3 s running mean. Subtracting it removes electrode offset and breathing drift but keeps the P wave.</> },
  { icon: Activity, title: "R-peak detection", body: <>Idle → rising → wait state machine. The threshold is 3/5 of a decaying peak envelope, and a 250 ms refractory period means a T wave is never counted (240 bpm ceiling).</> },
  { icon: ShieldAlert, title: "Lead-off watchdog", body: <>When more than 10% of the samples in a 1 s window are railed, the device shows <code className="font-mono text-[12px] text-fg">LEAD OFF - CHECK</code> rather than reporting a fake 200 bpm.</> },
  { icon: Workflow, title: "On-device screen", body: <>2-of-3 thresholds (P &gt; 0.28, Q &lt; −0.33, R &gt; 1.05 mV) plus brady &lt; 50 / tachy &gt; 120 bpm. The buzzer alarms only after 3 consecutive abnormal beats.</> },
  { icon: Cpu, title: "Calibration", body: <>5000 mV ÷ 1024 counts ÷ gain 1000 = 0.004883 mV/count. Press <Kbd>c</Kbd> on a clean beat and the firmware solves for the gain that makes R read 1.00 mV.</> },
];

const PROTOCOL = [
  ["D,<q4>", "Filtered waveform sample, 100 Hz (× 0.00122 mV)"],
  ["B,ms,bpm,P,Q,R,S,result", "One detected beat, features in mV"],
  ["A,a0..a5", "Analog-pin finder scan (d)"],
  ["# …", "Status: mode, calibration, stream, help"],
];

const ROADMAP: [string, boolean][] = [
  ["Acquisition & feature front end", true],
  ["Host classifier + web dashboard", true],
  ["Real annotated dataset (MIT-BIH / PTB-XL)", false],
  ["Spike-encode features, train the SNN", false],
  ["Port inference to the device", false],
];

export default function SystemPage() {
  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader title="Signal chain" icon={<Workflow size={18} />} sub="ATmega328P firmware → USB serial → host classifier" />
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
          {CHAIN.map(({ icon: Icon, name, sub, hl }, i) => (
            <li
              key={name}
              className={cx(
                "relative rounded-xl border p-4",
                hl ? "border-accent/50 bg-accent/10" : "border-line bg-panel-2",
              )}
            >
              <div className="flex items-center justify-between">
                <Icon size={18} className={hl ? "text-accent" : "text-muted"} />
                <span className="font-mono text-[11px] text-faint">{String(i + 1).padStart(2, "0")}</span>
              </div>
              <div className="mt-3 text-[13.5px] font-semibold">{name}</div>
              <div className="mt-0.5 text-xs text-muted">{sub}</div>
            </li>
          ))}
        </ol>
      </Card>

      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {SPECS.map(({ icon: Icon, title, body }) => (
          <Card key={title}>
            <div className="flex items-center gap-3">
              <span className="grid size-9 place-items-center rounded-xl bg-accent/10 text-accent"><Icon size={18} /></span>
              <h3 className="text-[14.5px] font-semibold">{title}</h3>
            </div>
            <p className="mt-3 text-[13px] leading-relaxed text-muted">{body}</p>
          </Card>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Serial protocol" icon={<Cable size={18} />} sub="What the sketch prints at 115200 baud" />
          <div className="overflow-hidden rounded-xl border border-line">
            <table className="w-full text-left text-[13px]">
              <thead className="bg-panel-2 text-[11px] uppercase tracking-wider text-muted">
                <tr><th className="px-3 py-2.5 font-semibold">Line</th><th className="px-3 py-2.5 font-semibold">Meaning</th></tr>
              </thead>
              <tbody>
                {PROTOCOL.map(([l, m]) => (
                  <tr key={l} className="border-t border-line">
                    <td className="px-3 py-2.5 font-mono text-[12.5px] text-accent">{l}</td>
                    <td className="px-3 py-2.5 text-muted">{m}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card>
          <CardHeader title="Limitations & roadmap" icon={<ShieldAlert size={18} />} sub="Said up front, before anyone asks" />
          <ul className="space-y-2 text-[13px] text-muted">
            <li><b className="text-fg">Synthetic training data.</b> 100 separable rows, so accuracy isn&apos;t meaningful yet.</li>
            <li><b className="text-fg">Single lead, three electrodes.</b> Rate and gross morphology only, not a 12-lead diagnosis.</li>
            <li><b className="text-fg">Not a medical device.</b> No isolation barrier or certification. It is a research prototype.</li>
          </ul>
          <ol className="mt-5 space-y-2.5">
            {ROADMAP.map(([step, done], i) => (
              <li key={step} className={cx("flex items-center gap-3 text-[13px]", done ? "text-fg" : "text-muted")}>
                <span className={cx(
                  "grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-bold",
                  done ? "bg-ok/15 text-ok" : "border border-line-strong text-faint",
                )}>
                  {done ? <Check size={13} strokeWidth={3} /> : i + 1}
                </span>
                {step}
              </li>
            ))}
          </ol>
        </Card>
      </div>

      <Card>
        <details className="group">
          <summary className="cursor-pointer list-none text-[15px] font-semibold">
            <span className="mr-2 inline-block text-muted transition group-open:rotate-90">›</span>Firmware flowchart
          </summary>
          {/* served by the Python backend from docs/ */}
          <img
            src={`${API_URL}/docs/flow.png`}
            alt="NeuroCardio firmware flowchart"
            loading="lazy"
            className="mx-auto mt-4 max-w-full rounded-xl bg-white"
          />
        </details>
      </Card>
    </div>
  );
}
