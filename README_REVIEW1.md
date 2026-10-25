# NeuroCardio — Review 1 hardware demo pack

Everything here is built, compiled and tested. The firmware builds for the
ATmega328P at **50% flash / 36% SRAM**, and the DSP chain has been run against
synthetic beats end-to-end to confirm the numbers it produces feed the
classifier correctly.

```
firmware/NeuroCardio_Review1/NeuroCardio_Review1.ino   <- upload this
host/train_model.py                                    <- run once
host/host_monitor.py                                   <- run during the demo
host/data.csv
host/requirements.txt
host/app_fixed.py                                      <- optional web page
host/dashboard.py + host/web/                          <- web dashboard (below)
```

### Web dashboard

```
python host/dashboard.py                 # synthetic signal, opens http://127.0.0.1:8050
python host/dashboard.py --port COM5     # straight onto the Arduino
```

No extra packages are needed beyond `requirements.txt`, and it works offline.
Four tabs:

- **Live monitor** — bedside-style ECG strip (sweep or scroll) with R peaks
  marked, heart rate and zone, Random Forest verdict and confidence, P/Q/R/S
  bars against the class ranges and device thresholds, trends, a beat log,
  and a banner and optional sound when 3 consecutive beats are abnormal. All
  firmware commands (`t c s b d h r`) are buttons, and the same keys work.
- **Sessions** — every `session_*.csv`, with charts, a table and a download.
- **Classifier lab** — move P/Q/R sliders and see the prediction, the
  synthesised beat, and where it sits in `data.csv`.
- **System** — signal chain, firmware facts, serial protocol, limitations.

You can switch between the synthetic source and the Arduino from the page.
Live runs are recorded to a session CSV automatically. Synthetic runs are
recorded only when you press **Record**.

**Next.js version.** `frontend/` is a more polished front end with the same
four pages, built on the same backend. Keep `python host/dashboard.py
--no-browser` running, then `cd frontend && npm install && npm run dev` and
open http://localhost:3000. See `frontend/README.md`.

**SNN preview.** `python host/dashboard.py --model snn-preview` shows the SNN
pipeline running on every beat: the real spike encoding from the training
notebook feeding an untrained LIF network. Verdicts stay with the Random Forest
until the trained SNN is loaded.

---

## 1. Wire it like this (15 minutes, do this first)

The sketch expects the LCD on six **consecutive** pins so you can run a tidy
ribbon from the LCD header straight into D7…D2.

| LCD adapter header | Arduino UNO |
|---|---|
| GND | GND |
| VCC | 5V |
| RS  | D7 |
| EN  | D6 |
| D4  | D5 |
| D5  | D4 |
| D6  | D3 |
| D7  | D2 |

| Other | Arduino UNO |
|---|---|
| ECG module +5V | 5V |
| ECG module GND | GND |
| ECG module OUT (analog) | **A0** |
| Buzzer + | D9 |
| Buzzer − | GND |

If you would rather not rewire, change the six numbers at the top of the
sketch (`PIN_LCD_RS` … `PIN_LCD_D7`) to whatever you already have. Nothing
else in the code depends on them.

**Electrode belt** — red on the right chest / right arm, yellow on the left
chest / left arm, green (the reference) low on the right ribs or the hip.
Wet the pads slightly. Get the person to sit still with arms resting; muscle
tension is the single biggest source of ECG noise.

**Contrast** — if the LCD shows blank or solid blocks, turn the blue
potentiometer on the adapter board. That is a contrast problem, not a code
problem. Set it before you worry about anything else.

**Grounding note** — run the Arduino from the laptop's USB, not a separate
adapter, while the electrodes are on a person. Two supplies with different
grounds is what produces a wall of 50 Hz hum.

---

## 2. Upload and run

1. Arduino IDE → open `NeuroCardio_Review1.ino` → Board: **Arduino Uno** →
   pick the port → Upload. The `LiquidCrystal` library ships with the IDE, so
   there is nothing to install.
