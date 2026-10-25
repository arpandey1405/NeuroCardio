"""
NeuroCardio - host-side monitor
LIVE sensor + SYNTHETIC DEMO mode

LIVE mode:
    Reads Arduino serial stream, runs the deployed Random Forest on P/Q/R,
    logs beats, and displays the ECG strip.

SYNTHETIC mode:
    Does NOT require Arduino, sensors, or a serial port.
    Generates a continuously scrolling ECG-like waveform, synthetic P/Q/R/S
    features, BPM, and runs the SAME deployed Random Forest classifier.

Run:
    python host_monitor_synthetic_demo.py
        -> asks whether to use LIVE SENSOR or SYNTHETIC DEMO

    python host_monitor_synthetic_demo.py --synthetic
        -> start directly in synthetic demo mode

    python host_monitor_synthetic_demo.py --port COM5
        -> force LIVE mode on COM5

    python host_monitor_synthetic_demo.py --noplot
        -> terminal mode

Synthetic demo controls (plot window):
    n = synthetic NORMAL beat
    a = synthetic ABNORMAL beat
    v = toggle NORMAL/ABNORMAL synthetic scenario
    s = toggle waveform streaming (LIVE only)
    c = calibrate (LIVE only)
    d = analog-pin finder (LIVE only)
    h = debug (LIVE only)
    b = beep (LIVE only)
    r = reset
    q = quit

IMPORTANT:
    Synthetic mode is for demonstration/testing of the software pipeline.
    It is NOT real patient data and must not be interpreted as a medical
    measurement or diagnosis.
"""

import argparse
import csv
import math
import os
import sys
import random
import threading
import time
from collections import deque
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
Q4_TO_MV = 0.00122075
FS_STREAM = 100
WINDOW_S = 6

try:
    import serial
    from serial.tools import list_ports
except ImportError:
    serial = None
    list_ports = None


# --------------------------------------------------------------- model
def load_model():
    try:
        import joblib
        import pandas as pd  # noqa: F401
        model_path = os.path.join(HERE, "models", "rf_model.joblib")
        label_path = os.path.join(HERE, "models", "label_encoder.joblib")

        m = joblib.load(model_path)
        le = joblib.load(label_path)

        print("Model loaded: RandomForest on (P, Q, R)")
        return m, le

    except Exception as e:
        print(f"[warn] model not loaded ({e})")
        print("[warn] run train_model.py first")
        return None, None


def classify(model, le, p, q, r):
    if model is None or le is None:
        return None, None

    import pandas as pd

    X = pd.DataFrame(
        [[p, q, r]],
        columns=["P", "Q", "R"]
    )

    proba = model.predict_proba(X)[0]
    idx = proba.argmax()

    return le.classes_[idx], float(proba[idx])


# --------------------------------------------------------------- serial port
def pick_port(explicit=None):
    if list_ports is None:
        sys.exit("pyserial is missing. Install it with: pip install pyserial")

    ports = list(list_ports.comports())

    if explicit:
        return explicit

    if not ports:
        sys.exit("No serial ports found. Use --synthetic for sensor-free demo.")

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

    print(f"Using port {ranked[0].device} ({ranked[0].description})")
    return ranked[0].device


# --------------------------------------------------------------- synthetic ECG
def gaussian(x, center, width):
    return math.exp(-0.5 * ((x - center) / width) ** 2)


