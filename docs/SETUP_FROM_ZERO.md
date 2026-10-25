# NeuroCardio — complete setup, from zero (read this top to bottom)

You need **two programs** to run this project, and they do different jobs:

- **Arduino IDE** — puts the `.ino` firmware *onto* the Arduino board. You use
  it once to upload, and again anytime you change the sketch.
- **VS Code** — runs the two Python scripts *on your laptop*. These talk to
  the Arduino over the USB cable while it's running.

VS Code does **not** upload the `.ino`. Arduino IDE does. Keep that straight
and nothing else is confusing.

---

## PART A — Folder structure

Make one project folder. Put everything from the pack inside it like this:

```
NeuroCardio/                          <- open THIS folder in VS Code
│
├── firmware/
│   └── NeuroCardio_Review1/
│       └── NeuroCardio_Review1.ino   <- Arduino IDE opens this
│
├── host/                             <- everything here runs in VS Code
│   ├── host_monitor.py
│   ├── train_model.py
│   ├── app_fixed.py                  (optional web page — skip for tomorrow)
│   ├── data.csv
│   ├── requirements.txt
│   └── models/                       (created automatically by train_model.py)
│       ├── rf_model.joblib
│       └── label_encoder.joblib
│
├── docs/
│   ├── firmware_flowchart.puml
│   └── NeuroCardio_Firmware_Flow.png
│
└── README_REVIEW1.md
```

Rule that trips up beginners: an Arduino sketch file **must** live inside a
folder of the **same name**. `NeuroCardio_Review1.ino` must be inside a folder
called `NeuroCardio_Review1`. It already is in the pack — just don't move the
`.ino` out on its own.

If you have the `templates/` and `static/` folders from the senior's code and
want the optional web page later, they go inside `host/`. You don't need them
for tomorrow.

---

## PART B — Install the two programs (do this tonight, ~20 min)

### B1. Arduino IDE
1. Download from https://www.arduino.cc/en/software (get "Arduino IDE 2.x").
2. Install it, open it once so it finishes setting up.
3. On **Windows**, when you first plug in a clone UNO (the blue board in your
   photos is a CH340-based clone), Windows usually installs the driver on its
   own. If the board never shows up as a COM port later, install the **CH340
   driver** — search "CH340 driver windows", install, replug the board.

### B2. Python + VS Code
1. Install Python from https://www.python.org/downloads/ — **on the first
   installer screen tick "Add Python to PATH"**. Miss this and VS Code can't
   find Python.
2. Install VS Code from https://code.visualstudio.com/.
3. Open VS Code → Extensions (the four-squares icon on the left) → install
   **"Python"** by Microsoft. Optionally install **"PlantUML"** if you want to
   preview the flowchart inside VS Code.

That's the one-time setup. Now the actual run.

---

## PART C — Wire the hardware (~15 min, do before uploading)

Power off / unplug the Arduino while you wire. Use the female jumper wires you
already have.

### C1. LCD → Arduino
Your LCD adapter board has a header labelled `GND VCC RS EN D4 D5 D6 D7`.
Connect them to these UNO pins:

| LCD pin | UNO pin |
|---|---|
| GND | GND |
| VCC | 5V |
| RS  | 7 |
| EN  | 6 |
| D4  | 5 |
| D5  | 4 |
| D6  | 3 |
| D7  | 2 |

(Notice RS→7, EN→6, then D4→5, D5→4, D6→3, D7→2. It counts *down*.)

### C2. ECG sensor → Arduino
Your black "ECG Sensor +5V DC, O/P Analog" box has three connections going to
the Arduino side:

| ECG box | UNO pin |
|---|---|
| +5V (power) | 5V |
| GND | GND |
| OUT / signal (analog) | **A0** |

The three electrode leads (red / yellow / green snaps) plug into the *other*
side of the ECG box and go on the body — see Part E.

### C3. Buzzer → Arduino
| Buzzer | UNO pin |
|---|---|
| + | 9 |
| − | GND |

### C4. You'll run out of GND pins
The UNO only has 3 GND pins and you need GND for the LCD, the ECG box, and the
buzzer. Use the small breadboard/perfboard in your photo as a **common ground
rail**: run one wire from a UNO GND to the rail, then take LCD-GND, ECG-GND and
buzzer-GND all from that rail. Same trick for 5V if you run short. This is
normal, not a hack.

Double-check: **nothing** goes to a pin the sketch doesn't mention. No loose
wire touching 5V and GND at once.

---

## PART D — Upload the firmware (Arduino IDE)

1. Plug the UNO into the laptop with USB.
2. Open Arduino IDE → **File → Open** → navigate to
   `NeuroCardio/firmware/NeuroCardio_Review1/NeuroCardio_Review1.ino`.
3. **Tools → Board → Arduino AVR Boards → Arduino Uno.**
4. **Tools → Port** → pick the one that appeared when you plugged in
   (Windows: `COM3`, `COM5`, …; Mac: `/dev/cu.usbserial…` or `/dev/cu.wchusbserial…`).
   Write this port name down — VS Code needs it.
5. Click the **→ (Upload)** arrow, top left. Wait for "Done uploading."
6. The LCD should show `NeuroCardio v1` / `ECG front-end`, beep once, then
   `HR:--- bpm` / `PLACE ELECTRODES`.

**LCD blank or shows solid white blocks?** That's the contrast pot, not a
code fault. Turn the little blue screw-potentiometer on the LCD adapter slowly
until text appears. Do this before anything else.

