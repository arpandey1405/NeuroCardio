"""
NeuroCardio - host-side monitor

Reads the Arduino serial stream, prints every detected beat in the terminal,
runs the trained Random Forest on each beat's (P, Q, R) feature vector, logs
everything to CSV, and (optionally) draws a live ECG strip.

RUN
    python train_model.py          # once, creates models/
    python host_monitor.py         # auto-detects the port, opens the plot
    python host_monitor.py --noplot            # terminal only
    python host_monitor.py --port COM5         # force a port
    python host_monitor.py --list              # show available ports

FIRST TIME ON A LIVE PERSON: calibrate before you trust the result.
    1. Make sure mode is LIVE (press t until the LCD's top-right corner is
       blank / the terminal says "# mode LIVE").
    2. Wait for a clean, steady beat, then press c.
    3. Until you do this, beats are tagged UNCALIBRATED and the on-device
       alarm stays silent - the numbers can be right but scaled wrong, which
       is normal for any uncalibrated amplifier, not a fault.

SERIAL PROTOCOL (from the sketch)
    D,<int>                                   waveform sample, 100 Hz
    A,<a0>,<a1>,<a2>,<a3>,<a4>,<a5>            analog-pin finder ('d')
    B,<ms>,<bpm>,<P>,<Q>,<R>,<S>,<result>     one line per detected beat
    #...                                      informational / status

KEYBOARD (in the plot window, or type+Enter with --noplot)
    t  cycle LIVE / SIM-NORMAL / SIM-ABNORMAL
    c  calibrate (do this first, on a clean live beat)
    d  analog-pin finder - shows which pin is actually pulsing
    h  human-readable debug line (raw ADC, filtered mV, detector state)
    s  toggle raw waveform streaming
    b  toggle per-beat beep
    r  reset (also clears calibration)
    q  quit
"""

import argparse
import csv
import os
import sys
import threading
import time
from collections import deque
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
Q4_TO_MV = 0.00122075          # must match Q4_TO_MV_BASE in the sketch
FS_STREAM = 100                # the sketch decimates the stream to 100 Hz
WINDOW_S = 6

try:
    import serial
    from serial.tools import list_ports
except ImportError:
    sys.exit("pyserial is missing.  pip install pyserial")


# --------------------------------------------------------------- model
def load_model():
    try:
        import joblib
        import pandas as pd  # noqa: F401  (needed for the DataFrame call below)
        m = joblib.load(os.path.join(HERE, "models", "rf_model.joblib"))
        le = joblib.load(os.path.join(HERE, "models", "label_encoder.joblib"))
        print("Model loaded: RandomForest on (P, Q, R)")
        return m, le
    except Exception as e:
        print(f"[warn] model not loaded ({e}); showing firmware verdict only")
        print("[warn] run  python train_model.py  first")
        return None, None


def classify(model, le, p, q, r):
    if model is None:
        return None, None
    import pandas as pd
    proba = model.predict_proba(pd.DataFrame([[p, q, r]], columns=["P", "Q", "R"]))[0]
    return le.classes_[proba.argmax()], float(proba.max())


# --------------------------------------------------------------- port
def pick_port(explicit=None):
    ports = list(list_ports.comports())
    if explicit:
        return explicit
    if not ports:
        sys.exit("No serial ports found. Is the Arduino plugged in?")
    ranked = sorted(
        ports,
        key=lambda p: (
            "usb" in (p.device + str(p.description)).lower()
            or "acm" in p.device.lower()
            or "wch" in str(p.description).lower()
            or "ch340" in str(p.description).lower()
            or "arduino" in str(p.description).lower()
        ),
        reverse=True,
    )
    print(f"Using port {ranked[0].device}  ({ranked[0].description})")
    return ranked[0].device