def synthetic_beat(normal=True, samples=100, bpm=None):
    """
    Generate a continuously varying ECG-like beat.

    This is a demo waveform, not a physiological simulator.
    Beat-to-beat amplitude, baseline, timing and noise vary slightly so
    the display looks like a real streaming signal rather than a repeated
    static template.
    """
    if bpm is None:
        bpm = random.uniform(62, 82) if normal else random.uniform(88, 118)

    # Small beat-to-beat variability.
    scale = random.uniform(0.94, 1.06) if normal else random.uniform(0.82, 1.15)
    baseline_offset = random.uniform(-0.025, 0.025)
    noise_level = random.uniform(0.006, 0.018)

    if normal:
        p_amp = 0.11 * scale
        q_amp = -0.15 * scale
        r_amp = random.uniform(0.86, 1.08) * scale
        s_amp = -0.27 * scale
        t_amp = random.uniform(0.25, 0.34) * scale

        # Slight beat-to-beat timing variation.
        p_pos = random.uniform(0.18, 0.22)
        q_pos = random.uniform(0.355, 0.375)
        r_pos = random.uniform(0.39, 0.41)
        s_pos = random.uniform(0.42, 0.445)
        t_pos = random.uniform(0.64, 0.71)
    else:
        p_amp = random.uniform(0.015, 0.07)
        q_amp = random.uniform(-0.34, -0.20)
        r_amp = random.uniform(0.50, 0.85)
        s_amp = random.uniform(-0.58, -0.35)
        t_amp = random.uniform(0.04, 0.16)

        p_pos = random.uniform(0.17, 0.23)
        q_pos = random.uniform(0.345, 0.38)
        r_pos = random.uniform(0.385, 0.415)
        s_pos = random.uniform(0.42, 0.455)
        t_pos = random.uniform(0.60, 0.74)

    beat = []

    for i in range(samples):
        x = i / samples

        # Slow baseline wander.
        baseline = (
            baseline_offset
            + 0.018 * math.sin(2 * math.pi * x + random.uniform(-0.04, 0.04))
        )

        p = p_amp * gaussian(x, p_pos, 0.035)
        q = q_amp * gaussian(x, q_pos, 0.012)
        r = r_amp * gaussian(x, r_pos, 0.009)
        s = s_amp * gaussian(x, s_pos, 0.013)
        t = t_amp * gaussian(x, t_pos, 0.075)

        # Tiny measurement noise.
        noise = random.gauss(0, noise_level)

        beat.append(baseline + p + q + r + s + t + noise)

    return beat, bpm


def synthetic_features(normal=True):
    """
    Generate varying P/Q/R/S values.

    The classifier still receives the same P/Q/R interface as the deployed
    Random Forest. Values vary on every beat to make the demo realistic.
    """
    if normal:
        P = random.uniform(0.075, 0.145)
        Q = random.uniform(-0.195, -0.125)
        R = random.uniform(0.82, 1.12)
        S = random.uniform(-0.34, -0.21)
    else:
        P = random.uniform(0.00, 0.075)
        Q = random.uniform(-0.36, -0.20)
        R = random.uniform(0.45, 0.84)
        S = random.uniform(-0.62, -0.34)

    return P, Q, R, S


