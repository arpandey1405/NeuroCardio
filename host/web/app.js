/* NeuroCardio dashboard - front end. No build step, no external libraries. */
"use strict";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const isAbn = (s) => String(s || "").toUpperCase().startsWith("ABNORM");
const signed = (v, d = 3) => (v == null || isNaN(v) ? "--" : (v >= 0 ? "+" : "") + Number(v).toFixed(d));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

async function api(path, body) {
  const opts = body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  };
  const r = await fetch(path, opts);
  return r.json();
}

// device screening thresholds from the sketch (TH_*_ABN, BPM_BRADY/TACHY)
const DEVICE_TH = { P: 0.28, Q: -0.33, R: 1.05 };
const BPM_BRADY = 50, BPM_TACHY = 120;
const SERIES = { P: "#a78bfa", Q: "#f5a524", R: null /* accent */, S: "#f472b6" };

/* ================================================================ theme */
let PAL = {};
function readPalette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  PAL = {
    trace: v("--trace"), gridMinor: v("--grid-minor"), gridMajor: v("--grid-major"),
    ok: v("--ok"), danger: v("--danger"), warn: v("--warn"), accent: v("--accent"),
    muted: v("--muted"), faint: v("--faint"), border: v("--border"), text: v("--text"),
    panel2: v("--panel-2"), okSoft: v("--ok-soft"), dangerSoft: v("--danger-soft"),
    dark: document.documentElement.dataset.theme !== "light",
  };
  SERIES.R = PAL.accent;
}
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  store.set("nc-theme", t);
  readPalette();
  redrawAll();
}
$("#theme-btn").onclick = () =>
  applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");

/* ================================================================ canvas helpers */
function fitCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const ctx = c.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function niceTicks(lo, hi, count = 5) {
  const span = hi - lo || 1;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) || 10 * mag;
  const ticks = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) ticks.push(+t.toFixed(6));
  return ticks;
}

/**
 * Small line / scatter chart.
 * opts: { series:[{data:[[x,y]], color, label, points?, pointColor?(i), line?}],
 *         yMin, yMax, yFmt, xFmt, bands:[{y0,y1,color}], empty, legend, xLabel, yLabel }
 */
function drawChart(c, o) {
  if (!c.clientWidth) return;
  const { ctx, w, h } = fitCanvas(c);
  const pad = { l: 44, r: 14, t: o.legend ? 24 : 12, b: o.xLabel ? 34 : 24 };
  const all = o.series.flatMap((s) => s.data);
  ctx.font = "11px system-ui, sans-serif";
  if (!all.length) {
    ctx.fillStyle = PAL.muted; ctx.textAlign = "center";
    ctx.fillText(o.empty || "No data yet", w / 2, h / 2);
    return;
  }
  let x0 = Math.min(...all.map((d) => d[0])), x1 = Math.max(...all.map((d) => d[0]));
  if (x0 === x1) { x0 -= 1; x1 += 1; }
  let y0 = o.yMin ?? Math.min(...all.map((d) => d[1]));
  let y1 = o.yMax ?? Math.max(...all.map((d) => d[1]));
  if (o.yMin == null || o.yMax == null) {
    const p = (y1 - y0 || 1) * 0.12;
    if (o.yMin == null) y0 -= p;
    if (o.yMax == null) y1 += p;
  }
  const X = (x) => pad.l + ((x - x0) / (x1 - x0)) * (w - pad.l - pad.r);
  const Y = (y) => pad.t + (1 - (y - y0) / (y1 - y0)) * (h - pad.t - pad.b);

  for (const b of o.bands || []) {
    ctx.fillStyle = b.color;
    const ya = Y(clamp(b.y1, y0, y1)), yb = Y(clamp(b.y0, y0, y1));
    ctx.fillRect(pad.l, ya, w - pad.l - pad.r, yb - ya);
  }
  ctx.strokeStyle = PAL.border; ctx.lineWidth = 1;
  ctx.fillStyle = PAL.muted; ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (const t of niceTicks(y0, y1, 5)) {
    const y = Math.round(Y(t)) + 0.5;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillText(o.yFmt ? o.yFmt(t) : t, pad.l - 6, y);
  }
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  for (const t of niceTicks(x0, x1, Math.max(3, Math.floor((w - pad.l) / 80)))) {
    ctx.fillText(o.xFmt ? o.xFmt(t) : t, X(t), h - pad.b + 6);
  }
  if (o.xLabel) { ctx.fillStyle = PAL.faint; ctx.fillText(o.xLabel, (pad.l + w - pad.r) / 2, h - 14); }
  if (o.yLabel) {
    ctx.save(); ctx.translate(11, (pad.t + h - pad.b) / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = PAL.faint; ctx.textBaseline = "middle"; ctx.fillText(o.yLabel, 0, 0); ctx.restore();
  }

  for (const s of o.series) {
    if (s.line !== false && s.data.length > 1) {
      ctx.strokeStyle = s.color; ctx.lineWidth = 1.6; ctx.lineJoin = "round";
      ctx.beginPath();
      s.data.forEach((d, i) => (i ? ctx.lineTo(X(d[0]), Y(d[1])) : ctx.moveTo(X(d[0]), Y(d[1]))));
      ctx.stroke();
    }
    if (s.points) {
      s.data.forEach((d, i) => {
        ctx.fillStyle = s.pointColor ? s.pointColor(i) : s.color;
        ctx.beginPath(); ctx.arc(X(d[0]), Y(d[1]), s.r || 2.6, 0, Math.PI * 2); ctx.fill();
      });
    }
  }
  if (o.legend) {
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    let lx = w - pad.r;
    for (const s of [...o.series].reverse()) {
      if (!s.label) continue;
      const tw = ctx.measureText(s.label).width;
      lx -= tw + 22;
      ctx.fillStyle = s.color; ctx.fillRect(lx, 7, 10, 10);
      ctx.fillStyle = PAL.muted; ctx.fillText(s.label, lx + 14, 12);
    }
  }
  if (o.after) o.after(ctx, X, Y);
}

function drawSpark(c, vals, color) {
  if (!c.clientWidth) return;
  const { ctx, w, h } = fitCanvas(c);
  if (vals.length < 2) return;
  const lo = Math.min(...vals) - 2, hi = Math.max(...vals) + 2;
  const X = (i) => (i / (vals.length - 1)) * w;
  const Y = (v) => 3 + (1 - (v - lo) / (hi - lo)) * (h - 6);
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, color + "55"); g.addColorStop(1, color + "00");
  ctx.beginPath(); vals.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
}

