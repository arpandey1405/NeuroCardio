"""
NeuroCardio - web dashboard

A browser front-end for the whole host side: live ECG strip, per-beat
features, Random Forest verdicts, alarms, session recording and review, and
a classifier playground. Uses only the Python standard library for the web
server (no Flask needed) plus the packages already in requirements.txt.

RUN
    python train_model.py              # once, creates models/
    python dashboard.py                # synthetic source, opens the browser
    python dashboard.py --port COM5    # start straight on the Arduino
    python dashboard.py --no-browser   # don't open a browser tab
    python dashboard.py --http 8080    # serve on a different port
    python dashboard.py --model snn    # classify beats with the trained SNN
                                       # (host/models/neurocardio_snn.pt; falls back to a
                                       #  preview network if the file is missing)

Then open http://127.0.0.1:8050 . The source (SYNTHETIC / LIVE serial) can
also be switched from the dashboard itself.

Close the Arduino IDE Serial Monitor first - only one program can hold the
COM port.

ENDPOINTS
    GET  /api/stream          Server-Sent Events: wave chunks, beats, logs, status
    GET  /api/state           snapshot of everything the dashboard shows
    POST /api/command         {"cmd": "t"}        forward / synthetic control
    POST /api/source          {"mode": "live", "port": "COM5"} | {"mode": "synthetic"} | {"mode": "replay"}
    POST /api/record          {"on": true}
    POST /api/model-kind      {"kind": "rf" | "snn"}
    GET  /api/ports           available serial ports
    POST /api/predict         {"P":..,"Q":..,"R":..}  -> class probabilities
    GET  /api/model           training data + model facts
    GET  /api/sessions        recorded session_*.csv summaries
    GET  /api/sessions/<file> rows of one session
"""

import argparse
import csv
import json
import math
import os
import queue
import random
import re
import threading
import time
import webbrowser
from collections import deque
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

try:
    import serial
    from serial.tools import list_ports
except ImportError:                      # synthetic mode still works without it
    serial = None
    list_ports = None

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
DOCS = os.path.join(os.path.dirname(HERE), "docs")
FEATURES = ["P", "Q", "R"]
Q4_TO_MV = 0.00122075          # must match Q4_TO_MV_BASE in the sketch
FS_STREAM = 100                # the sketch decimates the stream to 100 Hz
WAVE_KEEP = 8 * FS_STREAM      # samples replayed to a freshly connected browser
SESSION_RE = re.compile(r"^session_\d{8}_\d{6}\.csv$")
# the Next.js front end (frontend/) runs on its own localhost port
LOCAL_ORIGIN_RE = re.compile(r"^http://(localhost|127\.0\.0\.1|\[::1\]):\d+$")
LOG_HEADER = ["timestamp", "source", "scenario", "arduino_ms", "bpm",
              "P_mV", "Q_mV", "R_mV", "S_mV", "device_verdict",
              "model_verdict", "model_conf", "uncalibrated"]


# --------------------------------------------------------------- model
class Classifier:
    def __init__(self):
        self.model = self.le = None
        self.error = None
        try:
            import joblib
            self.model = joblib.load(os.path.join(HERE, "models", "rf_model.joblib"))
            self.le = joblib.load(os.path.join(HERE, "models", "label_encoder.joblib"))
            print("Model loaded: RandomForest on (P, Q, R)")
        except Exception as e:
            self.error = str(e)
            print(f"[warn] model not loaded ({e}); run  python train_model.py  first")

    @property
    def ready(self):
        return self.model is not None

    def proba(self, p, q, r):
        """Return {class: probability} or None if there is no model."""
        if not self.ready:
            return None
        import pandas as pd
        pr = self.model.predict_proba(pd.DataFrame([[p, q, r]], columns=FEATURES))[0]
        return {str(c): float(v) for c, v in zip(self.le.classes_, pr)}

    def classify(self, p, q, r):
        pr = self.proba(p, q, r)
        if pr is None:
            return None, None
        label = max(pr, key=pr.get)
        return label, pr[label]


# --------------------------------------------------------------- synthetic ECG
def synthetic_features(normal):
    """Per-beat features drawn from the same ranges as the training classes
    (data.csv) and the firmware's SIM-NORMAL / SIM-ABNORMAL test vectors, so
    the model sees the abnormal episodes the way the device would report them."""
    if normal:
        return dict(P=random.uniform(0.11, 0.19), Q=random.uniform(-0.29, -0.21),
                    R=random.uniform(0.62, 0.97), S=random.uniform(-0.30, -0.18),
                    bpm=random.uniform(64, 84))
    return dict(P=random.uniform(0.32, 0.48), Q=random.uniform(-0.49, -0.41),
                R=random.uniform(1.15, 1.45), S=random.uniform(-0.46, -0.30),
                bpm=random.uniform(96, 124))