# --------------------------------------------------------------- state
class Monitor:
    def __init__(self, model, le, logpath):
        self.wave = deque([0.0] * (WINDOW_S * FS_STREAM), maxlen=WINDOW_S * FS_STREAM)
        self.model, self.le = model, le
        self.lock = threading.Lock()
        self.latest = dict(bpm=0, P=0.0, Q=0.0, R=0.0, S=0.0,
                           device="--", host="--", conf=0.0, beats=0,
                           uncal=False)
        self.running = True
        self.ser = None                       # set in main(), used to send commands
        self.sim_mode = "LIVE"                # tracked from the sketch's own "# mode" lines
        self.sim_calibrated = False           # tracked from "# CALIBRATED." lines
        self.log = open(logpath, "w", newline="")
        self.csv = csv.writer(self.log)
        self.csv.writerow(["timestamp", "arduino_ms", "bpm",
                           "P_mV", "Q_mV", "R_mV", "S_mV",
                           "device_verdict", "model_verdict", "model_conf",
                           "uncalibrated"])

    def send(self, ch):
        """Forward a one-letter command to the Arduino."""
        if self.ser is not None:
            try:
                self.ser.write(ch.encode("ascii"))
            except Exception as e:
                print(f"[serial] could not send '{ch}': {e}")

    def handle(self, line):
        if line.startswith("D,"):
            try:
                with self.lock:
                    self.wave.append(int(line[2:]) * Q4_TO_MV)
            except ValueError:
                pass
            return

        if line.startswith("A,"):                 # analog-pin finder output
            parts = line.split(",")[1:]
            if len(parts) == 6:
                cols = "  ".join(f"A{i}={v:>4}" for i, v in enumerate(parts))
                print(f"  analog scan | {cols}   <- the pin that PULSES is your ECG pin")
            return

        if line.startswith("#"):
            # track calibration + mode purely from the sketch's own status lines,
            # so we don't have to guess whether a warning belongs to this beat
            if "CALIBRATED." in line and "failed" not in line:
                self.sim_calibrated = True
            elif "reset (calibration cleared)" in line:
                self.sim_calibrated = False
            elif line.startswith("# mode "):
                self.sim_mode = line.split("# mode ", 1)[1].strip()
            print(f"  \033[90m{line}\033[0m")
            return

        if not line.startswith("B,"):
            return

        f = line.split(",")
        if len(f) != 8:
            return
        try:
            ms, bpm = int(f[1]), int(f[2])
            P, Q, R, S = (float(x) for x in f[3:7])
        except ValueError:
            return
        device = f[7]
        host, conf = classify(self.model, self.le, P, Q, R)
        uncal = (self.sim_mode == "LIVE" and not self.sim_calibrated)

        with self.lock:
            self.latest.update(bpm=bpm, P=P, Q=Q, R=R, S=S, device=device,
                               host=host or "--", conf=conf or 0.0,
                               beats=self.latest["beats"] + 1, uncal=uncal)
            n = self.latest["beats"]

        verdict = (host or device)
        flag = "\033[91m" if verdict.upper().startswith("ABNORM") else "\033[92m"
        uncal_tag = "  \033[93m[UNCALIBRATED - press c]\033[0m" if uncal else ""
        print(f"beat {n:4d} | HR {bpm:3d} bpm | "
              f"P {P:+.3f}  Q {Q:+.3f}  R {R:+.3f}  S {S:+.3f} mV | "
              f"device: {device:8s} | model: {flag}{host or '--'}\033[0m"
              + (f" ({conf:.2f})" if conf else "") + uncal_tag)

        self.csv.writerow([datetime.now().isoformat(timespec="seconds"), ms, bpm,
                           f"{P:.4f}", f"{Q:.4f}", f"{R:.4f}", f"{S:.4f}",
                           device, host or "", f"{conf:.3f}" if conf else "",
                           "yes" if uncal else ""])
        self.log.flush()

    def reader(self, ser):
        buf = b""
        while self.running:
            try:
                buf += ser.read(ser.in_waiting or 1)
            except Exception as e:
                print(f"[serial] {e}")
                break
            while b"\n" in buf:
                raw, buf = buf.split(b"\n", 1)
                self.handle(raw.decode("ascii", "ignore").strip())

    def close(self):
        self.running = False
        self.log.close()