/* ================================================================ state */
const S = {
  status: null,
  beats: [],
  counts: { n: 0, abn: 0 },
  model: null,
  lastSample: 0,
  alarmWas: false,
};

/* ================================================================ ECG strip */
const ECG = {
  fs: 100, seconds: 6, gap: 22,
  buf: null, total: 0, recvTotal: 0,
  pending: [], recent: [], markers: [],
  mode: store.get("nc-ecg-mode") || "sweep", frozen: false,
  yMin: -0.6, yMax: 1.6, lastT: 0, carry: 0,
};
ECG.N = ECG.fs * ECG.seconds;
ECG.buf = new Float32Array(ECG.N).fill(NaN);

function ecgReset() {
  ECG.buf.fill(NaN); ECG.total = 0; ECG.recvTotal = 0;
  ECG.pending = []; ECG.recent = []; ECG.markers = []; ECG.carry = 0;
}

function ecgReceive(samples) {
  for (const v of samples) {
    ECG.pending.push(v);
    ECG.recent.push([ECG.recvTotal++, v]);
  }
  if (ECG.recent.length > 60) ECG.recent.splice(0, ECG.recent.length - 60);
  if (ECG.pending.length > 3000) ECG.pending.splice(0, ECG.pending.length - ECG.N);
  S.lastSample = performance.now();
}

/** Instantly write samples into the strip (used to pre-fill on connect). */
function ecgPrefill(samples) {
  for (const v of samples.slice(-ECG.N)) {
    ECG.buf[ECG.total % ECG.N] = v; ECG.total++; ECG.recvTotal++;
  }
  if (samples.length) S.lastSample = performance.now();
}

function ecgMarkBeat(b) {
  // the R peak is the tallest of the most recently received samples
  let best = null;
  for (const [idx, v] of ECG.recent.slice(-40)) if (!best || v > best[1]) best = [idx, v];
  if (best) ECG.markers.push({ abs: best[0], abn: b.abnormal, bpm: b.bpm });
  if (ECG.markers.length > 40) ECG.markers.shift();
}

function ecgTick(ts) {
  const dt = ECG.lastT ? (ts - ECG.lastT) / 1000 : 0;
  ECG.lastT = ts;
  if (!ECG.frozen && ECG.pending.length) {
    const n = dt * ECG.fs + ECG.carry;
    let take = Math.floor(n);
    ECG.carry = n - take;
    if (ECG.pending.length > 30) take += Math.ceil((ECG.pending.length - 20) / 10); // catch up on lag
    if (dt > 0.5) take = ECG.pending.length;
    take = Math.min(take, ECG.pending.length);
    for (const v of ECG.pending.splice(0, take)) {
      ECG.buf[ECG.total % ECG.N] = v;
      ECG.total++;
    }
  } else if (!ECG.pending.length) {
    ECG.carry = 0;
  }
  drawECG();
  const stale = performance.now() - S.lastSample > 2500;
  const ov = $("#ecg-overlay");
  const err = S.status && S.status.error;
  ov.hidden = !stale && !err;
  if (!ov.hidden) {
    ov.textContent = err ? err
      : S.status && S.status.source === "live" && !S.status.stream_on && S.status.connected
        ? "Connected - waveform streaming is off (press Stream)"
        : S.status && S.status.source === "live" && !S.status.connected ? "Connecting to the Arduino…"
          : "Waiting for signal…";
  }
  requestAnimationFrame(ecgTick);
}