def synthetic_beat(f, normal, t0):
    """Sampled waveform for one beat whose wave amplitudes are the features
    themselves, so the strip and the numbers agree. Returns (samples, r_index)."""
    rr = 60.0 / f["bpm"]
    n = max(30, round(rr * FS_STREAM))
    t_r = 0.26
    t_wave = t_r + 0.32 * math.sqrt(rr)
    t_amp = 0.24 if normal else -0.14            # inverted T on abnormal beats
    noise = 0.008 if normal else 0.012
    out = []
    for i in range(n):
        t = i / FS_STREAM
        g = lambda c, w: math.exp(-0.5 * ((t - c) / w) ** 2)  # noqa: E731
        v = (f["P"] * g(t_r - 0.14, 0.022)
             + f["Q"] * g(t_r - 0.028, 0.009)
             + f["R"] * g(t_r, 0.0105)
             + f["S"] * g(t_r + 0.03, 0.010)
             + t_amp * g(t_wave, 0.045)
             + 0.03 * math.sin(2 * math.pi * 0.22 * (t0 + t))   # breathing wander
             + random.gauss(0, noise))
        out.append(round(v, 4))
    return out, round(t_r * FS_STREAM)



# --------------------------------------------------------------- MIT-BIH replay
REPLAY_FILE = os.path.join(HERE, "replay", "mitbih_ds2_clips.npz")
AAMI_CLASS = {**dict.fromkeys("NLRej", "N"), **dict.fromkeys("AaJS", "S"), **dict.fromkeys("VE", "V"), "F": "F"}


def load_replay_clips():
    """Clips built by tools/build_mitbih_replay.py: real DS2 beats through the firmware emulation."""
    import numpy as np
    d = np.load(REPLAY_FILE)
    clips = []
    for i in range(int(d["n_clips"])):
        clips.append(dict(
            record=str(d[f"c{i}_record"]), kind=str(d[f"c{i}_kind"]),
            wave=[round(float(v), 4) for v in d[f"c{i}_wave"].astype("float32")],
            beats={int(r): dict(sym=str(sym), P=float(f[0]), Q=float(f[1]), R=float(f[2]), S=float(f[3]),
                                bpm=int(bpm), device="ABNORMAL" if dev else "NORMAL")
                   for r, sym, f, bpm, dev in zip(d[f"c{i}_r"], d[f"c{i}_sym"], d[f"c{i}_feat"],
                                                  d[f"c{i}_bpm"], d[f"c{i}_device"])}))
    return clips

# --------------------------------------------------------------- event hub
class Hub:
    """Fan-out of events to every connected browser."""

    def __init__(self):
        self.clients = set()
        self.lock = threading.Lock()

    def subscribe(self):
        q = queue.Queue(maxsize=2000)
        with self.lock:
            self.clients.add(q)
        return q

    def unsubscribe(self, q):
        with self.lock:
            self.clients.discard(q)

    def publish(self, ev):
        data = json.dumps(ev, separators=(",", ":"))
        with self.lock:
            for q in list(self.clients):
                try:
                    q.put_nowait(data)
                except queue.Full:       # a stalled tab must not block the others
                    pass