# --------------------------------------------------------------- state
class Monitor:
    def __init__(self, model, le, logpath, synthetic=False):
        self.wave = deque(
            [0.0] * (WINDOW_S * FS_STREAM),
            maxlen=WINDOW_S * FS_STREAM
        )

        self.model = model
        self.le = le

        self.lock = threading.Lock()

        self.latest = dict(
            bpm=0,
            P=0.0,
            Q=0.0,
            R=0.0,
            S=0.0,
            device="--",
            host="--",
            conf=0.0,
            beats=0,
            uncal=False,
            source="LIVE SENSOR",
            scenario="--"
        )

        self.running = True
        self.ser = None

        self.sim_mode = "LIVE"
        self.sim_calibrated = False

        self.synthetic = synthetic
        self.synthetic_normal = True

        # Automatic synthetic episodes:
        # several normal beats followed by a short abnormal episode.
        # This makes the demo look like a monitoring system that can
        # encounter an abnormal event during continuous operation.
        self.auto_synthetic = True
        self.synthetic_episode_beats = 0
        self.synthetic_episode_target = random.randint(7, 12)
        self.synthetic_abnormal_probability = 0.28

        self.log = open(logpath, "w", newline="")
        self.csv = csv.writer(self.log)

        self.csv.writerow([
            "timestamp",
            "source",
            "scenario",
            "arduino_ms",
            "bpm",
            "P_mV",
            "Q_mV",
            "R_mV",
            "S_mV",
            "device_verdict",
            "model_verdict",
            "model_conf",
            "uncalibrated"
        ])

    # ----------------------------------------------------------- commands
    def send(self, ch):
        """Forward a command to Arduino in LIVE mode."""
        if self.ser is not None:
            try:
                self.ser.write(ch.encode("ascii"))
            except Exception as e:
                print(f"[serial] could not send '{ch}': {e}")

    # ----------------------------------------------------------- live input
    def handle(self, line):
        if line.startswith("D,"):
            try:
                with self.lock:
                    self.wave.append(int(line[2:]) * Q4_TO_MV)
            except ValueError:
                pass
            return

        if line.startswith("A,"):
            parts = line.split(",")[1:]

            if len(parts) == 6:
                cols = "  ".join(
                    f"A{i}={v:>4}" for i, v in enumerate(parts)
                )
                print(
                    f"  analog scan | {cols} "
                    f"<- the pin that PULSES is your ECG pin"
                )

            return

        if line.startswith("#"):
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

        host, conf = classify(
            self.model,
            self.le,
            P,
            Q,
            R
        )

        uncal = (
            self.sim_mode == "LIVE"
            and not self.sim_calibrated
        )

        self.update_result(
            bpm=bpm,
            P=P,
            Q=Q,
            R=R,
            S=S,
            device=device,
            host=host,
            conf=conf,
            source="LIVE SENSOR",
            scenario="LIVE",
            uncal=uncal,
            timestamp_ms=ms
        )

    # ----------------------------------------------------------- synthetic
    def synthetic_step(self):
        """
        Generate one synthetic beat.

        The beat is appended to a rolling waveform buffer. P/Q/R/S and BPM
        vary from beat to beat so the demo does not look like a constant
        72-BPM animation.
        """
        normal = self.synthetic_normal

        P, Q, R, S = synthetic_features(normal)

        beat, bpm = synthetic_beat(
            normal,
            samples=100
        )

        # Add the new beat to the rolling ECG display.
        with self.lock:
            for value in beat:
                self.wave.append(value)

        host, conf = classify(
            self.model,
            self.le,
            P,
            Q,
            R
        )

        scenario = (
            "NORMAL DEMO"
            if normal
            else "ABNORMAL DEMO"
        )

        self.update_result(
            bpm=round(bpm),
            P=P,
            Q=Q,
            R=R,
            S=S,
            device="SIMULATED",
            host=host,
            conf=conf,
            source="SYNTHETIC",
            scenario=scenario,
            uncal=False,
            timestamp_ms=int(time.time() * 1000)
        )

    def choose_next_synthetic_scenario(self):
        """
        Automatically create realistic monitoring episodes.

        Most of the time the patient is in the normal synthetic state.
        Occasionally the monitor enters an abnormal episode for several
        beats, then returns to normal.
        """
        if not self.auto_synthetic:
            return self.synthetic_normal

        # Continue the current episode for a number of beats.
        if self.synthetic_episode_beats < self.synthetic_episode_target:
            self.synthetic_episode_beats += 1
            return self.synthetic_normal

        # End the current episode and decide what comes next.
        self.synthetic_episode_beats = 1

        if self.synthetic_normal:
            # Occasionally enter an abnormal episode.
            if random.random() < self.synthetic_abnormal_probability:
                self.synthetic_normal = False
                self.synthetic_episode_target = random.randint(4, 8)
                print(
                    "\n⚠ [SYNTHETIC EVENT] Abnormal episode started "
                    f"({self.synthetic_episode_target} beats)\n"
                )
            else:
                self.synthetic_episode_target = random.randint(8, 16)
        else:
            # Abnormal episode always returns to normal afterwards.
            self.synthetic_normal = True
            self.synthetic_episode_target = random.randint(8, 16)
            print(
                "\n✓ [SYNTHETIC EVENT] Rhythm returned to normal\n"
            )

        return self.synthetic_normal

    def synthetic_loop(self):
        print("\n" + "=" * 70)
        print("SYNTHETIC DEMO MODE")
        print("No Arduino or ECG sensor is being used.")
        print("The waveform is continuously streamed at 100 Hz.")
        print("BPM/P/Q/R/S vary from beat to beat.")
        print("The deployed Random Forest performs the classification.")
        print("Automatic abnormal episodes are enabled. Press 'n'/'a' for manual control, 'v' to toggle, 'x' to re-enable auto mode.")
        print("=" * 70 + "\n")

        # Continuous waveform timing.
        sample_period = 1.0 / FS_STREAM
        next_sample = time.perf_counter()

        # Generate the first beat immediately.
        normal = self.synthetic_normal
        current_beat, bpm = synthetic_beat(
            normal,
            samples=100
        )

        beat_index = 0
        sample_index = 0
        beat_duration = 60.0 / bpm
        samples_per_beat = max(
            20,
            int(beat_duration * FS_STREAM)
        )

        # Feature values are generated once per displayed beat result.
        P, Q, R, S = synthetic_features(normal)

        host, conf = classify(
            self.model,
            self.le,
            P,
            Q,
            R
        )

        self.update_result(
            bpm=round(bpm),
            P=P,
            Q=Q,
            R=R,
            S=S,
            device="SIMULATED",
            host=host,
            conf=conf,
            source="SYNTHETIC",
            scenario="NORMAL DEMO" if normal else "ABNORMAL DEMO",
            uncal=False,
            timestamp_ms=int(time.time() * 1000)
        )

        while self.running:
            now = time.perf_counter()

            if now >= next_sample:
                # Continuously advance the scrolling ECG.
                if sample_index < len(current_beat):
                    value = current_beat[sample_index]
                    sample_index += 1
                else:
                    # Start next beat and, in automatic mode, occasionally
                    # switch into an abnormal episode.
                    beat_index += 1
                    normal = self.choose_next_synthetic_scenario()

                    current_beat, bpm = synthetic_beat(
                        normal,
                        samples=100
                    )

                    beat_duration = 60.0 / bpm
                    samples_per_beat = max(
                        20,
                        int(beat_duration * FS_STREAM)
                    )

                    sample_index = 1
                    value = current_beat[0]

                    P, Q, R, S = synthetic_features(normal)

                    host, conf = classify(
                        self.model,
                        self.le,
                        P,
                        Q,
                        R
                    )

                    self.update_result(
                        bpm=round(bpm),
                        P=P,
                        Q=Q,
                        R=R,
                        S=S,
                        device="SIMULATED",
                        host=host,
                        conf=conf,
                        source="SYNTHETIC",
                        scenario=(
                            "NORMAL DEMO"
                            if normal
                            else "ABNORMAL DEMO"
                        ),
                        uncal=False,
                        timestamp_ms=int(time.time() * 1000)
                    )

                with self.lock:
                    self.wave.append(value)

                next_sample += sample_period

                # Avoid accumulating a large timing backlog.
                if time.perf_counter() - next_sample > 0.2:
                    next_sample = time.perf_counter()

            else:
                time.sleep(
                    min(
                        0.002,
                        max(
                            0.0005,
                            next_sample - time.perf_counter()
                        )
                    )
                )


    # ----------------------------------------------------------- common result
    def update_result(
        self,
        bpm,
        P,
        Q,
        R,
        S,
        device,
        host,
        conf,
        source,
        scenario,
        uncal,
        timestamp_ms
    ):
        with self.lock:
            self.latest.update(
                bpm=bpm,
                P=P,
                Q=Q,
                R=R,
                S=S,
                device=device,
                host=host or "--",
                conf=conf or 0.0,
                beats=self.latest["beats"] + 1,
                uncal=uncal,
                source=source,
                scenario=scenario
            )

            n = self.latest["beats"]

        verdict = host or device

        if verdict and str(verdict).upper().startswith("ABNORM"):
            flag = "\033[91m"
        else:
            flag = "\033[92m"

        uncal_tag = (
            "  \033[93m[UNCALIBRATED - press c]\033[0m"
            if uncal
            else ""
        )

        # In synthetic mode, occasionally show a deliberate DEMO FALSE/TRUE
        # comparison between the requested scenario and the model prediction.
        # This does not modify the model prediction or training data.
        demo_check = ""
        if source == "SYNTHETIC" and host:
            predicted_abnormal = str(host).upper().startswith("ABNORM")
            scenario_abnormal = scenario.upper().startswith("ABNORMAL")

            demo_check = (
                " | DEMO-CHECK: TRUE"
                if predicted_abnormal == scenario_abnormal
                else " | DEMO-CHECK: FALSE"
            )

        print(
            f"beat {n:4d} | "
            f"HR {bpm:3d} bpm | "
            f"P {P:+.3f}  "
            f"Q {Q:+.3f}  "
            f"R {R:+.3f}  "
            f"S {S:+.3f} mV | "
            f"source: {source:9s} | "
            f"model: {flag}{host or '--'}\033[0m"
            + (f" ({conf:.2f})" if conf else "")
            + demo_check
            + uncal_tag
        )

        self.csv.writerow([
            datetime.now().isoformat(timespec="seconds"),
            source,
            scenario,
            timestamp_ms,
            bpm,
            f"{P:.4f}",
            f"{Q:.4f}",
            f"{R:.4f}",
            f"{S:.4f}",
            device,
            host or "",
            f"{conf:.3f}" if conf else "",
            "yes" if uncal else ""
        ])

        self.log.flush()

    # ----------------------------------------------------------- serial reader
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

                self.handle(
                    raw.decode("ascii", "ignore").strip()
                )

    def set_synthetic_scenario(self, normal):
        # Manual selection gives the presenter deterministic control.
        self.auto_synthetic = False
        self.synthetic_normal = normal
        self.synthetic_episode_beats = 0

        mode = "NORMAL" if normal else "ABNORMAL"

        print(
            f"\n[SYNTHETIC] Manual scenario: {mode}"
            "\n[SYNTHETIC] Automatic abnormal events disabled."
            "\n[SYNTHETIC] Press 'v' to switch manually or restart for auto mode.\n"
        )

    def close(self):
        self.running = False
        self.log.close()


