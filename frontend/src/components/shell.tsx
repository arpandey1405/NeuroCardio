"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { Activity, AlertTriangle, Cpu, FlaskConical, FolderClock, Moon, Sun, Usb, Waves } from "lucide-react";
import { useLive } from "./live-provider";
import { cx } from "./ui";

const NAV = [
  { href: "/", label: "Live monitor", icon: Activity, sub: "Real-time ECG, verdicts and device control" },
  { href: "/sessions", label: "Sessions", icon: FolderClock, sub: "Review recorded session CSVs" },
  { href: "/lab", label: "Classifier lab", icon: FlaskConical, sub: "Probe the Random Forest with your own P, Q, R" },
  { href: "/system", label: "System", icon: Cpu, sub: "Signal chain, firmware and protocol" },
];

function Logo() {
  const id = useId(); // two logos render (sidebar + mobile); gradient ids must differ
  return (
    <svg viewBox="0 0 32 32" className="size-9 shrink-0" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#ff7a8a" />
          <stop offset="1" stopColor="#e3264a" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${id})`} />
      <path d="M5 17h5.5l2-4.5 3 9 3.2-12 2.3 7.5H27" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState<boolean | null>(null);
  useEffect(() => setDark(document.documentElement.classList.contains("dark")), []);
  const toggle = () => {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    try { localStorage.setItem("nc-theme", next ? "dark" : "light"); } catch { /* private mode */ }
    setDark(next);
    window.dispatchEvent(new Event("nc-theme"));
  };
  return (
    <button
      onClick={toggle}
      title="Toggle light / dark"
      className="grid size-9 place-items-center rounded-xl border border-line bg-panel-2 text-muted transition hover:text-fg"
    >
      {dark === false ? <Moon size={17} /> : <Sun size={17} />}
    </button>
  );
}

function SourcePill() {
  const { online, status } = useLive();
  let text = "Connecting…", tone = "idle";
  if (online === false) { text = "Backend offline"; tone = "err"; }
  else if (status?.source === "live") {
    text = status.error ? "Arduino · error" : status.connected ? `Arduino · ${status.port}` : "Arduino · connecting";
    tone = status.error ? "err" : status.connected ? "on" : "idle";
  } else if (status?.source === "replay") {
    text = status.error ? "Replay · error" : `MIT-BIH replay · ${status.replay?.record ?? "…"}`;
    tone = status.error ? "err" : "on";
  } else if (status) { text = "Synthetic demo"; tone = "on"; }
  return (
    <span className="inline-flex max-w-64 items-center gap-2 truncate rounded-full border border-line bg-panel-2 px-3 py-1.5 text-[12.5px] font-medium">
      <span className="relative flex size-2.5 shrink-0">
        {tone === "on" && <span className="absolute inset-0 animate-ping rounded-full bg-ok opacity-60" />}
        <span className={cx("relative size-2.5 rounded-full", tone === "on" ? "bg-ok" : tone === "err" ? "bg-danger" : "bg-faint")} />
      </span>
      {status?.source === "live" ? <Usb size={14} className="text-muted" /> : <Waves size={14} className="text-muted" />}
      <span className="truncate">{text}</span>
    </span>
  );
}

function RecordButton() {
  const { status, setRecording } = useLive();
  const on = !!status?.recording;
  return (
    <button
      onClick={() => setRecording(!on)}
      disabled={!status}
      title={on ? `Recording to ${status?.recording} - click to stop` : "Record beats to a session CSV"}
      className={cx(
        "inline-flex items-center gap-2 rounded-xl border px-3 py-1.5 text-[13px] font-medium transition disabled:opacity-50",
        on ? "border-danger bg-danger/12 text-danger" : "border-line-strong bg-panel-2 hover:border-danger",
      )}
    >
      <span className={cx("size-2.5 rounded-full", on ? "animate-pulse bg-danger" : "bg-faint")} />
      {on ? "Recording" : "Record"}
    </button>
  );
}

function AlarmBanner() {
  const { status } = useLive();
  if (!status?.alarm) return null;
  return (
    <div className="animate-alarm mb-5 flex flex-wrap items-center gap-3 rounded-2xl border border-danger bg-danger/10 px-4 py-3 text-danger">
      <AlertTriangle size={20} />
      <strong className="font-semibold">Abnormal rhythm confirmed</strong>
      <span className="text-fg">3 or more consecutive beats classified abnormal.</span>
      <span className="ml-auto text-xs text-muted">
        {status.source === "live" ? "Source: Arduino" : "Source: synthetic demo (not patient data)"}
      </span>
    </div>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const current = NAV.find((n) => (n.href === "/" ? path === "/" : path.startsWith(n.href))) ?? NAV[0];
  const { status, online } = useLive();

  return (
    <div className="flex min-h-screen">
      {/* sidebar */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-line bg-panel/70 px-4 py-5 backdrop-blur lg:flex">
        <div className="flex items-center gap-3 px-2">
          <Logo />
          <div>
            <div className="text-[16px] font-bold tracking-tight">NeuroCardio</div>
            <div className="text-[11.5px] text-muted">ECG monitor · Review 1</div>
          </div>
        </div>
        <nav className="mt-8 flex flex-col gap-1">
          <div className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">Dashboard</div>
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = current.href === href;
            return (
              <Link
                key={href}
                href={href}
                className={cx(
                  "group flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13.5px] font-medium transition",
                  active ? "bg-accent/12 text-fg ring-1 ring-accent/30" : "text-muted hover:bg-panel-2 hover:text-fg",
                )}
              >
                <Icon size={18} className={active ? "text-accent" : "text-faint group-hover:text-muted"} />
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto rounded-2xl border border-line bg-panel-2 p-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-faint">Device</div>
          <dl className="mt-3 space-y-2 text-[12.5px]">
            <div className="flex justify-between gap-2"><dt className="text-muted">Backend</dt><dd className={online ? "text-ok" : online === false ? "text-danger" : "text-muted"}>{online ? "online" : online === false ? "offline" : "connecting"}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-muted">Source</dt><dd>{status ? (status.source === "live" ? status.port ?? "auto" : status.source === "replay" ? `MIT-BIH ${status.replay?.record ?? ""}` : "synthetic") : "--"}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-muted">Mode</dt><dd>{status?.source === "live" ? status.dev_mode : status?.source === "replay" ? "replay" : status ? "demo" : "--"}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-muted">Model</dt><dd className={status?.model_ready === false ? "text-warn" : ""}>{status ? (!status.model_ready ? "not loaded" : status.model_kind === "snn" ? (status.snn_trained ? "SNN · trained" : "SNN preview") : "RF · ready") : "--"}</dd></div>
          </dl>
        </div>
        <p className="mt-3 px-2 text-[11px] leading-relaxed text-faint">Research prototype · not a medical device</p>
      </aside>

      {/* main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 border-b border-line bg-bg/75 backdrop-blur-xl">
          <div className="flex items-center gap-4 px-4 py-3 sm:px-6">
            <div className="flex items-center gap-3 lg:hidden"><Logo /></div>
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold tracking-tight">{current.label}</h1>
              <p className="hidden truncate text-[12.5px] text-muted sm:block">{current.sub}</p>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <div className="hidden md:block"><SourcePill /></div>
              <RecordButton />
              <ThemeToggle />
            </div>
          </div>
          {/* mobile nav */}
          <nav className="scroll-thin flex gap-1 overflow-x-auto px-4 pb-2 lg:hidden">
            {NAV.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className={cx(
                  "flex shrink-0 items-center gap-2 rounded-xl px-3 py-1.5 text-[13px] font-medium",
                  current.href === href ? "bg-accent/12 text-fg" : "text-muted",
                )}
              >
                <Icon size={15} /> {label}
              </Link>
            ))}
          </nav>
        </header>

        <main className="mx-auto w-full max-w-[1500px] flex-1 px-4 py-6 sm:px-6">
          {online === false && (
            <div className="mb-5 rounded-2xl border border-warn/40 bg-warn/10 px-4 py-3 text-[13px]">
              <b className="text-warn">Can&apos;t reach the NeuroCardio backend.</b>{" "}
              <span className="text-muted">
                Start it with <code className="rounded bg-panel-2 px-1.5 py-0.5 font-mono text-fg">python host/dashboard.py --no-browser</code> - this page reconnects on its own.
              </span>
            </div>
          )}
          <AlarmBanner />
          {children}
        </main>
      </div>
    </div>
  );
}