# --------------------------------------------------------------- engine
class Engine:
    def __init__(self, clf, hub, model_kind="rf"):
        self.clf, self.hub = clf, hub
        self.model_kind = "rf"
        self.snn = None                   # active spiking network (trained, or the preview)
        self.snn_classifies = False       # True when the trained SNN makes the verdicts
        self.trained_snn, self.snn_error = self._load_trained_snn()
        self.last_wave_t = 0.0
        self.warned_no_wave = False
        self.replay_clips = None          # loaded on first use
        self.replay_clip = None           # clip currently playing
        self.replay_switch = False        # scenario changed: jump to a matching clip
        self.lock = threading.RLock()
        self.worker = None
        self.stop_evt = threading.Event()
        self.ser = None
        self.source = "synthetic"
        self.port = None
        self.connected = False
        self.error = None
        # firmware state, tracked from its own "# ..." status lines
        self.dev_mode = "LIVE"
        self.calibrated = False
        self.stream_on = False
        # synthetic state
        self.auto = True
        self.normal = True
        self.episode_left = random.randint(8, 14)
        # recording
        self.rec_file = None
        self.rec_writer = None
        self.rec_name = None
        self.reset_stats(publish=False)
        self.set_model_kind(model_kind, announce=False)

    # ----------------------------------------------------------- stats
    def reset_stats(self, publish=True):
        with self.lock:
            self.beats = deque(maxlen=600)
            self.wave = deque(maxlen=WAVE_KEEP)
            self.wave_total = 0           # absolute index of the next sample
            self.snn_pending = []         # beats waiting for 0.4 s of samples after their R peak
            self.snn_last = None
            self.logs = deque(maxlen=200)
            self.n_beats = 0
            self.n_abnormal = 0
            self.streak = 0
            self.alarm = False
            self.started = time.time()
        if publish:
            self.hub.publish({"type": "reset"})
            self.publish_status()

    def status(self):
        with self.lock:
            return dict(
                source=self.source, port=self.port, connected=self.connected,
                error=self.error, dev_mode=self.dev_mode,
                calibrated=self.calibrated, stream_on=self.stream_on,
                auto=self.auto, scenario="NORMAL" if self.normal else "ABNORMAL",
                recording=self.rec_name, model_ready=self.clf.ready,
                model_error=self.clf.error, model_kind=self.model_kind,
                model_label=("SNN" if self.snn_classifies else "SNN preview") if self.snn else "Random Forest",
                verdict_by="SNN" if self.snn_classifies else "Random Forest",
                snn_trained=self.trained_snn is not None, snn_error=self.snn_error,
                snn_meta=self._snn_meta(),
                replay=(dict(record=self.replay_clip["record"], kind=self.replay_clip["kind"],
                             beats=len(self.replay_clip["beats"]))
                        if self.source == "replay" and self.replay_clip else None),
                n_beats=self.n_beats,
                n_abnormal=self.n_abnormal, alarm=self.alarm,
                started=self.started, fs=FS_STREAM)

    def publish_status(self):
        self.hub.publish({"type": "status", "status": self.status()})

    def snapshot(self):
        with self.lock:
            return dict(status=self.status(), beats=list(self.beats),
                        wave=list(self.wave), logs=list(self.logs), snn=self.snn_last)

    def log(self, text, level="info"):
        entry = dict(t=time.time(), text=text, level=level)
        with self.lock:
            self.logs.append(entry)
        self.hub.publish({"type": "log", **entry})

    # ----------------------------------------------------------- sources
    def start(self, mode, port=None):
        self.stop()
        self.set_recording(False)         # one recording per source run
        with self.lock:
            self.source = mode
            self.port = port if mode == "live" else None
            self.error = None
            self.connected = False
        self.reset_stats(publish=False)
        self.stop_evt = threading.Event()
        target = {"live": self._run_live, "replay": self._run_replay}.get(mode, self._run_synthetic)
        self.worker = threading.Thread(target=target, args=(self.stop_evt,), daemon=True)
        self.worker.start()
        self.hub.publish({"type": "reset"})
        self.publish_status()

    def stop(self):
        self.stop_evt.set()
        if self.worker and self.worker.is_alive():
            self.worker.join(timeout=3)
        self.worker = None

    def _push_wave(self, samples):
        with self.lock:
            self.wave.extend(samples)
            self.wave_total += len(samples)
            self.last_wave_t = time.time()
        self.hub.publish({"type": "wave", "v": samples})
        if self.snn:
            self._snn_run_ready()

    # ----------------------------------------------------------- SNN
    @staticmethod
    def _load_trained_snn():
        try:
            import snn_model
            net = snn_model.load()
            if net is None:
                return None, "host/models/neurocardio_snn.pt not found - run the training notebook"
            print(f"Trained SNN loaded: {net.hidden}-neuron LIF layers, "
                  f"{net.steps} steps, threshold {net.threshold:.2f}")
            return net, None
        except Exception as e:                            # e.g. PyTorch not installed
            print(f"[warn] trained SNN not loaded: {e}")
            return None, f"trained SNN not loaded: {e}"

    def _snn_meta(self):
        net = self.trained_snn
        if net is None:
            return None
        m = net.test_metrics
        return dict(trained=net.trained, hidden=net.hidden, steps=net.steps, threshold=net.threshold,
                    test_f1=round(m.get("F1", 0), 3), test_auc=round(m.get("ROC-AUC", 0), 3),
                    test_sensitivity=round(m.get("Sensitivity", 0), 3))

    def _snn_window_size(self):
        net = self.snn
        return (net.pre, net.post) if hasattr(net, "pre") else (20, 40)

    def _snn_queue_beat(self, beat_args):
        """R = max of the last 30 samples, the same rule the training notebook uses."""
        with self.lock:
            recent = list(self.wave)[-30:]
            if not recent:
                return False
            r_abs = self.wave_total - len(recent) + max(range(len(recent)), key=recent.__getitem__)
            self.snn_pending.append(dict(args=beat_args, r_abs=r_abs, t=time.time()))
            return True

    def _snn_run_ready(self):
        pre, post = self._snn_window_size()
        ready, expired = [], []
        with self.lock:
            first = self.wave_total - len(self.wave)          # absolute index of wave[0]
            keep = []
            for item in self.snn_pending:
                if self.wave_total >= item["r_abs"] + post:   # 0.4 s after R has arrived
                    if item["r_abs"] - pre >= first:
                        i = item["r_abs"] - pre - first
                        ready.append((item, list(self.wave)[i:i + pre + post], self.wave_total - item["r_abs"]))
                    else:
                        expired.append(item)
                elif time.time() - item["t"] > 2.0:          # stream stalled: don't hold beats forever
                    expired.append(item)
                else:
                    keep.append(item)
            self.snn_pending = keep
        for item in expired:
            if "beat" not in item["args"]:               # preview beats were already counted
                self._finish_beat(**item["args"], via="Random Forest (no waveform)")
        for item, window, lag in ready:
            out = self.snn.run(window)
            if self.snn_classifies:
                beat = self._finish_beat(**item["args"], label=out["label"], conf=out["conf"], lag=lag, via="SNN")
            else:
                beat = item["args"].get("beat")
            if beat is None:
                continue
            out = dict(n=beat["n"], **out)
            with self.lock:
                self.snn_last = out
            self.hub.publish({"type": "snn", **out})

    def _run_synthetic(self, stop):
        with self.lock:
            self.connected = True
        self.publish_status()
        self.log("Synthetic source started - no sensor in use, not patient data.")
        self._run_paced(stop, self._synthetic_samples())

    def _run_paced(self, stop, gen):
        """Stream a (sample, beat-or-None) generator at the 100 Hz serial rate."""
        t_start = time.perf_counter()
        sent = 0
        while not stop.is_set():
            due = int((time.perf_counter() - t_start) * FS_STREAM) - sent
            chunk = []
            for _ in range(max(0, due)):
                v, beat = next(gen)
                chunk.append(v)
                if beat:
                    if chunk:
                        self._push_wave(chunk)
                        chunk = []
                    self.on_beat(**beat)
            if chunk:
                self._push_wave(chunk)
            sent += max(0, due)
            stop.wait(0.04)

    def _run_replay(self, stop):
        try:
            if self.replay_clips is None:
                self.replay_clips = load_replay_clips()
        except Exception as e:
            with self.lock:
                self.error = f"MIT-BIH replay data missing ({e}) - run host/tools/build_mitbih_replay.py"
            self.log(self.error, "error")
            self.publish_status()
            return
        with self.lock:
            self.connected = True
        self.log("MIT-BIH replay: real beats from DS2 test patients through the firmware emulation "
                 "(PhysioNet, ODC-By). Annotations shown as ground truth.", "ok")
        self._run_paced(stop, self._replay_samples())

    def _replay_samples(self):
        order = {"normal": 0, "abnormal": 0}
        kind = "normal"
        while True:
            with self.lock:
                if not self.auto:
                    kind = "normal" if self.normal else "abnormal"
                self.replay_switch = False
            pool = [c for c in self.replay_clips if c["kind"] == kind]
            clip = pool[order[kind] % len(pool)]
            order[kind] += 1
            with self.lock:
                self.replay_clip = clip
            self.log(f"Replaying MIT-BIH record {clip['record']} ({kind} clip, {len(clip['beats'])} beats)")
            self.publish_status()
            for i, v in enumerate(clip["wave"]):
                if self.replay_switch:
                    break
                b = clip["beats"].get(i)
                beat = None
                if b:
                    beat = dict(bpm=b["bpm"], P=b["P"], Q=b["Q"], R=b["R"], S=b["S"], device=b["device"],
                                ms=int(time.time() * 1000), scenario=f"MIT-BIH {clip['record']} {b['sym']}",
                                truth=dict(sym=b["sym"], aami=AAMI_CLASS.get(b["sym"], "?"),
                                           abnormal=AAMI_CLASS.get(b["sym"]) != "N", record=clip["record"]))
                yield v, beat
            if self.auto:                                   # auto: alternate normal and abnormal clips
                kind = "abnormal" if kind == "normal" else "normal"

    def _synthetic_samples(self):
        t = 0.0
        while True:
            normal = self._next_scenario()
            f = synthetic_features(normal)
            samples, r_idx = synthetic_beat(f, normal, t)
            t += len(samples) / FS_STREAM
            beat = dict(bpm=round(f["bpm"]), P=f["P"], Q=f["Q"], R=f["R"], S=f["S"],
                        device="SIMULATED", ms=int(time.time() * 1000),
                        scenario="NORMAL DEMO" if normal else "ABNORMAL DEMO")
            for i, v in enumerate(samples):
                yield v, (beat if i == r_idx else None)

    def _next_scenario(self):
        with self.lock:
            if not self.auto:
                return self.normal
            self.episode_left -= 1
            if self.episode_left > 0:
                return self.normal
            if self.normal and random.random() < 0.35:
                self.normal = False
                self.episode_left = random.randint(4, 8)
                msg = "Synthetic event: abnormal episode started"
            else:
                was_abnormal = not self.normal
                self.normal = True
                self.episode_left = random.randint(10, 18)
                msg = "Synthetic event: rhythm back to normal" if was_abnormal else None
        if msg:
            self.log(msg, "warn" if "abnormal" in msg else "ok")
            self.publish_status()
        return self.normal

    def _run_live(self, stop):
        if serial is None:
            self._live_fail("pyserial is not installed (pip install pyserial)")
            return
        port = self.port or auto_port()
        if not port:
            self._live_fail("No serial ports found. Is the Arduino plugged in?")
            return
        with self.lock:
            self.port = port
        self.log(f"Opening {port} @ 115200 ...")
        try:
            ser = serial.Serial(port, 115200, timeout=0.1)
        except Exception as e:
            self._live_fail(f"Could not open {port}: {e}. Is the board plugged in and the Arduino Serial Monitor closed?")
            return
        with ser:
            stop.wait(2.0)                        # UNO resets when the port opens
            ser.reset_input_buffer()
            with self.lock:
                self.ser = ser
                self.connected = True
                self.dev_mode, self.calibrated = "LIVE", False
            ser.write(b"s")                       # firmware streams "D," off by default
            self.log(f"Connected to {port}. Press Calibrate on a clean live beat.", "ok")
            self.set_recording(True)              # live sessions are always worth keeping
            self.publish_status()
            buf, chunk, last_flush = b"", [], time.perf_counter()
            while not stop.is_set():
                try:
                    buf += ser.read(ser.in_waiting or 1)
                except Exception as e:
                    self._live_fail(f"Serial error: {e}")
                    break
                while b"\n" in buf:
                    raw, buf = buf.split(b"\n", 1)
                    line = raw.decode("ascii", "ignore").strip()
                    if line.startswith("D,"):
                        try:
                            chunk.append(round(int(line[2:]) * Q4_TO_MV, 4))
                        except ValueError:
                            pass
                    else:
                        self._live_line(line)
                if chunk and time.perf_counter() - last_flush > 0.04:
                    self._push_wave(chunk)
                    chunk, last_flush = [], time.perf_counter()
            with self.lock:
                self.ser = None
                self.connected = False
        self.publish_status()

    def _live_fail(self, msg):
        with self.lock:
            self.error = msg
            self.connected = False
        self.log(msg, "error")
        self.publish_status()

    def _live_line(self, line):
        if line.startswith("A,"):
            parts = line.split(",")[1:]
            if len(parts) == 6:
                self.log("analog scan  " + "  ".join(f"A{i}={v}" for i, v in enumerate(parts)))
            return
        if line.startswith("#"):
            changed = True
            if "CALIBRATED." in line and "failed" not in line:
                self.calibrated = True
            elif "reset (calibration cleared)" in line:
                self.calibrated = False
            elif line.startswith("# mode "):
                self.dev_mode = line.split("# mode ", 1)[1].strip()
            elif line.startswith("# stream "):
                self.stream_on = line.endswith("ON")
            else:
                changed = False
            level = "warn" if ("UNCALIBRATED" in line or "failed" in line) else "info"
            if "^ UNCALIBRATED" not in line:      # one per beat - too chatty for the log
                self.log(line[1:].strip(), level)
            if changed:
                self.publish_status()
            return
        if line.startswith("B,"):
            f = line.split(",")
            if len(f) != 8:
                return
            try:
                ms, bpm = int(f[1]), int(f[2])
                P, Q, R, S = (float(x) for x in f[3:7])
            except ValueError:
                return
            self.stream_on = True
            self.on_beat(bpm=bpm, P=P, Q=Q, R=R, S=S, device=f[7], ms=ms,
                         scenario=self.dev_mode)

    # ----------------------------------------------------------- beats
    def on_beat(self, bpm, P, Q, R, S, device, ms, scenario, truth=None):
        args = dict(bpm=bpm, P=P, Q=Q, R=R, S=S, device=device, ms=ms, scenario=scenario, truth=truth)
        if self.snn and self.snn_classifies:
            if time.time() - self.last_wave_t < 1.0 and self._snn_queue_beat(args):
                return                                  # classified once its window has arrived
            if not self.warned_no_wave:
                self.warned_no_wave = True
                self.log("SNN needs the waveform stream (press Stream); using the Random Forest meanwhile", "warn")
            self._finish_beat(**args, via="Random Forest (no waveform)")
            return
        beat = self._finish_beat(**args, via="Random Forest")
        if self.snn:                                    # preview: show spiking activity only
            self._snn_queue_beat(dict(args, beat=beat))

    def _finish_beat(self, bpm, P, Q, R, S, device, ms, scenario, label=None, conf=None,
                     lag=None, via="Random Forest", beat=None, truth=None):
        if label is None:
            label, conf = self.clf.classify(P, Q, R)
        verdict = label or device
        abnormal = str(verdict).upper().startswith("ABNORM")
        uncal = self.source == "live" and self.dev_mode == "LIVE" and not self.calibrated
        with self.lock:
            self.n_beats += 1
            self.n_abnormal += abnormal
            self.streak = self.streak + 1 if abnormal else 0
            was_alarm = self.alarm
            # same 3-consecutive-beat confirmation the firmware uses
            if self.streak >= 3:
                self.alarm = True
            elif not abnormal:
                self.alarm = False
            beat = dict(n=self.n_beats, t=time.time(), ms=ms, bpm=bpm,
                        P=round(P, 4), Q=round(Q, 4), R=round(R, 4), S=round(S, 4),
                        device=device, model=label, conf=conf and round(conf, 3),
                        abnormal=abnormal, uncal=uncal, scenario=scenario,
                        source=self.source.upper(), via=via, lag=lag, truth=truth)
            self.beats.append(beat)
            if self.rec_writer:
                self.rec_writer.writerow([
                    datetime.now().isoformat(timespec="seconds"),
                    {"synthetic": "SYNTHETIC", "replay": "MIT-BIH REPLAY"}.get(self.source, "LIVE SENSOR"),
                    scenario, ms, bpm, f"{P:.4f}", f"{Q:.4f}", f"{R:.4f}", f"{S:.4f}",
                    device, label or "", f"{conf:.3f}" if conf else "",
                    "yes" if uncal else ""])
                self.rec_file.flush()
        self.hub.publish({"type": "beat", "beat": beat})
        if self.alarm != was_alarm:
            self.log("ALARM: 3 consecutive abnormal beats confirmed" if self.alarm
                     else "Alarm cleared - rhythm classified normal", "error" if self.alarm else "ok")
            self.publish_status()
        return beat

    # ----------------------------------------------------------- control
    def command(self, cmd):
        if cmd == "clear":
            self.reset_stats()
            return "dashboard counters cleared"
        if self.source in ("synthetic", "replay"):
            with self.lock:
                self.replay_switch = self.source == "replay"
                if cmd == "n":
                    self.auto, self.normal = False, True
                elif cmd == "a":
                    self.auto, self.normal = False, False
                elif cmd == "x":
                    self.auto, self.normal = True, True
                    self.episode_left = random.randint(6, 10)
                elif cmd == "r":
                    pass
                else:
                    return f"'{cmd}' is a live-device command"
            if cmd == "r":
                self.reset_stats()
            label = {"n": "manual NORMAL", "a": "manual ABNORMAL",
                     "x": "automatic episodes", "r": "reset"}[cmd]
            self.log(f"Synthetic scenario: {label}")
            self.publish_status()
            return label
        if cmd not in "tscbrdh?" or len(cmd) != 1:
            return f"unknown command '{cmd}'"
        with self.lock:
            ser = self.ser
        if ser is None:
            return "not connected"
        try:
            ser.write(cmd.encode("ascii"))
        except Exception as e:
            return f"send failed: {e}"
        return f"sent '{cmd}'"

    def set_model_kind(self, kind, announce=True):
        """Switch the classifier at runtime: the Random Forest, or the SNN."""
        if kind == "snn-preview":
            kind = "snn"
        if kind not in ("rf", "snn"):
            return False
        snn, classifies = None, False
        if kind == "snn":
            if self.trained_snn is not None:
                snn, classifies = self.trained_snn, True
            else:
                from snn_preview import PreviewSNN
                snn = PreviewSNN()
        with self.lock:
            changed = kind != self.model_kind
            pending = self.snn_pending
            self.model_kind, self.snn, self.snn_classifies = kind, snn, classifies
            self.snn_pending, self.snn_last, self.warned_no_wave = [], None, False
        for item in pending:                            # don't drop beats waiting for the old model
            if "beat" not in item["args"]:
                self._finish_beat(**item["args"])
        if announce and changed:
            if kind == "rf":
                self.log("Model: Random Forest", "ok")
            elif classifies:
                self.log("Model: trained SNN - each verdict arrives about 0.4 s after its beat", "ok")
            else:
                self.log(f"Model: SNN preview ({self.snn_error}); verdicts from the Random Forest", "warn")
            self.publish_status()
        return True

    def set_recording(self, on):
        with self.lock:
            if on and not self.rec_writer:
                self.rec_name = f"session_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
                self.rec_file = open(os.path.join(HERE, self.rec_name), "w", newline="")
                self.rec_writer = csv.writer(self.rec_file)
                self.rec_writer.writerow(LOG_HEADER)
                self.rec_file.flush()
                msg = f"Recording to {self.rec_name}"
            elif not on and self.rec_writer:
                self.rec_file.close()
                msg = f"Saved {self.rec_name}"
                self.rec_file = self.rec_writer = self.rec_name = None
            else:
                return
        self.log(msg, "ok")
        self.publish_status()