2. On the LCD you should see `NeuroCardio v1` / `ECG front-end`, one beep,
   then `HR:--- bpm` / `PLACE ELECTRODES`.
3. In VS Code:
   ```
   pip install -r host/requirements.txt
   python host/train_model.py      # once — creates host/models/
   python host/host_monitor.py     # during the demo
   ```
   Close the Arduino IDE's Serial Monitor first — only one program can hold
   the COM port.

### Before you touch a single electrode, prove it works

Press **`t`** in the Serial Monitor (or type it into the terminal running
`host_monitor.py` — actually easier: use the IDE Serial Monitor for commands
and run `host_monitor.py --noplot` afterwards). `t` cycles the input source:

| press | mode | LCD corner | what happens |
|---|---|---|---|
| `t` ×1 | SIM-NORMAL | `N` | injects a stored 80 bpm normal beat |
| `t` ×2 | SIM-ABNORMAL | `A` | injects a beat with tall R and deep Q — buzzer alarms |
| `t` ×3 | LIVE | blank | back to the real electrodes on A0 |

This is a **signal-injection self-test**, standard practice in biomedical
instrumentation — you verify the acquisition and analysis chain against a
known input before trusting it with a subject. Say it in exactly those words.
It also means that if the electrodes misbehave tomorrow you still have a
working demo.

Other serial commands: `s` toggle waveform streaming, `b` toggle the per-beat
beep, `c` calibrate the gain so the current beat's R wave reads 1.00 mV,
`r` reset, `?` help.

---

## 3. What the firmware actually does

```
A0 ──► ADC 200 Hz ──► 4-tap moving average ──► IIR high-pass ──► circular buffer
                            (50 Hz notch)      (baseline wander)        │
                                                                        ▼
                                              adaptive-threshold R-peak detector
                                                                        │
                                                     ┌──────────────────┴─────────┐
                                                     ▼                            ▼
                                       P/Q/R/S measurement              R-R interval → BPM
                                                     │                            │
                                       ┌─────────────┴────────┬───────────────────┘
                                       ▼                      ▼
                                  LCD + buzzer          serial → PC → Random Forest
```

**Sampling — 200 Hz.** Above the ~150 Hz needed for diagnostic ECG bandwidth
by Nyquist, and slow enough that an UNO has time left over for the LCD.

**4-tap moving average.** A moving average of length *N* puts spectral zeros
at multiples of *fs/N*. With fs = 200 and N = 4 the zeros land exactly on
**50 Hz and 100 Hz** — Indian mains and its second harmonic. That is why the
sample rate and the filter length were chosen together. It costs one add and
one subtract per sample.

**IIR high-pass.** `baseAcc += maSum − (baseAcc >> 8)` tracks a slow running
mean; subtracting it removes electrode DC offset and breathing-induced
baseline wander. The shift of 8 gives a ~1.3 s time constant, i.e. a corner
near 0.12 Hz — below the P wave, so the P wave survives.

**R-peak detection.** A three-state machine:
- *idle* — waits for the signal to cross an adaptive threshold set at 3/5 of
  a slowly decaying peak envelope, with a 250 ms refractory period so a T
  wave can never be counted as a beat (250 ms ⇒ a 240 bpm ceiling).
- *rising* — tracks the local maximum until the signal falls to half of it.
  That maximum is the R peak.
- *wait* — holds for 80 ms so the S wave is inside the buffer before
  measuring.

**Feature measurement.** Amplitudes are measured against the **local
isoelectric line** — the average of the TP segment, ~40% of an R-R interval
before the R peak — not against zero. This is how amplitudes are read on a
real ECG, and it is what makes the numbers stable. The P-wave and reference
windows scale with the current R-R interval, so the measurement stays valid
as the heart rate changes.

