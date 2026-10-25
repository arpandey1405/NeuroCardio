import type { Tone } from "@/lib/format";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

export function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <section
      className={cx(
        "min-w-0 rounded-2xl border border-line bg-panel/85 p-5 shadow-[0_1px_0_rgba(255,255,255,0.03)_inset,0_10px_30px_-12px_rgba(0,0,0,0.25)] backdrop-blur",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  title, sub, icon, children,
}: { title: string; sub?: React.ReactNode; icon?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-3">
        {icon && (
          <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-line bg-panel-2 text-muted">
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
          {sub && <p className="mt-0.5 text-[12.5px] text-muted">{sub}</p>}
        </div>
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

const toneCls: Record<Tone, string> = {
  neutral: "bg-panel-2 text-muted border-line",
  ok: "bg-ok/12 text-ok border-transparent",
  danger: "bg-danger/12 text-danger border-transparent",
  warn: "bg-warn/12 text-warn border-transparent",
  info: "bg-accent/12 text-accent border-transparent",
};

export function Chip({ tone = "neutral", children, className, title }: {
  tone?: Tone; children: React.ReactNode; className?: string; title?: string;
}) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11.5px] font-semibold",
        toneCls[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

type BtnVariant = "default" | "primary" | "ghost" | "danger";
const btnCls: Record<BtnVariant, string> = {
  default: "border-line-strong bg-panel-2 hover:border-accent",
  primary: "border-accent bg-accent text-white hover:brightness-110 dark:text-[#04121f]",
  ghost: "border-transparent bg-transparent text-muted hover:bg-panel-2 hover:text-fg",
  danger: "border-line-strong bg-panel-2 hover:border-danger hover:text-danger",
};

export function Button({
  variant = "default", className, children, ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant }) {
  return (
    <button
      {...rest}
      className={cx(
        "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl border px-3 py-1.5 text-[13px] font-medium transition active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50",
        btnCls[variant],
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Segmented<T extends string>({
  value, options, onChange, full,
}: { value: T; options: { value: T; label: React.ReactNode }[]; onChange: (v: T) => void; full?: boolean }) {
  return (
    <div className={cx("inline-flex rounded-xl border border-line bg-panel-2 p-0.5", full && "flex w-full")}>
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            "whitespace-nowrap rounded-[10px] px-3 py-1 text-[12.5px] font-medium transition",
            full && "flex-1 py-1.5",
            o.value === value ? "bg-panel text-fg shadow-sm ring-1 ring-line" : "text-muted hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded-md border border-b-2 border-line-strong bg-panel px-1.5 font-mono text-[11px] text-muted">
      {children}
    </kbd>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: "ok" | "danger" }) {
  return (
    <div className="rounded-xl border border-line bg-panel-2 px-3.5 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className={cx("mt-1 text-2xl font-semibold tabular-nums tracking-tight", tone === "ok" && "text-ok", tone === "danger" && "text-danger")}>
        {value}
      </div>
      {hint && <div className="mt-0.5 text-[11.5px] text-faint">{hint}</div>}
    </div>
  );
}