def auto_port():
    ports = list(list_ports.comports()) if list_ports else []
    if not ports:
        return None
    keys = ("usb", "acm", "wch", "ch340", "arduino")
    ports.sort(key=lambda p: any(k in (p.device + str(p.description)).lower() for k in keys),
               reverse=True)
    return ports[0].device


# --------------------------------------------------------------- sessions
def _num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def read_session(name):
    rows = []
    with open(os.path.join(HERE, name), newline="") as fh:
        for r in csv.DictReader(fh):
            rows.append(dict(
                timestamp=r.get("timestamp"), source=r.get("source") or "LIVE SENSOR",
                scenario=r.get("scenario") or "", bpm=_num(r.get("bpm")),
                P=_num(r.get("P_mV")), Q=_num(r.get("Q_mV")), R=_num(r.get("R_mV")),
                S=_num(r.get("S_mV")), device=r.get("device_verdict") or "",
                model=r.get("model_verdict") or "", conf=_num(r.get("model_conf")),
                uncal=(r.get("uncalibrated") or "") == "yes"))
    return rows


def summarize(name):
    rows = read_session(name)
    hr = [r["bpm"] for r in rows if r["bpm"]]
    abn = sum(1 for r in rows if (r["model"] or r["device"]).upper().startswith("ABNORM"))
    return dict(name=name, beats=len(rows),
                start=rows[0]["timestamp"] if rows else None,
                end=rows[-1]["timestamp"] if rows else None,
                sources=sorted({r["source"] for r in rows}),
                avg_bpm=round(sum(hr) / len(hr), 1) if hr else None,
                abnormal=abn,
                uncal=sum(1 for r in rows if r["uncal"]),
                size=os.path.getsize(os.path.join(HERE, name)))