**"Done uploading" but LCD still blank after adjusting contrast?** Recheck the
8 LCD wires against the table in C1 — a swapped D4/D7 gives garbage or nothing.

The `LiquidCrystal` library the sketch uses ships with the Arduino IDE, so
there is nothing extra to install.

---

## PART E — Prove it works WITHOUT electrodes (the safe demo)

Do this before you ever put the belt on a person. It's your fallback if the
live signal is noisy tomorrow.

1. In Arduino IDE: **Tools → Serial Monitor** (or the magnifying-glass icon,
   top right).
2. Bottom-right of the Serial Monitor, set baud to **115200**.
3. Type `t` in the input box, press Enter. LCD top-right shows `N`, heart rate
   locks to ~80 bpm, line 2 rotates through `P 0.17 Q-0.25`, `R 0.74 mV`,
   `RESULT: NORMAL`. This is an injected normal ECG beat.
4. Type `t` again. Top-right shows `A`, and after a few beats
   `RESULT: ABNORM`, and the buzzer alarms. Injected abnormal beat.
5. Type `t` a third time to go back to `LIVE` (real electrodes).

Other single-letter commands: `s` stream on/off, `b` beep on/off, `c`
calibrate, `r` reset, `?` help.

If steps 3–4 work, **you have a passing demo no matter what happens with the
electrodes.** That's the point of building the self-test in.

---

## PART F — Run the Python side (VS Code)

Close the Arduino IDE **Serial Monitor** first. Only one program can use the
COM port at a time — if Python says "port busy" or "access denied," it's
because the Serial Monitor is still open.

1. Open VS Code → **File → Open Folder** → select the top `NeuroCardio` folder.
2. Open a terminal inside VS Code: **Terminal → New Terminal**. The prompt
   should already be sitting in the `NeuroCardio` folder.
3. Go into the host folder and install the Python libraries (one time):
   ```
   cd host
   pip install -r requirements.txt
   ```
   If `pip` isn't found, try `python -m pip install -r requirements.txt`
   (Windows) or `pip3` / `python3 -m pip …` (Mac).
4. Train the model (one time — this also *fixes* the broken model files from
   your senior; the originals no longer load on modern scikit-learn):
   ```
   python train_model.py
   ```
   You'll see accuracy printed and a new `host/models/` folder appear.
5. Start the live monitor:
   ```
   python host_monitor.py
   ```
   It auto-detects the port. If it grabs the wrong one, force it:
   ```
   python host_monitor.py --port COM5        (use your port from Part D step 4)
   ```
   No plot / plot window misbehaving on your machine:
   ```
   python host_monitor.py --noplot
   ```

You'll get a scrolling ECG plot with a live readout box, one printed line per
beat in the terminal, and a `session_<date>.csv` saved in `host/`. Open that
CSV at the end — a saved recording is good evidence for the review.

To stop: press `q` in the plot window, or `Ctrl+C` in the terminal.

---

## PART G — Now try a live reading (a person)

1. Snap the red / yellow / green electrode leads onto the belt pads. Rough
   placement for a single-lead trace on the forearm/chest:
   - **red** — right side (right chest or right wrist)
   - **yellow** — left side (left chest or left wrist)
   - **green** — the reference, lower down: lower-right ribs or the hip
2. Slightly wet the gel pads if they're dry — dry skin = noisy signal.
3. Person sits still, arm relaxed. Muscle tension is the #1 noise source.
4. Make sure the mode is `LIVE` (press `t` until the top-right LCD corner is
   blank). Wait ~5 seconds for the filters to settle.
5. Watch the heart rate settle on the LCD and the waveform draw on the laptop.

**Keep the Arduino on laptop USB power during this**, not a separate wall
adapter. Two different grounds on a person is what creates a wall of 50 Hz hum.

**Pop one electrode off on purpose** to show `LEAD OFF - CHECK` — it's a good
thing to demonstrate: the device refuses to report a fake heart rate.

If the live amplitudes look off (R nowhere near ~1 mV), type `c` while a clean
beat is running — the firmware calibrates its own gain.

---

## PART H — The PlantUML flowchart

The file is `docs/firmware_flowchart.puml` and there's a rendered
`NeuroCardio_Firmware_Flow.png` next to it.

**To edit/preview it yourself, two easy ways:**
- **Online:** go to https://www.plantuml.com/plantuml , paste the whole
  contents of the `.puml` file, and it renders instantly. No install.
- **In VS Code:** install the "PlantUML" extension, open the `.puml` file,
  press **Alt+D** to open a live preview. (This route also needs Java + the
  Graphviz "dot" tool installed; the online route needs nothing, so for
  tomorrow just use the website.)

You can drop the PNG straight into your review slides.

---

## Quick recap of the whole flow

```
tonight:  install Arduino IDE + Python + VS Code
          wire LCD, ECG box, buzzer to the UNO
          upload .ino from Arduino IDE
          press 't' twice in Serial Monitor  -> confirm both verdicts
          close Serial Monitor
          in VS Code: pip install -> train_model.py -> host_monitor.py
          try a live reading on someone

tomorrow: plug in, upload if needed, run host_monitor.py, present
          (self-test first, then live, then pop an electrode)
```

Anything in section 8 of `README_REVIEW1.md` is the troubleshooting table if
a specific thing misbehaves.