**Calibration.** `5000 mV ÷ 1024 counts ÷ gain 1000 = 0.004883 mV/count`. If
your module's gain is different, press `c` while a clean beat is running and
the firmware solves for the gain that makes R read 1.00 mV.

**Electrode watchdog.** If more than 10% of samples in any one-second window
are railed at the ADC limits, the firmware declares `LEAD OFF - CHECK` and
stops detecting. Without this, a detached lead produces a square wave that a
peak detector happily reports as a 200 bpm heart rate. Tested: railed input
produces zero false beats.

**On-board decision.** A 2-of-3 threshold screen on P, Q and R, plus a
brady/tachy check on the rate, confirmed over 3 consecutive beats before the
alarm fires. Be clear with the examiner that this is a *screening rule so the
device is useful standalone* — the actual classifier runs on the host today
and becomes the SNN in Review 2.

---

## 4. What you will see

**LCD, line 1**, always: `HR: 78 bpm` plus a heart glyph that appears while a
signal is present, and `N`/`A` when a test signal is injected.

**LCD, line 2**, rotating every 0.7 s:
```
P 0.17 Q-0.25       ← measured wave amplitudes, mV
R  0.74 mV          ← R amplitude
RESULT: NORMAL      ← device verdict
```
and `PLACE ELECTRODES` / `LEAD OFF - CHECK` when there is no usable signal.

**Buzzer** — a short click on every beat (turn it off with `b` if it gets
annoying mid-presentation), three sharp beeps when three consecutive abnormal
beats are confirmed.

**Terminal** — one line per beat:
```
beat   12 | HR  80 bpm | P +0.173  Q -0.245  R +0.740  S -0.210 mV | device: NORMAL   | model: Normal (1.00)
beat   13 | HR  80 bpm | P +0.412  Q -0.413  R +1.254  S -0.330 mV | device: ABNORMAL | model: Abnormal (1.00)
```

**Plot window** — a rolling 6-second ECG strip with a live readout panel.

Every session is written to `host/session_<timestamp>.csv`. Open one at the
end of the demo — a saved recording is concrete evidence of a working
pipeline and examiners like seeing it.

---

## 5. The five-minute demo, in order

1. **Frame it (30 s).** "Review 1 covers the acquisition and feature-extraction
   front end. The neuromorphic classifier is Review 2. What you'll see is
   signal in, filtered, R peaks found, morphology measured, heart rate
   computed, result displayed — all on an 8-bit micro at 200 Hz."
2. **Self-test (60 s).** Press `t`. Show the LCD locking to 80 bpm and reading
   P/Q/R. Press `t` again — LCD flips to `RESULT: ABNORM`, buzzer alarms.
   "That's a known injected test vector; it proves the chain end to end
   before I put it on a person."
3. **Live (90 s).** Press `t` back to LIVE, strap the belt on someone, wait
   ~5 s for the filters to settle. Show the heart rate on the LCD and the
   waveform on the laptop.
4. **Lead-off (30 s).** Pop one electrode off. LCD goes to `LEAD OFF - CHECK`.
   "It fails safe instead of reporting a fake heart rate."
5. **Host side (60 s).** Point at the terminal: features per beat, the Random
   Forest verdict, the CSV log. "This is the interface the SNN will plug into
   — same feature vector, different classifier."
6. **What's next (30 s).** Section 6 below.

---

## 6. Say these limitations before you're asked

Examiners reward a team that already knows where its own weak points are.
Three sentences, up front, and most of the hard questioning evaporates.

- **`data.csv` is synthetic and trivially separable.** 100 rows, and the two
  classes do not overlap on any feature (Normal P tops out at 0.197, Abnormal
  P starts at 0.303). Every model scores 100%, which means nothing. Review 2
  moves to real annotated records — MIT-BIH Arrhythmia or PTB-XL.
- **Single-lead, three electrodes.** Enough for rate and gross morphology.
  Not enough to localise ischaemia or classify most arrhythmias, which need
  12-lead.