# --------------------------------------------------------------- plot
def run_plot(mon):
    import matplotlib.pyplot as plt
    from matplotlib.animation import FuncAnimation

    fig, ax = plt.subplots(figsize=(11, 4.5))
    fig.canvas.manager.set_window_title("NeuroCardio - live ECG")
    t = [i / FS_STREAM for i in range(WINDOW_S * FS_STREAM)]
    (ln,) = ax.plot(t, list(mon.wave), lw=1.2, color="#c62828")
    ax.set_xlim(0, WINDOW_S)
    ax.set_ylim(-1.0, 2.0)
    ax.set_xlabel("time (s)")
    ax.set_ylabel("amplitude (mV)")
    ax.grid(True, which="both", lw=0.4, alpha=0.5)
    ax.set_title("NeuroCardio ECG front-end")
    txt = ax.text(0.012, 0.96, "", transform=ax.transAxes, va="top",
                  family="monospace", fontsize=10,
                  bbox=dict(fc="white", ec="#bbb", alpha=0.9))

    def update(_):
        with mon.lock:
            y = list(mon.wave)
            d = dict(mon.latest)
        ln.set_ydata(y)
        if y:
            lo, hi = min(y), max(y)
            pad = max(0.3, (hi - lo) * 0.25)
            ax.set_ylim(lo - pad, hi + pad)
        txt.set_text(
            f"HR      {d['bpm']:3d} bpm\n"
            f"P       {d['P']:+.3f} mV\n"
            f"Q       {d['Q']:+.3f} mV\n"
            f"R       {d['R']:+.3f} mV\n"
            f"device  {d['device']}\n"
            f"model   {d['host']} {('%.2f' % d['conf']) if d['conf'] else ''}\n"
            f"beats   {d['beats']}"
            + ("\nUNCALIBRATED - press c" if d.get("uncal") else "")
        )
        if d.get("uncal"):
            txt.set_color("#b8860b")
        else:
            txt.set_color("#b71c1c" if d["host"].upper().startswith("ABNORM") else "#1b5e20")
        return ln, txt

    def on_key(e):
        if e.key == "q":
            plt.close(fig)
        elif e.key in ("t", "s", "b", "c", "r", "d", "h", "?"):
            mon.send(e.key)

    fig.canvas.mpl_connect("key_press_event", on_key)
    fig.text(0.5, 0.01,
             "keys:  t test-signal   c calibrate (do this first!)   "
             "d find-ECG-pin   h readable-debug   s stream   b beep   "
             "r reset   q quit",
             ha="center", fontsize=8, color="#666")
    _anim = FuncAnimation(fig, update, interval=50, blit=False,
                          cache_frame_data=False)
    plt.tight_layout()
    plt.show()


# --------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--noplot", action="store_true")
    ap.add_argument("--list", action="store_true")
    a = ap.parse_args()

    if a.list:
        for p in list_ports.comports():
            print(f"{p.device:20s} {p.description}")
        return

    model, le = load_model()
    port = pick_port(a.port)
    logname = os.path.join(
        HERE, f"session_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv")
    mon = Monitor(model, le, logname)

    with serial.Serial(port, a.baud, timeout=0.1) as ser:
        time.sleep(2.0)                       # UNO resets when the port opens
        ser.reset_input_buffer()
        mon.ser = ser
        ser.write(b"s")                       # firmware streams "D," off by default;
                                               # turn it on so the plot has data
        print(f"Connected. Logging to {os.path.basename(logname)}")
        print("Commands: t=test-signal  c=CALIBRATE (do this first in LIVE mode)  "
              "d=find-ECG-pin  h=readable-debug  s=stream  b=beep  r=reset")
        if a.noplot:
            print("Type a command letter here and press Enter (q to quit).\n")
        else:
            print("Click the plot window, then press t / c / d / h / s / b / r  (q quits).\n")

        th = threading.Thread(target=mon.reader, args=(ser,), daemon=True)
        th.start()
        try:
            if a.noplot:
                while mon.running:
                    line = sys.stdin.readline()
                    if not line:
                        time.sleep(0.2)
                        continue
                    cmd = line.strip()[:1]
                    if cmd == "q":
                        break
                    if cmd:
                        mon.send(cmd)
            else:
                run_plot(mon)
        except KeyboardInterrupt:
            pass
        finally:
            mon.close()
            print(f"\nSaved {logname}")


if __name__ == "__main__":
    main()