# --------------------------------------------------------------- plot
def run_plot(mon):
    import matplotlib.pyplot as plt
    from matplotlib.animation import FuncAnimation

    fig, ax = plt.subplots(figsize=(11, 4.8))

    try:
        fig.canvas.manager.set_window_title(
            "NeuroCardio - ECG Monitor"
        )
    except Exception:
        pass

    t = [
        i / FS_STREAM
        for i in range(WINDOW_S * FS_STREAM)
    ]

    (ln,) = ax.plot(
        t,
        list(mon.wave),
        lw=1.2,
        color="#c62828"
    )

    ax.set_xlim(0, WINDOW_S)
    ax.set_ylim(-1.0, 2.0)

    ax.set_xlabel("time (s)")
    ax.set_ylabel("amplitude (mV)")
    ax.grid(True, which="both", lw=0.4, alpha=0.5)

    ax.set_title(
        "NeuroCardio ECG front-end"
    )

    txt = ax.text(
        0.012,
        0.96,
        "",
        transform=ax.transAxes,
        va="top",
        family="monospace",
        fontsize=10,
        bbox=dict(
            fc="white",
            ec="#bbb",
            alpha=0.9
        )
    )

    mode_txt = ax.text(
        0.985,
        0.96,
        "",
        transform=ax.transAxes,
        va="top",
        ha="right",
        family="monospace",
        fontsize=10,
        bbox=dict(
            fc="white",
            ec="#777",
            alpha=0.9
        )
    )

    def update(_):
        with mon.lock:
            y = list(mon.wave)
            d = dict(mon.latest)

        ln.set_ydata(y)

        if y:
            lo = min(y)
            hi = max(y)

            pad = max(
                0.3,
                (hi - lo) * 0.25
            )

            ax.set_ylim(
                lo - pad,
                hi + pad
            )

        txt.set_text(
            f"HR      {d['bpm']:3d} bpm\n"
            f"P       {d['P']:+.3f} mV\n"
            f"Q       {d['Q']:+.3f} mV\n"
            f"R       {d['R']:+.3f} mV\n"
            f"S       {d['S']:+.3f} mV\n"
            f"source  {d['source']}\n"
            f"scenario {d['scenario']}\n"
            f"model   {d['host']} "
            f"{('%.2f' % d['conf']) if d['conf'] else ''}\n"
            f"beats   {d['beats']}"
            + (
                "\nUNCALIBRATED - press c"
                if d.get("uncal")
                else ""
            )
        )

        if mon.synthetic and d["host"]:
            predicted_abnormal = str(d["host"]).upper().startswith("ABNORM")
            scenario_abnormal = str(d["scenario"]).upper().startswith("ABNORMAL")
            check = "TRUE" if predicted_abnormal == scenario_abnormal else "FALSE"
            txt.set_text(
                txt.get_text() + f"\nDemo check {check}"
            )

        mode_txt.set_text(
            "SYNTHETIC DEMO"
            if mon.synthetic
            else "LIVE SENSOR"
        )

        if mon.synthetic:
            if mon.synthetic_normal:
                mode_txt.set_color("#1b5e20")
            else:
                mode_txt.set_color("#b71c1c")
        elif d.get("uncal"):
            mode_txt.set_color("#b8860b")
        else:
            mode_txt.set_color(
                "#b71c1c"
                if str(d["host"]).upper().startswith("ABNORM")
                else "#1b5e20"
            )

        return ln, txt, mode_txt

    def on_key(e):
        if e.key == "q":
            plt.close(fig)
            mon.running = False

        elif mon.synthetic:
            if e.key == "n":
                mon.set_synthetic_scenario(True)

            elif e.key == "a":
                mon.set_synthetic_scenario(False)

            elif e.key == "v":
                mon.set_synthetic_scenario(
                    not mon.synthetic_normal
                )

            elif e.key == "x":
                mon.auto_synthetic = True
                mon.synthetic_normal = True
                mon.synthetic_episode_beats = 0
                mon.synthetic_episode_target = random.randint(7, 12)
                print(
                    "\n[SYNTHETIC] Automatic abnormal-event mode ENABLED.\n"
                )

            elif e.key == "r":
                with mon.lock:
                    mon.wave.clear()

                    for _ in range(
                        WINDOW_S * FS_STREAM
                    ):
                        mon.wave.append(0.0)

                    mon.latest["beats"] = 0

                print("[synthetic] Demo reset.")

        else:
            if e.key in (
                "t",
                "s",
                "b",
                "c",
                "r",
                "d",
                "h",
                "?"
            ):
                mon.send(e.key)

    fig.canvas.mpl_connect(
        "key_press_event",
        on_key
    )

    if mon.synthetic:
        help_text = (
            "Synthetic controls:  n=Normal   a=Abnormal   "
            "v=Toggle   r=Reset   q=Quit"
        )
    else:
        help_text = (
            "Live controls: t=test-signal   c=calibrate   "
            "d=find-pin   h=debug   s=stream   b=beep   "
            "r=reset   q=quit"
        )

    fig.text(
        0.5,
        0.01,
        help_text,
        ha="center",
        fontsize=8,
        color="#666"
    )

    _anim = FuncAnimation(
        fig,
        update,
        interval=50,
        blit=False,
        cache_frame_data=False
    )

    plt.tight_layout(
        rect=[0, 0.04, 1, 1]
    )

    plt.show()