- **Not a medical device.** No isolation barrier, no certification. It is a
  research prototype.

Then the roadmap: real dataset → spike-encode the feature stream → train the
SNN → port inference to the device → web dashboard.

---

## 7. Questions you will probably get

**Why 200 Hz?** Diagnostic ECG needs roughly 0.05–150 Hz; Nyquist puts the
floor near 300 Hz for the full band, and 200 Hz is the standard compromise
for QRS detection and rate, which is what this stage does. It also makes the
4-tap average a clean 50 Hz notch.

**How do you reject mains hum?** Structurally — the moving-average length is
chosen so its nulls sit on 50 and 100 Hz. No multiply, no filter coefficients.

**Why not FFT / a proper IIR filter?** An ATmega328P has 2 KB of SRAM and no
FPU. The whole pipeline is integer adds, shifts and comparisons, which is why
it runs comfortably in a 5 ms budget alongside a character LCD.

**How do you know the R peak isn't a T wave?** Two independent guards: the
adaptive threshold sits at 3/5 of the recent peak envelope (a T wave is
typically under a third of R), and a 250 ms refractory period after every
detected R.

**Why measure against a local baseline?** Because the isoelectric line drifts
with breathing and electrode impedance. Measuring P, Q, R against the TP
segment of the same beat is what a clinician does with calipers, and it is
what makes the amplitudes reproducible beat to beat.

**Is the classifier on the Arduino?** The threshold screen is; the trained
model is on the host. The device streams a 3-element feature vector per beat,
so swapping the Random Forest for the SNN changes nothing on the hardware
side — that is deliberate.

**What's your accuracy?** 100% on the supplied data, and that number is not
meaningful because the dataset is synthetic and linearly separable. Real
figures come in Review 2 on annotated records. *(Give it in that order.
Volunteering the caveat reads as competence; being caught out on it doesn't.)*

**What is neuromorphic about it so far?** Nothing yet, and be straight about
that. This review is the sensing front end. The neuromorphic contribution is
Review 2: encoding the beat features as spike trains and running an SNN,
where the argument is energy per inference on an always-on wearable.

---

## 8. If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| LCD blank or solid blocks | contrast | turn the blue pot |
| LCD garbage characters | wrong data pins | check D7…D2 against the table |
| `PLACE ELECTRODES` forever | no R peaks | lower `THRESH_MIN` from 60 to ~30 |
| `LEAD OFF - CHECK` | amplifier railed | reseat electrodes, wet the pads |
| Heart rate wildly high | motion or mains noise | sit still, USB power only, check the green reference electrode |
| Serial port busy | IDE monitor open | close it before running the Python |
| `incompatible dtype` on the old .pkl | pickles from scikit-learn 1.0.2 | run `train_model.py`, it retrains |
| Plot window frozen | matplotlib backend | `python host_monitor.py --noplot` |

**Sketch tuning knobs**, all at the top of the file: `THRESH_MIN` (detector
sensitivity), `BASE_SHIFT` (baseline tracking speed), `TH_P_ABN` / `TH_Q_ABN`
/ `TH_R_ABN` (screening thresholds), `calGain` (mV scaling).

---

## 9. Verification already done

- Compiles for ATmega328P with `-Wall -Wextra`, zero warnings.
- 16,500 bytes flash (50%), 748 bytes SRAM (37%) — plenty of headroom.
- The DSP and detector were compiled natively and run against injected beats:
  correct detection and stable features at 50, 80 and 109 bpm; zero false
  beats on a flat line; zero false beats on a fully railed input.
- Firmware-measured features fed into the retrained Random Forest give the
  right class at 1.00 confidence for both the normal and abnormal test
  vectors — the loop closes.

What has **not** been tested is your specific ECG module's gain and output
range, because that depends on the hardware in the box. Budget twenty minutes
tonight to run the self-test and then a live trace. If the amplitudes look
off, press `c` on a clean beat and it calibrates itself.