def list_sessions():
    names = sorted((f for f in os.listdir(HERE) if SESSION_RE.match(f)), reverse=True)
    out = []
    for n in names:
        try:
            out.append(summarize(n))
        except Exception as e:
            out.append(dict(name=n, error=str(e)))
    return out


def model_info(clf):
    import pandas as pd
    df = pd.read_csv(os.path.join(HERE, "data.csv"))
    info = dict(ready=clf.ready, error=clf.error, features=FEATURES,
                rows=df[FEATURES + ["Label"]].round(4).values.tolist(),
                ranges={lab: {f: [round(float(g[f].min()), 3), round(float(g[f].max()), 3)]
                              for f in FEATURES}
                        for lab, g in df.groupby("Label")},
                counts=df["Label"].value_counts().to_dict())
    if clf.ready:
        info.update(classes=[str(c) for c in clf.le.classes_],
                    n_estimators=int(getattr(clf.model, "n_estimators", 0)),
                    importances=dict(zip(FEATURES, [round(float(v), 3) for v in
                                                    clf.model.feature_importances_])))
    return info


# --------------------------------------------------------------- http
CTYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
          ".js": "application/javascript; charset=utf-8", ".png": "image/png",
          ".svg": "image/svg+xml", ".csv": "text/csv; charset=utf-8"}