# --------------------------------------------------------------- terminal menu
def choose_mode():
    print("\n" + "=" * 55)
    print("          NeuroCardio - Select Input Mode")
    print("=" * 55)
    print("1. LIVE SENSOR  - Arduino + ECG electrodes")
    print("2. SYNTHETIC    - no sensor required (demo)")
    print("=" * 55)

    while True:
        choice = input(
            "Choose mode [1/2]: "
        ).strip()

        if choice == "1":
            return False

        if choice == "2":
            return True

        print("Please enter 1 or 2.")


# --------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()

    ap.add_argument(
        "--port",
        help="Arduino serial port, e.g. COM5"
    )

    ap.add_argument(
        "--baud",
        type=int,
        default=115200
    )

    ap.add_argument(
        "--noplot",
        action="store_true"
    )

    ap.add_argument(
        "--list",
        action="store_true"
    )

    ap.add_argument(
        "--synthetic",
        "--demo",
        action="store_true",
        help="start directly in sensor-free synthetic demo mode"
    )

    a = ap.parse_args()

    if a.list:
        if list_ports is None:
            print("pyserial is not installed.")
            return

        for p in list_ports.comports():
            print(
                f"{p.device:20s} {p.description}"
            )

        return

    # -----------------------------------------------------------
    # Select mode
    # -----------------------------------------------------------
    synthetic = (
        True
        if a.synthetic
        else choose_mode()
    )

    model, le = load_model()

    logname = os.path.join(
        HERE,
        f"session_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
    )

    mon = Monitor(
        model,
        le,
        logname,
        synthetic=synthetic
    )

    # -----------------------------------------------------------
    # SYNTHETIC MODE
    # -----------------------------------------------------------
    if synthetic:
        print(
            f"\nLogging to {os.path.basename(logname)}"
        )

        if a.noplot:
            print(
                "Synthetic terminal mode."
            )
            print(
                "Commands: n=normal, a=abnormal, "
                "v=toggle, r=reset, q=quit\n"
            )

            th = threading.Thread(
                target=mon.synthetic_loop,
                daemon=True
            )

            th.start()

            try:
                while mon.running:
                    line = input("> ").strip().lower()

                    if line == "q":
                        break

                    elif line == "n":
                        mon.set_synthetic_scenario(True)

                    elif line == "a":
                        mon.set_synthetic_scenario(False)

                    elif line == "v":
                        mon.set_synthetic_scenario(
                            not mon.synthetic_normal
                        )

                    elif line == "x":
                        mon.auto_synthetic = True
                        mon.synthetic_normal = True
                        mon.synthetic_episode_beats = 0
                        mon.synthetic_episode_target = random.randint(7, 12)
                        print(
                            "[synthetic] automatic abnormal-event mode ENABLED"
                        )

                    elif line == "r":
                        with mon.lock:
                            mon.wave.clear()

                            for _ in range(
                                WINDOW_S * FS_STREAM
                            ):
                                mon.wave.append(0.0)

                            mon.latest["beats"] = 0

                        print("[synthetic] reset")

            except KeyboardInterrupt:
                pass

            finally:
                mon.close()
                print(
                    f"\nSaved {logname}"
                )

        else:
            th = threading.Thread(
                target=mon.synthetic_loop,
                daemon=True
            )

            th.start()

            try:
                run_plot(mon)

            except KeyboardInterrupt:
                pass

            finally:
                mon.close()
                print(
                    f"\nSaved {logname}"
                )

        return

    # -----------------------------------------------------------
    # LIVE SENSOR MODE
    # -----------------------------------------------------------
    port = pick_port(a.port)

    if serial is None:
        sys.exit(
            "pyserial is missing. Install it with: pip install pyserial"
        )

    with serial.Serial(
        port,
        a.baud,
        timeout=0.1
    ) as ser:

        time.sleep(2.0)
        ser.reset_input_buffer()

        mon.ser = ser

        # Firmware streams D,<sample> only after receiving 's'.
        ser.write(b"s")

        print(
            f"Connected. Logging to "
            f"{os.path.basename(logname)}"
        )

        print(
            "Commands: t=test-signal  "
            "c=CALIBRATE (do this first in LIVE mode)  "
            "d=find-ECG-pin  "
            "h=readable-debug  "
            "s=stream  "
            "b=beep  "
            "r=reset"
        )

        if a.noplot:
            print(
                "Type a command letter here and press Enter "
                "(q to quit).\n"
            )
        else:
            print(
                "Click the plot window, then press "
                "t / c / d / h / s / b / r  "
                "(q quits).\n"
            )

        th = threading.Thread(
            target=mon.reader,
            args=(ser,),
            daemon=True
        )

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

            print(
                f"\nSaved {logname}"
            )


if __name__ == "__main__":
    main()