function drawECG() {
  const c = $("#ecg");
  if (!c.clientWidth) return;
  const { ctx, w, h } = fitCanvas(c);
  const N = ECG.N, total = ECG.total;

  // autoscale, eased so the trace doesn't jump
  let lo = Infinity, hi = -Infinity;
  for (const v of ECG.buf) if (!isNaN(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (lo === Infinity) { lo = -0.5; hi = 1.2; }
  const span = Math.max(1.4, hi - lo);
  const mid = (hi + lo) / 2;
  const tMin = mid - span * 0.62, tMax = mid + span * 0.72;  // headroom for R markers
  ECG.yMin += (tMin - ECG.yMin) * 0.06;
  ECG.yMax += (tMax - ECG.yMax) * 0.06;
  const Y = (v) => (1 - (v - ECG.yMin) / (ECG.yMax - ECG.yMin)) * h;
  const pxPerS = w / ECG.seconds;

  // ECG paper grid: 0.04 s / 0.1 mV minor, 0.2 s / 0.5 mV major
  const grid = (dt, dv, color, lw) => {
    ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.beginPath();
    for (let t = 0; t <= ECG.seconds + 1e-6; t += dt) { const x = Math.round(t * pxPerS) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    for (let v = Math.ceil(ECG.yMin / dv) * dv; v <= ECG.yMax; v += dv) { const y = Math.round(Y(v)) + 0.5; ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();
  };
  if (pxPerS * 0.04 > 3.5) grid(0.04, 0.1, PAL.gridMinor, 1);
  grid(0.2, 0.5, PAL.gridMajor, 1);

  // mV scale labels
  ctx.font = "10.5px system-ui, sans-serif"; ctx.fillStyle = PAL.faint; ctx.textAlign = "left"; ctx.textBaseline = "bottom";
  for (let v = Math.ceil(ECG.yMin / 0.5) * 0.5; v <= ECG.yMax; v += 0.5) {
    const y = Y(v); if (y > 14 && y < h - 4) ctx.fillText(`${v.toFixed(1)} mV`, 4, y - 2);
  }
  ctx.textAlign = "right";
  ctx.fillText(ECG.mode === "sweep" ? "sweep · 6 s" : "scroll · 6 s", w - 6, h - 4);

  // trace
  const xOf = ECG.mode === "sweep"
    ? (abs) => ((abs % N) / N) * w
    : (abs) => ((abs - (total - N)) / (N - 1)) * w;
  ctx.strokeStyle = PAL.trace; ctx.lineWidth = 1.7; ctx.lineJoin = "round"; ctx.lineCap = "round";
  if (PAL.dark) { ctx.shadowColor = PAL.trace; ctx.shadowBlur = 6; }
  ctx.beginPath();
  if (ECG.mode === "sweep") {
    const head = total % N;
    let pen = false;
    for (let i = 0; i < N; i++) {
      const ahead = (i - head + N) % N;
      const v = ECG.buf[i];
      if ((ahead < ECG.gap && total >= N) || (total < N && i >= head) || isNaN(v)) { pen = false; continue; }
      const x = (i / N) * w, y = Y(v);
      if (pen && i > 0) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      pen = true;
    }
  } else {
    let pen = false;
    for (let k = Math.max(0, total - N); k < total; k++) {
      const v = ECG.buf[k % N];
      if (isNaN(v)) { pen = false; continue; }
      const x = xOf(k), y = Y(v);
      pen ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      pen = true;
    }
  }
  ctx.stroke();
  ctx.shadowBlur = 0;

  // write head
  if (total > 0) {
    const k = total - 1, v = ECG.buf[k % N];
    if (!isNaN(v)) {
      ctx.fillStyle = PAL.trace;
      ctx.beginPath(); ctx.arc(xOf(k), Y(v), 3.2, 0, Math.PI * 2); ctx.fill();
    }
  }

  // R-peak markers
  ctx.font = "600 11px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
  const oldest = total - N + (ECG.mode === "sweep" ? ECG.gap : 0);
  for (const m of ECG.markers) {
    if (m.abs >= total || m.abs < oldest) continue;
    const v = ECG.buf[m.abs % N];
    if (isNaN(v)) continue;
    const x = xOf(m.abs), y = Math.max(18, Y(v) - 8);
    const col = m.abn ? PAL.danger : PAL.ok;
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.moveTo(x - 4, y - 6); ctx.lineTo(x + 4, y - 6); ctx.lineTo(x, y); ctx.closePath(); ctx.fill();
    if (m.bpm) ctx.fillText(m.bpm, x, y - 7);
  }
}

$$("#ecg-mode button").forEach((b) => {
  b.classList.toggle("active", b.dataset.mode === ECG.mode);
  b.onclick = () => {
    ECG.mode = b.dataset.mode; store.set("nc-ecg-mode", ECG.mode);
    $$("#ecg-mode button").forEach((x) => x.classList.toggle("active", x === b));
  };
});
$("#freeze-btn").onclick = (e) => {
  ECG.frozen = !ECG.frozen;
  e.currentTarget.textContent = ECG.frozen ? "Resume" : "Freeze";
  e.currentTarget.classList.toggle("btn-primary", ECG.frozen);
  if (!ECG.frozen) ECG.pending.splice(0, Math.max(0, ECG.pending.length - 10));
};

/* ================================================================ sound */
let audio = null;
function beep(freq = 880, dur = 0.12, when = 0) {
  if (!audio) return;
  const t = audio.currentTime + when;
  const o = audio.createOscillator(), g = audio.createGain();
  o.frequency.value = freq; o.type = "square";
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.08, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(audio.destination); o.start(t); o.stop(t + dur + 0.02);
}
$("#sound-chk").onchange = (e) => {
  if (e.target.checked && !audio) {
    try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch { audio = null; }
  }
  if (!e.target.checked) audio = null;
};

/* ================================================================ live status */
function setStatus(st) {
  S.status = st;
  S.counts = { n: st.n_beats, abn: st.n_abnormal };
  const live = st.source === "live";

  const dot = $("#src-dot");
  dot.className = "dot " + (st.error ? "err" : st.connected ? "on" : "");
  $("#src-text").textContent = live
    ? (st.error ? "Live · error" : st.connected ? `Live · ${st.port}` : `Live · connecting${st.port ? " " + st.port : ""}`)
    : "Synthetic demo";

  const rec = $("#rec-btn");
  rec.classList.toggle("on", !!st.recording);
  $("#rec-text").textContent = st.recording ? "Recording" : "Record";
  rec.title = st.recording ? `Recording to ${st.recording} - click to stop` : "Record beats to a session CSV";

  $$("#src-seg button").forEach((b) => b.classList.toggle("active", b.dataset.src === (uiSource || st.source)));
  $("#port-field").hidden = (uiSource || st.source) !== "live";
  $("#connect-btn").textContent = live && st.connected ? "Reconnect" : "Connect";
  $("#syn-ctrls").hidden = live;
  $("#live-ctrls").hidden = !live;
  const synKey = st.auto ? "x" : st.scenario === "NORMAL" ? "n" : "a";
  $$("#syn-seg button").forEach((b) => b.classList.toggle("active", b.dataset.cmd === synKey));
  const dm = $("#devmode-chip");
  dm.textContent = st.dev_mode;
  dm.className = "chip " + (st.dev_mode === "LIVE" ? "info" : "warn");

  $("#mode-chip").textContent = live ? (st.dev_mode === "LIVE" ? "LIVE" : st.dev_mode) : "SYNTHETIC";
  $("#mode-chip").className = "chip " + (live ? (st.dev_mode === "LIVE" ? "info" : "warn") : "warn");
  $("#fact-src").textContent = live ? `${st.port || "auto"} · ${st.connected ? "connected" : "offline"}` : "Synthetic generator";
  const cal = $("#fact-cal");
  cal.textContent = live ? (st.calibrated ? "Calibrated" : st.dev_mode !== "LIVE" ? "Test vector (pre-scaled)" : "Not calibrated") : "n/a (simulated)";
  cal.className = live && !st.calibrated && st.dev_mode === "LIVE" ? "warn-text" : "";
  $("#fact-rec").textContent = st.recording || "off";
  $("#fact-rec").title = st.recording || "";

  const banner = $("#alarm-banner");
  banner.hidden = !st.alarm;
  $("#alarm-src").textContent = live ? "Source: Arduino" : "Source: synthetic demo (not patient data)";
  if (st.alarm && !S.alarmWas) { beep(1400, 0.12); beep(1400, 0.12, 0.2); beep(1400, 0.12, 0.4); }
  S.alarmWas = st.alarm;

  if (!st.model_ready) $("#verdict-note").textContent = "Model not loaded - run train_model.py";
  updateCounts();
}

function updateCounts() {
  const { n, abn } = S.counts;
  $("#beat-count").textContent = n.toLocaleString();
  $("#n-normal").textContent = (n - abn).toLocaleString();
  $("#n-abn").textContent = abn.toLocaleString();
  const pct = n ? (abn / n) * 100 : 0;
  $("#split-normal").style.width = n ? `${100 - pct}%` : "0";
  $("#split-abn").style.width = `${pct}%`;
  const chip = $("#abn-chip");
  chip.textContent = `${pct.toFixed(pct && pct < 10 ? 1 : 0)}% abnormal`;
  chip.className = "chip " + (pct > 20 ? "bad" : pct > 0 ? "warn" : "ok");
}

setInterval(() => {
  if (!S.status) return;
  const s = Math.max(0, Math.floor(Date.now() / 1000 - S.status.started));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  $("#elapsed").textContent = (hh ? `${hh}:` : "") + `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}, 1000);

/* ================================================================ beats */
function hrZone(bpm) {
  if (!bpm) return ["No rate", ""];
  if (bpm < BPM_BRADY) return ["Bradycardia", "warn"];
  if (bpm > BPM_TACHY) return ["Tachycardia", "bad"];
  if (bpm > 100) return ["Elevated", "warn"];
  return ["Normal range", "ok"];
}

function onBeat(b, animate) {
  S.beats.push(b);
  if (S.beats.length > 600) S.beats.shift();
  if (animate) {
    S.counts.n = b.n;
    S.counts.abn += b.abnormal ? 1 : 0;
    updateCounts();
    ecgMarkBeat(b);
    const heart = $("#heart");
    heart.classList.remove("beat"); void heart.offsetWidth; heart.classList.add("beat");
  }
  renderLatest(b);
  addBeatRow(b);
  if (animate) drawTrend();
}

function renderLatest(b) {
  $("#hr-val").textContent = b.bpm || "--";
  const [zone, cls] = hrZone(b.bpm);
  const z = $("#hr-zone"); z.textContent = zone; z.className = "chip " + cls;
  const hrs = S.beats.slice(-60).map((x) => x.bpm).filter(Boolean);
  if (hrs.length) {
    $("#hr-avg").textContent = Math.round(hrs.reduce((a, c) => a + c, 0) / hrs.length);
    $("#hr-min").textContent = Math.min(...hrs);
    $("#hr-max").textContent = Math.max(...hrs);
  }
  drawSpark($("#hr-spark"), hrs.slice(-40), PAL.danger);

  const label = b.model || b.device || "--";
  const v = $("#verdict");
  v.textContent = label;
  v.className = "verdict " + (isAbn(label) ? "bad" : "ok");
  const conf = b.conf || 0;
  $("#conf-val").textContent = b.conf != null ? `${Math.round(conf * 100)}%` : "--";
  const ring = $("#ring-fg");
  ring.style.strokeDashoffset = 169.6 * (1 - conf);
  ring.style.stroke = isAbn(label) ? PAL.danger : PAL.ok;
  const dv = $("#dev-verdict");
  dv.textContent = b.device || "--";
  dv.style.color = isAbn(b.device) ? PAL.danger : "";
  $("#uncal-note").hidden = !b.uncal;
  $("#verdict-note").hidden = !!b.uncal;
  renderFeatures(b);
}

/* ---------- feature bars */
const FEAT_MIN = -0.6, FEAT_MAX = 1.6;
const fx = (v) => ((clamp(v, FEAT_MIN, FEAT_MAX) - FEAT_MIN) / (FEAT_MAX - FEAT_MIN)) * 100;

function buildFeatureBars() {
  const ranges = (S.model && S.model.ranges) || {};
  const box = $("#feat-bars");
  box.innerHTML = ["P", "Q", "R", "S"].map((f) => {
    const bands = Object.entries(ranges).map(([lab, r]) => r[f]
      ? `<div class="feat-band ${isAbn(lab) ? "bad" : "ok"}" style="left:${fx(r[f][0])}%;width:${fx(r[f][1]) - fx(r[f][0])}%" title="${esc(lab)} class: ${r[f][0]} to ${r[f][1]} mV"></div>` : "").join("");
    const thr = DEVICE_TH[f] != null ? `<div class="feat-thr" style="left:${fx(DEVICE_TH[f])}%" title="Device threshold ${DEVICE_TH[f]} mV"></div>` : "";
    return `<div class="feat">
      <span class="feat-name" style="color:${SERIES[f]}">${f}</span>
      <div class="feat-track">${bands}<div class="feat-zero" style="left:${fx(0)}%"></div>${thr}
        <div class="feat-fill" id="ff-${f}" style="left:${fx(0)}%;width:0"></div>
        <div class="feat-mark" id="fm-${f}" style="left:${fx(0)}%"></div></div>
      <span class="feat-val" id="fv-${f}">-- <small>mV</small></span></div>`;
  }).join("") + `<div class="feat-axis"><span></span><div>${[-0.5, 0, 0.5, 1, 1.5].map((t) => `<span style="left:${fx(t)}%">${t}</span>`).join("")}</div><span></span></div>`;
  const last = S.beats[S.beats.length - 1];
  if (last) renderFeatures(last);
}

function renderFeatures(b) {
  for (const f of ["P", "Q", "R", "S"]) {
    const v = b[f];
    const fill = $(`#ff-${f}`);
    if (!fill) continue;
    const a = fx(Math.min(0, v)), z = fx(Math.max(0, v));
    fill.style.left = `${a}%`;
    fill.style.width = `${z - a}%`;
    fill.style.background = SERIES[f];
    $(`#fm-${f}`).style.left = `calc(${fx(v)}% - 1.5px)`;
    $(`#fv-${f}`).innerHTML = `${signed(v)} <small>mV</small>`;
  }
}

/* ---------- trends */
let trendMode = "hr";
$$("#trend-mode button").forEach((b) => (b.onclick = () => {
  trendMode = b.dataset.mode;
  $$("#trend-mode button").forEach((x) => x.classList.toggle("active", x === b));
  drawTrend();
}));

// keep the 50-120 bpm normal band edges in view so the trend has context
function hrRange(vals) {
  const v = vals.filter(Boolean);
  return { yMin: Math.min(40, ...v) - 5, yMax: Math.max(130, ...v) + 5 };
}

function drawTrend() {
  const data = S.beats.slice(-120);
  const c = $("#trend");
  $("#trend-sub").textContent = data.length ? `Last ${data.length} beats` : "Last 120 beats";
  const ptCol = (i) => (data[i].abnormal ? PAL.danger : PAL.ok);
  if (trendMode === "hr") {
    drawChart(c, {
      series: [{ data: data.filter((b) => b.bpm).map((b) => [b.n, b.bpm]), color: PAL.accent, points: true,
        pointColor: (i) => (data.filter((b) => b.bpm)[i].abnormal ? PAL.danger : PAL.ok) }],
      bands: [{ y0: BPM_BRADY, y1: BPM_TACHY, color: PAL.okSoft }],
      ...hrRange(data.map((b) => b.bpm)),
      yFmt: (t) => t, xLabel: "beat #", yLabel: "bpm",
    });
  } else if (trendMode === "amp") {
    drawChart(c, {
      series: ["R", "P", "S", "Q"].map((f) => ({ data: data.map((b) => [b.n, b[f]]), color: SERIES[f], label: f })),
      legend: true, yFmt: (t) => t.toFixed(1), xLabel: "beat #", yLabel: "mV",
    });
  } else {
    drawChart(c, {
      series: [{ data: data.filter((b) => b.conf != null).map((b) => [b.n, b.conf]), color: PAL.faint, points: true,
        pointColor: (i) => (data.filter((b) => b.conf != null)[i].abnormal ? PAL.danger : PAL.ok) }],
      yMin: 0.4, yMax: 1.02, yFmt: (t) => `${Math.round(t * 100)}%`, xLabel: "beat #", yLabel: "confidence",
      empty: "No model confidence yet",
    });
  }
}

/* ---------- beat table */
const MAX_ROWS = 200;
function beatRowHTML(b) {
  const t = new Date(b.t * 1000).toLocaleTimeString([], { hour12: false });
  const mv = (v) => `<td class="num">${signed(v)}</td>`;
  const modelChip = b.model ? `<span class="chip ${isAbn(b.model) ? "bad" : "ok"}">${esc(b.model)}</span>` : "--";
  return `<tr class="${b.abnormal ? "abn" : ""}"><td class="num">${b.n}</td><td class="num">${t}</td>
    <td class="num">${b.bpm || "--"}</td>${mv(b.P)}${mv(b.Q)}${mv(b.R)}${mv(b.S)}
    <td><span class="${isAbn(b.device) ? "warn-text" : ""}">${esc(b.device)}</span>${b.uncal ? ' <span class="chip warn" title="Uncalibrated">UNCAL</span>' : ""}</td>
    <td>${modelChip}</td><td class="num">${b.conf != null ? Math.round(b.conf * 100) + "%" : "--"}</td></tr>`;
}
function addBeatRow(b) {
  const tb = $("#beat-rows");
  tb.insertAdjacentHTML("afterbegin", beatRowHTML(b));
  while (tb.rows.length > MAX_ROWS) tb.deleteRow(tb.rows.length - 1);
  $("#beat-empty").hidden = true;
}
$("#only-abn").onchange = (e) => $("#beat-rows").classList.toggle("only-abn", e.target.checked);

/* ---------- event console */
function addLog(e) {
  const ol = $("#console");
  const nearBottom = ol.scrollHeight - ol.scrollTop - ol.clientHeight < 30;
  const li = document.createElement("li");
  li.className = e.level || "info";
  li.innerHTML = `<time>${new Date(e.t * 1000).toLocaleTimeString([], { hour12: false })}</time><span>${esc(e.text)}</span>`;
  ol.appendChild(li);
  while (ol.children.length > 200) ol.firstChild.remove();
  if (nearBottom) ol.scrollTop = ol.scrollHeight;
}

/* ---------- reset */
function resetLive() {
  S.beats = [];
  S.counts = { n: 0, abn: 0 };
  ecgReset();
  $("#beat-rows").innerHTML = "";
  $("#beat-empty").hidden = false;
  $("#hr-val").textContent = "--";
  ["#hr-avg", "#hr-min", "#hr-max"].forEach((s) => ($(s).textContent = "--"));
  $("#hr-zone").textContent = "—"; $("#hr-zone").className = "chip";
  $("#verdict").textContent = "Waiting"; $("#verdict").className = "verdict";
  $("#conf-val").textContent = "--"; $("#ring-fg").style.strokeDashoffset = 169.6;
  $("#dev-verdict").textContent = "--";
  drawSpark($("#hr-spark"), [], PAL.danger);
  for (const f of ["P", "Q", "R", "S"]) renderFeatures({ P: 0, Q: 0, R: 0, S: 0 });
  $$(".feat-val").forEach((el) => (el.innerHTML = "-- <small>mV</small>"));
  updateCounts();
  drawTrend();
}

/* ================================================================ stream */
function connectStream() {
  const es = new EventSource("/api/stream");
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    switch (ev.type) {
      case "hello":
        resetLive();
        $("#console").innerHTML = "";
        ev.logs.forEach(addLog);
        ecgPrefill(ev.wave);
        setStatus(ev.status);
        ev.beats.forEach((b) => onBeat(b, false));
        S.counts = { n: ev.status.n_beats, abn: ev.status.n_abnormal };
        updateCounts();
        drawTrend();
        break;
      case "wave": ecgReceive(ev.v); break;
      case "beat": onBeat(ev.beat, true); break;
      case "status": setStatus(ev.status); break;
      case "log": addLog(ev); break;
      case "reset": resetLive(); break;
    }
  };
  es.onerror = () => {
    $("#src-dot").className = "dot err";
    $("#src-text").textContent = "Dashboard server offline";
  };
}

/* ================================================================ controls */
let uiSource = null; // what the source toggle shows before Connect is pressed

async function sendCmd(cmd) {
  try { await api("/api/command", { cmd }); } catch { /* status/log events report the outcome */ }
}
$$("[data-cmd]").forEach((b) => (b.onclick = () => sendCmd(b.dataset.cmd)));

$$("#src-seg button").forEach((b) => (b.onclick = async () => {
  if (b.dataset.src === "synthetic") {
    uiSource = null;
    if (S.status.source !== "synthetic") await api("/api/source", { mode: "synthetic" });
    else setStatus(S.status);
  } else {
    uiSource = "live";
    setStatus(S.status);
    loadPorts();
  }
}));

async function loadPorts() {
  try {
    const r = await api("/api/ports");
    const sel = $("#port-sel"), cur = sel.value || (S.status && S.status.port) || "";
    sel.innerHTML = `<option value="">Auto-detect</option>` +
      r.ports.map((p) => `<option value="${esc(p.device)}">${esc(p.device)} - ${esc(p.description)}</option>`).join("");
    if (!r.pyserial) sel.innerHTML = `<option value="">pyserial not installed</option>`;
    else if (!r.ports.length) sel.insertAdjacentHTML("beforeend", `<option disabled>No ports found - is the board plugged in?</option>`);
    if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
  } catch { /* server offline */ }
}
$("#port-refresh").onclick = loadPorts;
$("#connect-btn").onclick = async () => {
  uiSource = null;
  await api("/api/source", { mode: "live", port: $("#port-sel").value || null });
};
$("#rec-btn").onclick = () => api("/api/record", { on: !(S.status && S.status.recording) });

// keyboard shortcuts on the monitor tab, same letters as host_monitor.py
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if (currentTab !== "monitor" || !S.status) return;
  const k = e.key.toLowerCase();
  const allowed = S.status.source === "live" ? "tscbrdh" : "nax";
  if (allowed.includes(k) && k.length === 1) sendCmd(k);
  if (k === "f") $("#freeze-btn").click();
});

/* ================================================================ tabs */
let currentTab = "monitor";
function showTab(name) {
  if (!$(`#tab-${name}`)) name = "monitor";
  currentTab = name;
  $$(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
  if (location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
  if (name === "sessions") loadSessions();
  if (name === "lab") { initLab(); predictLab(); }
  redrawAll();
}
$$(".tab-btn").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

function redrawAll() {
  if (!PAL.text) return;
  drawTrend();
  drawSpark($("#hr-spark"), S.beats.slice(-40).map((b) => b.bpm).filter(Boolean), PAL.danger);
  const last = S.beats[S.beats.length - 1];
  if (last) $("#ring-fg").style.stroke = isAbn(last.model || last.device) ? PAL.danger : PAL.ok;
  if (currentTab === "lab" && labInit) drawLab();
  if (currentTab === "sessions" && sess.rows) drawSessionCharts();
}
let resizeT;
window.addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(redrawAll, 120); });

/* ================================================================ sessions */
const sess = { list: [], active: null, rows: null, summary: null, mode: "hr" };

function prettySession(name) {
  const m = /session_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(name);
  if (!m) return name;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return d.toLocaleString([], { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

async function loadSessions() {
  try { sess.list = await api("/api/sessions"); } catch { return; }
  const ul = $("#session-list");
  if (!sess.list.length) {
    ul.innerHTML = `<li class="empty">No recordings yet. Press Record on the monitor.</li>`;
    return;
  }
  const recording = S.status && S.status.recording;
  ul.innerHTML = sess.list.map((s) => {
    const src = (s.sources || []).map((x) => `<span class="chip ${x.startsWith("SYN") ? "warn" : "info"}">${x.startsWith("SYN") ? "Synthetic" : "Live"}</span>`).join(" ");
    return `<li class="session-item ${s.name === sess.active ? "active" : ""}" data-name="${esc(s.name)}">
      <div class="s-top"><span>${esc(prettySession(s.name))}</span>${s.name === recording ? '<span class="chip bad">● rec</span>' : src}</div>
      <div class="s-meta"><span>${s.beats ?? "?"} beats</span><span>${s.avg_bpm ?? "--"} bpm avg</span>
      <span class="${s.abnormal ? "warn-text" : ""}">${s.abnormal ?? 0} abnormal</span></div></li>`;
  }).join("");
  $$(".session-item", ul).forEach((li) => (li.onclick = () => openSession(li.dataset.name)));
  if (!sess.active && sess.list[0]) openSession(sess.list[0].name);
}
$("#sess-refresh").onclick = loadSessions;

function fmtDuration(a, b) {
  if (!a || !b) return "--";
  const s = Math.max(0, (new Date(b) - new Date(a)) / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`;
}

async function openSession(name) {
  sess.active = name;
  $$(".session-item").forEach((li) => li.classList.toggle("active", li.dataset.name === name));
  let r;
  try { r = await api(`/api/sessions/${encodeURIComponent(name)}`); } catch { return; }
  if (r.error) return;
  sess.rows = r.rows; sess.summary = r.summary;
  const s = r.summary, rows = r.rows;
  const confs = rows.map((x) => x.conf).filter((x) => x != null);
  const abnPct = s.beats ? ((s.abnormal / s.beats) * 100).toFixed(1) : "0";
  $("#session-detail").innerHTML = `
    <article class="card">
      <div class="card-head">
        <div><h2>${esc(prettySession(name))}</h2><p class="sub">${esc(name)} · ${(s.sources || []).join(", ")}</p></div>
        <a class="btn" href="/api/sessions/${encodeURIComponent(name)}?download">Download CSV</a>
      </div>
      <div class="stat-row">
        <div class="stat"><span>Beats</span><b>${s.beats}</b></div>
        <div class="stat"><span>Duration</span><b>${fmtDuration(s.start, s.end)}</b></div>
        <div class="stat"><span>Average HR</span><b>${s.avg_bpm ?? "--"}<small style="font-size:12px;color:var(--muted)"> bpm</small></b></div>
        <div class="stat"><span>Abnormal</span><b style="color:${s.abnormal ? "var(--danger)" : "var(--ok)"}">${abnPct}%</b></div>
        <div class="stat"><span>Mean confidence</span><b>${confs.length ? Math.round((confs.reduce((a, c) => a + c, 0) / confs.length) * 100) + "%" : "--"}</b></div>
      </div>
      ${s.uncal ? `<div class="note"><b>${s.uncal} of ${s.beats} beats were recorded uncalibrated.</b>Their amplitudes may be on the wrong scale, so treat those verdicts with caution. Press Calibrate on a clean live beat next time.</div>` : ""}
    </article>
    <article class="card">
      <div class="card-head">
        <div><h2>Recording timeline</h2><p class="sub">Per beat, coloured by model verdict</p></div>
        <div class="seg" id="sess-mode">
          <button data-mode="hr">Heart rate</button><button data-mode="amp">Amplitudes</button><button data-mode="scatter">P vs R</button>
        </div>
      </div>
      <canvas class="chart" id="sess-chart"></canvas>
    </article>
    <article class="card">
      <div class="card-head"><div><h2>Beats</h2><p class="sub">${rows.length} rows</p></div></div>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>#</th><th>Time</th><th>Scenario</th><th>HR</th><th>P</th><th>Q</th><th>R</th><th>S</th><th>Device</th><th>Model</th><th>Conf.</th></tr></thead>
        <tbody>${rows.map((x, i) => {
          const abn = isAbn(x.model || x.device);
          return `<tr class="${abn ? "abn" : ""}"><td class="num">${i + 1}</td><td class="num">${esc((x.timestamp || "").slice(11))}</td>
          <td>${esc(x.scenario || "--")}</td><td class="num">${x.bpm ?? "--"}</td>
          ${["P", "Q", "R", "S"].map((f) => `<td class="num">${signed(x[f])}</td>`).join("")}
          <td>${esc(x.device)}${x.uncal ? ' <span class="chip warn">UNCAL</span>' : ""}</td>
          <td>${x.model ? `<span class="chip ${abn ? "bad" : "ok"}">${esc(x.model)}</span>` : "--"}</td>
          <td class="num">${x.conf != null ? Math.round(x.conf * 100) + "%" : "--"}</td></tr>`;
        }).join("")}</tbody></table></div>
    </article>`;
  $$("#sess-mode button").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === sess.mode);
    b.onclick = () => {
      sess.mode = b.dataset.mode;
      $$("#sess-mode button").forEach((x) => x.classList.toggle("active", x === b));
      drawSessionCharts();
    };
  });
  drawSessionCharts();
}

function drawSessionCharts() {
  const c = $("#sess-chart");
  if (!c || !sess.rows) return;
  const rows = sess.rows.map((x, i) => ({ ...x, i: i + 1, abn: isAbn(x.model || x.device) }));
  if (sess.mode === "hr") {
    const d = rows.filter((x) => x.bpm);
    drawChart(c, {
      series: [{ data: d.map((x) => [x.i, x.bpm]), color: PAL.accent, points: true, pointColor: (i) => (d[i].abn ? PAL.danger : PAL.ok) }],
      bands: [{ y0: BPM_BRADY, y1: BPM_TACHY, color: PAL.okSoft }], ...hrRange(d.map((x) => x.bpm)), xLabel: "beat #", yLabel: "bpm",
      empty: "No heart-rate values in this recording",
    });
  } else if (sess.mode === "amp") {
    drawChart(c, {
      series: ["R", "P", "S", "Q"].map((f) => ({ data: rows.filter((x) => x[f] != null).map((x) => [x.i, x[f]]), color: SERIES[f], label: f })),
      legend: true, yFmt: (t) => t.toFixed(1), xLabel: "beat #", yLabel: "mV",
    });
  } else {
    drawScatter(c, "P", rows.map((x) => ({ x: x.P, y: x.R, abn: x.abn })), null, true);
  }
}

/* ================================================================ classifier lab */
const LAB = { P: 0.173, Q: -0.245, R: 0.74, x: "P" };
const LAB_RANGES = { P: [0, 0.6], Q: [-0.6, 0], R: [0, 1.8] };
const PRESETS = [
  ["Firmware SIM-NORMAL", 0.173, -0.245, 0.74],
  ["SIM-NORMAL 109 bpm", 0.132, -0.289, 0.7],
  ["Firmware SIM-ABNORMAL", 0.412, -0.413, 1.254],
  ["Normal class mean", 0.145, -0.251, 0.733],
  ["Abnormal class mean", 0.403, -0.448, 1.308],
  ["Borderline", 0.25, -0.33, 1.05],
];
let labInit = false, labResult = null, labTimer = null;

function initLab() {
  if (labInit) return;
  labInit = true;
  $("#sliders").innerHTML = ["P", "Q", "R"].map((f) => `
    <div class="slider"><b style="color:${SERIES[f]}">${f}</b>
      <input type="range" id="sl-${f}" min="${LAB_RANGES[f][0]}" max="${LAB_RANGES[f][1]}" step="0.001" value="${LAB[f]}">
      <input type="number" id="nm-${f}" step="0.01" value="${LAB[f]}"></div>`).join("");
  for (const f of ["P", "Q", "R"]) {
    $(`#sl-${f}`).oninput = (e) => setLab(f, +e.target.value);
    $(`#nm-${f}`).onchange = (e) => setLab(f, +e.target.value);
  }
  $("#presets").innerHTML = PRESETS.map((p, i) => `<button class="btn" data-preset="${i}">${p[0]}</button>`).join("") +
    `<button class="btn btn-primary" id="use-last">Latest live beat</button>`;
  $$("[data-preset]").forEach((b) => (b.onclick = () => {
    const p = PRESETS[+b.dataset.preset];
    setLab("P", p[1], true); setLab("Q", p[2], true); setLab("R", p[3]);
  }));
  $("#use-last").onclick = () => {
    const b = S.beats[S.beats.length - 1];
    if (!b) return;
    setLab("P", b.P, true); setLab("Q", b.Q, true); setLab("R", b.R);
  };
  $$("#scatter-mode button").forEach((b) => (b.onclick = () => {
    LAB.x = b.dataset.x;
    $$("#scatter-mode button").forEach((x) => x.classList.toggle("active", x === b));
    drawLab();
  }));
  renderModelFacts();
}

function setLab(f, v, quiet) {
  if (isNaN(v)) return;
  LAB[f] = +(+v).toFixed(4);
  $(`#sl-${f}`).value = LAB[f];
  $(`#nm-${f}`).value = LAB[f];
  if (!quiet) { drawLab(); clearTimeout(labTimer); labTimer = setTimeout(predictLab, 90); }
}

async function predictLab() {
  if (!labInit) return;
  let r;
  try { r = await api("/api/predict", { P: LAB.P, Q: LAB.Q, R: LAB.R }); } catch { return; }
  const v = $("#lab-verdict");
  if (r.error) { v.textContent = r.error; v.className = "lab-verdict"; return; }
  labResult = r;
  v.textContent = `${r.label} · ${Math.round(r.confidence * 100)}%`;
  v.className = "lab-verdict " + (isAbn(r.label) ? "bad" : "ok");
  $("#proba-bars").innerHTML = Object.entries(r.proba).sort().reverse().map(([k, p]) => `
    <div class="prob"><span>${esc(k)}</span><div class="prob-track"><div class="prob-fill" style="width:${p * 100}%;background:${isAbn(k) ? PAL.danger : PAL.ok}"></div></div><span>${(p * 100).toFixed(1)}%</span></div>`).join("");
  drawLab();
}

function renderModelFacts() {
  const m = S.model;
  if (!m) return;
  $("#lab-model-sub").textContent = m.ready
    ? `Random Forest · ${m.n_estimators} trees · trained on ${m.rows.length} rows`
    : "Model not loaded - run python train_model.py";
  const counts = Object.entries(m.counts || {}).map(([k, v]) => `${v} ${k}`).join(" · ");
  $("#lab-data-sub").textContent = `data.csv · ${counts} · your beat shown as the ring`;
  const imp = m.importances || {};
  $("#importances").innerHTML = Object.keys(imp).length ? Object.entries(imp).sort((a, b) => b[1] - a[1]).map(([f, v]) => `
    <div class="imp"><b style="color:${SERIES[f]}">${f}</b><div class="imp-track"><div class="imp-fill" style="width:${v * 100}%;background:${SERIES[f]}"></div></div><span>${(v * 100).toFixed(0)}%</span></div>`).join("")
    : `<p class="sub">Not available</p>`;
}

function drawScatter(c, xf, extra, current, extraIsMain) {
  const m = S.model;
  const train = m ? m.rows.map((r) => ({ x: r[xf === "P" ? 0 : 1], y: r[2], abn: isAbn(r[3]) })) : [];
  const ptsA = extraIsMain ? extra : train;
  const all = [...ptsA, ...(extraIsMain ? train : extra || []), ...(current ? [current] : [])];
  if (!all.length) return drawChart(c, { series: [] });
  drawChart(c, {
    series: [
      ...(extraIsMain ? [{ data: train.map((p) => [p.x, p.y]), color: PAL.faint, points: true, line: false, r: 2,
        pointColor: (i) => (train[i].abn ? PAL.danger + "40" : PAL.ok + "40"), label: "training" }] : []),
      { data: ptsA.map((p) => [p.x, p.y]), color: PAL.ok, points: true, line: false, r: extraIsMain ? 3 : 3.4,
        pointColor: (i) => (ptsA[i].abn ? PAL.danger : PAL.ok), label: extraIsMain ? "beats" : null },
      ...(!extraIsMain && extra && extra.length ? [{ data: extra.map((p) => [p.x, p.y]), color: PAL.accent + "99", points: true, line: false, r: 2.2, label: "live beats" }] : []),
    ],
    legend: true,
    xFmt: (t) => t.toFixed(2), yFmt: (t) => t.toFixed(1), xLabel: `${xf} (mV)`, yLabel: "R (mV)",
    after: current ? (ctx, X, Y) => {
      const x = X(current.x), y = Y(current.y);
      ctx.strokeStyle = PAL.accent; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, c.clientHeight); ctx.moveTo(0, y); ctx.lineTo(c.clientWidth, y); ctx.stroke();
      ctx.setLineDash([]); ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = labResult && isAbn(labResult.label) ? PAL.danger : PAL.ok;
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
    } : null,
  });
}

function drawLab() {
  if (!labInit) return;
  const live = S.beats.slice(-80).map((b) => ({ x: b[LAB.x], y: b.R }));
  drawScatter($("#scatter"), LAB.x, live, { x: LAB[LAB.x], y: LAB.R }, false);

  // synthesised beat from the three amplitudes
  const c = $("#lab-beat");
  if (!c.clientWidth) return;
  const { ctx, w, h } = fitCanvas(c);
  const pts = [];
  const g = (t, m, s) => Math.exp(-0.5 * ((t - m) / s) ** 2);
  for (let i = 0; i <= 300; i++) {
    const t = (i / 300) * 0.8;
    pts.push([t, LAB.P * g(t, 0.12, 0.022) + LAB.Q * g(t, 0.232, 0.009) + LAB.R * g(t, 0.26, 0.0105)
      - 0.25 * g(t, 0.29, 0.01) + 0.25 * g(t, 0.52, 0.045)]);
  }
  const lo = Math.min(-0.7, ...pts.map((p) => p[1])) - 0.1, hi = Math.max(1.0, ...pts.map((p) => p[1])) + 0.15;
  const X = (t) => (t / 0.8) * w, Y = (v) => (1 - (v - lo) / (hi - lo)) * h;
  ctx.strokeStyle = PAL.gridMajor; ctx.lineWidth = 1; ctx.beginPath();
  for (let t = 0; t <= 0.8; t += 0.2) { ctx.moveTo(X(t) + 0.5, 0); ctx.lineTo(X(t) + 0.5, h); }
  for (let v = Math.ceil(lo / 0.5) * 0.5; v <= hi; v += 0.5) { ctx.moveTo(0, Y(v) + 0.5); ctx.lineTo(w, Y(v) + 0.5); }
  ctx.stroke();
  ctx.strokeStyle = PAL.dark ? PAL.ok : PAL.text; ctx.lineWidth = 2; ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))));
  ctx.stroke();
  ctx.font = "600 11px system-ui, sans-serif"; ctx.textAlign = "center";
  for (const [f, t] of [["P", 0.12], ["Q", 0.232], ["R", 0.26]]) {
    const v = LAB[f];
    ctx.fillStyle = SERIES[f];
    ctx.textBaseline = v >= 0 ? "bottom" : "top";
    ctx.fillText(f, X(t) + (f === "Q" ? -8 : 0), Y(v) + (v >= 0 ? -4 : 4));
  }
}

/* ================================================================ boot */
async function boot() {
  const saved = store.get("nc-theme");
  document.documentElement.dataset.theme =
    saved || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  readPalette();
  buildFeatureBars();
  connectStream();
  requestAnimationFrame(ecgTick);
  showTab((location.hash || "#monitor").slice(1));
  try {
    S.model = await api("/api/model");
    buildFeatureBars();
    renderModelFacts();
    if (currentTab === "lab") drawLab();
  } catch { /* model facts are optional */ }
}
boot();