def make_handler(engine, clf, hub):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):          # keep the terminal for the engine
            pass

        def _cors(self):
            origin = self.headers.get("Origin") or ""
            if LOCAL_ORIGIN_RE.match(origin):
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")

        def do_OPTIONS(self):
            self.send_response(204)
            self._cors()
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def _send(self, code, body, ctype="application/json", extra=None):
            if isinstance(body, (dict, list)):
                body = json.dumps(body).encode()
            elif isinstance(body, str):
                body = body.encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self._cors()
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def _file(self, path, download=None):
            if not os.path.isfile(path):
                return self._send(404, {"error": "not found"})
            with open(path, "rb") as fh:
                data = fh.read()
            extra = {"Content-Disposition": f'attachment; filename="{download}"'} if download else None
            self._send(200, data, CTYPES.get(os.path.splitext(path)[1], "application/octet-stream"), extra)

        def _json_body(self):
            n = int(self.headers.get("Content-Length") or 0)
            try:
                return json.loads(self.rfile.read(n) or b"{}")
            except ValueError:
                return {}

        def do_GET(self):
            path = unquote(urlparse(self.path).path)
            if path == "/":
                return self._file(os.path.join(WEB, "index.html"))
            if path.startswith("/static/"):
                name = os.path.basename(path)
                return self._file(os.path.join(WEB, name))
            if path == "/docs/flow.png":
                return self._file(os.path.join(DOCS, "NeuroCardio_Firmware_Flow.png"))
            if path == "/api/stream":
                return self._stream()
            if path == "/api/state":
                return self._send(200, engine.snapshot())
            if path == "/api/ports":
                ports = [dict(device=p.device, description=p.description)
                         for p in (list_ports.comports() if list_ports else [])]
                return self._send(200, {"ports": ports, "pyserial": serial is not None})
            if path == "/api/model":
                return self._send(200, model_info(clf))
            if path == "/api/sessions":
                return self._send(200, list_sessions())
            if path.startswith("/api/sessions/"):
                name = os.path.basename(path)
                if not SESSION_RE.match(name) or not os.path.isfile(os.path.join(HERE, name)):
                    return self._send(404, {"error": "no such session"})
                if self.path.endswith("?download"):
                    return self._file(os.path.join(HERE, name), download=name)
                return self._send(200, {"summary": summarize(name), "rows": read_session(name)})
            self._send(404, {"error": "not found"})

        def do_POST(self):
            path = urlparse(self.path).path
            body = self._json_body()
            if path == "/api/command":
                return self._send(200, {"result": engine.command(str(body.get("cmd", "")))})
            if path == "/api/source":
                mode = body.get("mode")
                if mode not in ("live", "synthetic", "replay"):
                    return self._send(400, {"error": "mode must be live, synthetic or replay"})
                engine.start(mode, body.get("port") or None)
                return self._send(200, engine.status())
            if path == "/api/model-kind":
                if not engine.set_model_kind(body.get("kind")):
                    return self._send(400, {"error": "kind must be rf or snn-preview"})
                return self._send(200, engine.status())
            if path == "/api/record":
                engine.set_recording(bool(body.get("on")))
                return self._send(200, engine.status())
            if path == "/api/predict":
                try:
                    p, q, r = (float(body[k]) for k in FEATURES)
                except (KeyError, TypeError, ValueError):
                    return self._send(400, {"error": "P, Q and R must be numbers"})
                pr = clf.proba(p, q, r)
                if pr is None:
                    return self._send(503, {"error": "model not loaded - run train_model.py"})
                label = max(pr, key=pr.get)
                return self._send(200, {"label": label, "confidence": pr[label], "proba": pr})
            self._send(404, {"error": "not found"})

        def _stream(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "keep-alive")
            self._cors()
            self.end_headers()
            q = hub.subscribe()
            try:
                hello = json.dumps({"type": "hello", **engine.snapshot()})
                self.wfile.write(f"data: {hello}\n\n".encode())
                self.wfile.flush()
                while True:
                    try:
                        data = q.get(timeout=15)
                        msg = f"data: {data}\n\n"
                    except queue.Empty:
                        msg = ": ping\n\n"
                    self.wfile.write(msg.encode())
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
                pass
            finally:
                hub.unsubscribe(q)
                self.close_connection = True

    return Handler


def main():
    ap = argparse.ArgumentParser(description="NeuroCardio web dashboard")
    ap.add_argument("--port", help="start on the live Arduino at this serial port (e.g. COM5)")
    ap.add_argument("--live", action="store_true", help="start live, auto-detecting the port")
    ap.add_argument("--http", type=int, default=8050, help="dashboard port (default 8050)")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--model", choices=["rf", "snn", "snn-preview"], default="rf",
                    help="classifier at start-up: rf (Random Forest) or snn (trained spiking "
                         "network); it can also be switched from the dashboard")
    a = ap.parse_args()

    clf, hub = Classifier(), Hub()
    engine = Engine(clf, hub, a.model)

    # On Windows SO_REUSEADDR lets a second server silently share the port, so
    # two dashboards would split the browser's requests between them.
    class Server(ThreadingHTTPServer):
        allow_reuse_address = os.name != "nt"
        daemon_threads = True

    try:
        srv = Server((a.host, a.http), make_handler(engine, clf, hub))
    except OSError:
        raise SystemExit(f"Port {a.http} is already in use - is another dashboard running? "
                         f"Stop it, or start this one with --http <other port>.")

    if a.model != "rf" and engine.trained_snn is None:
        print(f"SNN preview only: {engine.snn_error}")
    engine.start("live" if (a.port or a.live) else "synthetic", a.port)
    url = f"http://{'127.0.0.1' if a.host in ('0.0.0.0', '') else a.host}:{a.http}"
    print(f"NeuroCardio dashboard running at {url}   (Ctrl+C to stop)")
    if not a.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        engine.stop()
        engine.set_recording(False)
        srv.server_close()
        print("Stopped.")


if __name__ == "__main__":
    main()
