/* ===========================================================================
   NeuroCardio  -  Review 1 firmware  (ECG acquisition + feature front-end)
   Target : Arduino UNO / Nano (ATmega328P)  @ 16 MHz
   Author : <your team>
   ---------------------------------------------------------------------------
   WHAT THIS SKETCH DOES
     1. Samples the analog ECG module on A0 at a fixed 200 Hz.
     2. Filters it   : 4-tap moving average (mains notch) + IIR high-pass
                       (baseline-wander removal).
     3. Detects R peaks with an adaptive-threshold state machine
        (a lightweight Pan-Tompkins style detector).
     4. Measures the P, Q, R and S amplitudes of every beat against the
        local isoelectric (TP-segment) reference, in millivolts.
     5. Computes heart rate from the R-R interval.
     6. Shows HR + features + result on a 16x2 parallel LCD.
     7. Beeps on every beat, and raises an alarm pattern on an abnormal beat.
     8. Streams the waveform and the per-beat feature vector over USB serial
        so the PC-side classifier (Random Forest today, SNN in Review 2)
        can consume it.

   The on-board decision is a simple 2-of-3 threshold screen. It is NOT the
   project's classifier - it exists so the device is useful standalone. The
   trained model runs on the host (host_monitor.py).
   ---------------------------------------------------------------------------
   WIRING — this matches the pin map actually used below (PIN_LCD_*, PIN_ECG,
   PIN_BUZZER). If you rewire, change the numbers in the "pin map" section
   below, not here — this block just documents what's already set.

     LCD 16x2 header      Arduino UNO
     -----------------    -----------
     GND ...............  GND
     VCC ...............  5V
     RS  ...............  D13
     EN  ...............  D12
     D4  ...............  D11
     D5  ...............  D10
     D6  ...............  D9
     D7  ...............  D8
     (contrast pot: turn it until you see the boot text)

     ECG module           Arduino UNO
     -----------------    -----------
     +5V ...............  5V
     GND ...............  GND
     OUT (analog) ......  A1

     Buzzer + ..........  D2
     Buzzer - ..........  GND

     LO+ / LO- (lead-off detect pins on some ECG modules) — OPTIONAL.
     Currently mapped to D4 / D5 in the code below, but USE_LEADOFF_PINS is
     0 (off) by default, so the firmware never reads D4/D5 and NOTHING needs
     to be wired there. Only wire LO+/LO- to D4/D5 if your ECG module has
     those pins AND you set USE_LEADOFF_PINS to 1 below.

   Electrode belt (3-lead):  RED = right arm / right chest
                             YELLOW = left arm / left chest
                             GREEN = reference, on the lower right ribs or hip
   ---------------------------------------------------------------------------
   SERIAL COMMANDS  (Serial Monitor @ 115200, "Newline" or "No line ending")
     ?  help
     s  toggle raw waveform streaming to the PC (off by default — see below)
     t  cycle test-signal mode:  LIVE -> SIM NORMAL -> SIM ABNORMAL -> LIVE
     b  toggle per-beat beep
     c  auto-calibrate gain so the current beat's R wave reads 1.00 mV
        (do this once per session in LIVE mode before trusting NORMAL/
        ABNORMAL — see "CALIBRATION" note below)
     r  reset detector + calibration
     d  analog-pin finder: dumps A0..A5 raw, 10x/sec, so you can see which
        pin actually has your ECG signal on it
     h  human-readable debug line: raw ADC, filtered value in mV, detector
        state, ~5x/sec — use this instead of raw "D," numbers if you just
        want to eyeball whether a signal is present

   ABOUT THE "D,<value>" LINES
     If you turn on raw streaming ('s'), you'll see lines like "D,-38" or
     "D,214". These are NOT a bug and the negative numbers are expected:
     each value is the FILTERED signal (baseline removed, so it sits around
     zero and swings positive/negative), in Q4 units (4 x ADC counts), not
     raw millivolts and not the raw ADC reading. To convert to millivolts by
     hand: mV = value * 0.00122075 * calGain. In practice, don't read these
     by eye — use 'h' for a readable line, or watch the "B,...' line printed
     once per detected heartbeat, which already reports P/Q/R/S in mV.

   CALIBRATION MATTERS — READ THIS
     The mV numbers assume a specific ECG-module gain (see Q4_TO_MV_BASE
     below). Real modules vary, so until you calibrate, BOTH the on-device
     NORMAL/ABNORMAL screen and the PC-side classifier can read a perfectly
     healthy beat as "ABNORMAL" simply because the amplitude is scaled
     wrong — not because anything is actually wrong. The firmware now
     refuses to show a confident result until you calibrate: in LIVE mode,
     with a clean beat, press 'c'. Until you do, the LCD shows "CALIBRATE:
     PRESS c" instead of a verdict, and the serial output is tagged UNCAL.
   =========================================================================== */

#include <LiquidCrystal.h>
#include <avr/pgmspace.h>

/* ---------------- pin map ---------------- */
const uint8_t PIN_LCD_RS = 13;
const uint8_t PIN_LCD_EN = 12;
const uint8_t PIN_LCD_D4 = 11;
const uint8_t PIN_LCD_D5 = 10;
const uint8_t PIN_LCD_D6 = 9;
const uint8_t PIN_LCD_D7 = 8;

const uint8_t PIN_ECG    = A1;
const uint8_t PIN_BUZZER = 2;

/* Lead-off detect pins - OPTIONAL, only used if USE_LEADOFF_PINS is 1 below.
   They don't conflict with anything else you're using (LCD is on 8-13,
   ECG on A1, buzzer on D2), so D4/D5 are fine to leave here. But since the
   feature is OFF by default, nothing needs to be wired to these two pins
   right now - the firmware never reads them unless you flip the flag. */
const uint8_t PIN_LO_P   = 4;
const uint8_t PIN_LO_M   = 5;

#define USE_LEADOFF_PINS  0   /* 1 only if your module exposes LO+ / LO-      */
#define BUZZER_IS_ACTIVE  0   /* 1 = active buzzer (DC), 0 = passive (tone()) */

/* ---------------- signal chain constants ---------------- */
#define FS               200          /* sampling rate, Hz                    */
#define SAMPLE_US        5000UL       /* 1e6 / FS                             */
#define BUF_LEN          128          /* 640 ms circular history              */
#define BUF_MASK         (BUF_LEN - 1)
#define BASE_SHIFT       8            /* HPF time constant = 256 smp = 1.28 s */
#define ENV_DECAY_SHIFT  9            /* envelope decay                       */
#define THRESH_NUM       3            /* threshold = envelope * 3/5           */
#define THRESH_DEN       5
#define THRESH_MIN       60           /* noise floor, Q4 units                */
#define REFRACTORY       50           /* 250 ms  -> max 240 bpm               */
#define PEAK_SEARCH_MAX  24           /* 120 ms  max QRS rise window          */
#define POST_R_WAIT      16           /* 80 ms   wait so S wave is in buffer  */
#define WARMUP_SAMPLES   400          /* 2 s     filters settle first         */
#define LEADOFF_TIMEOUT  4000UL       /* ms without a beat -> "check leads"   */

/* ADC -> millivolt calibration.
   5000 mV / 1024 counts / instrumentation gain 1000  =  0.004883 mV/count.
   The pipeline works in Q4 units (4 x counts), so divide by 4 again.
   If your module has a different gain, change CAL_GAIN or press 'c'.      */
#define Q4_TO_MV_BASE    0.00122075f
float calGain = 1.00f;

/* on-board screening thresholds (tune against your own recordings) */
#define TH_P_ABN          0.28f
#define TH_Q_ABN         -0.33f
#define TH_R_ABN          1.05f
#define BPM_BRADY         50
#define BPM_TACHY        120

/* ---------------- simulation tables (one 750 ms beat = 80 bpm) ---------- */
const int16_t SIM_NORM[150] PROGMEM = {
     0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,
     0,    0,    1,    2,    3,    4,    6,    9,   12,   16,   20,   25,   29,   32,   34,
    35,   34,   32,   29,   25,   20,   16,   12,    9,    6,    4,    3,    2,    1,    0,
     0,    0,   -1,   -3,   -9,  -20,  -38,  -55,  -64,  -52,  -17,   32,   83,  127,  155,
   164,  154,  126,   87,   44,    6,  -21,  -33,  -33,  -26,  -16,   -7,   -1,    3,    5,
     7,    8,   10,   12,   14,   16,   19,   21,   24,   27,   31,   34,   37,   41,   44,
    47,   50,   53,   55,   58,   59,   60,   61,   61,   61,   60,   59,   58,   55,   53,
    50,   47,   44,   41,   37,   34,   31,   27,   24,   21,   19,   16,   14,   12,   10,
     8,    7,    6,    5,    4,    3,    2,    2,    1,    1,    1,    1,    1,    0,    0,
     0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,
};
const int16_t SIM_ABN[150] PROGMEM = {
     0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,
     1,    1,    2,    4,    6,   10,   15,   21,   30,   39,   50,   61,   71,   79,   84,
    86,   84,   79,   71,   61,   50,   39,   30,   21,   15,   10,    6,    4,    2,    1,
     1,    0,   -1,   -5,  -14,  -33,  -62,  -91, -104,  -83,  -26,   57,  144,  217,  265,
   281,  265,  219,  155,   85,   23,  -20,  -42,  -45,  -36,  -23,  -11,   -2,    3,    6,
     8,   10,   12,   14,   16,   19,   22,   25,   28,   32,   36,   40,   43,   47,   51,
    55,   59,   62,   65,   67,   69,   71,   71,   72,   71,   71,   69,   67,   65,   62,
    59,   55,   51,   47,   43,   40,   36,   32,   28,   25,   22,   19,   16,   14,   12,
    10,    8,    7,    5,    4,    4,    3,    2,    2,    1,    1,    1,    1,    0,    0,
     0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,
};

/* ---------------- objects & state ---------------- */
LiquidCrystal lcd(PIN_LCD_RS, PIN_LCD_EN, PIN_LCD_D4, PIN_LCD_D5,
                  PIN_LCD_D6, PIN_LCD_D7);

int16_t  buf[BUF_LEN];
uint8_t  head = 0;

int16_t  maRing[4] = {0, 0, 0, 0};
uint8_t  maIdx = 0;
int16_t  maSum = 0;

int32_t  baseAcc = 0;
bool     baseInit = false;
int32_t  envelope = 0;

uint8_t  detState = 0;              /* 0 idle, 1 rising, 2 post-R wait       */
int16_t  localMax = 0;
uint8_t  localPos = 0;
uint8_t  riseAge = 0;
uint8_t  postWait = 0;
uint8_t  rPos = 0;
uint32_t rSampleNo = 0, localSampleNo = 0, lastRSampleNo = 0;
uint32_t sampleNo = 0;

uint16_t rrHist[3] = {0, 0, 0};
uint8_t  rrIdx = 0, rrCount = 0;
int      bpm = 0;

float    fP = 0, fQ = 0, fR = 0, fS = 0;
uint8_t  abnStreak = 0, normStreak = 0;
bool     resultAbnormal = false;
bool     haveBeat = false;
uint32_t lastBeatMs = 0;

bool     streamOn   = false;   /* OFF by default -> Serial Monitor stays quiet
                                  (just "B,..." beat lines). host_monitor.py
                                  turns this on automatically for its plot. */
bool     beepOnBeat = true;
uint8_t  simMode    = 0;            /* 0 live, 1 sim normal, 2 sim abnormal  */
bool     calibrated = false;        /* becomes true after a successful 'c'  */
bool     humanDump  = false;        /* 'h' toggles a readable debug line    */
bool     analogDump = false;        /* 'd' toggles the A0..A5 pin finder    */
uint32_t lastHumanMs = 0;
uint32_t lastDumpMs  = 0;
uint32_t lastCalReminderMs = 0;
int16_t  lastRawADC = 0, lastFilteredQ4 = 0, lastThr = 0;   /* for 'h' dump */
uint16_t simIdx     = 0;
bool     calRequest = false;

uint32_t nextSampleUs = 0;
uint32_t lastLcdMs = 0;
uint8_t  lcdView = 0;
bool     decimate = false;

/* electrode / saturation watchdog */
uint8_t  satHits = 0;
uint16_t satWindow = 0;
bool     leadsOff = false;

/* buzzer scheduling */
uint32_t beepOffMs = 0;
uint8_t  alarmLeft = 0;
uint32_t alarmNextMs = 0;

byte heartChar[8] = {0b00000, 0b01010, 0b11111, 0b11111,
                     0b11111, 0b01110, 0b00100, 0b00000};

/* forward declarations (so the sketch builds on every IDE / CLI version) */
void    handleSerial();
void    beepService();
void    beepStart(uint16_t freq, uint16_t ms);
void    resetDetector();
int16_t readInput();
void    processSample(int16_t raw);
void    emitBeat();
void    updateLcd();
bool    signalPresent();
void    printPadded(const char *s);

/* ======================= helpers ======================= */

static inline float q4ToMv(int16_t q4) {
  return (float)q4 * Q4_TO_MV_BASE * calGain;
}

static inline int16_t at(int8_t off) {
  return buf[(uint8_t)((head + off) & BUF_MASK)];
}

void beepStart(uint16_t freq, uint16_t ms) {
#if BUZZER_IS_ACTIVE
  (void)freq;
  digitalWrite(PIN_BUZZER, HIGH);
#else
  tone(PIN_BUZZER, freq);
#endif
  beepOffMs = millis() + ms;
}

void beepService() {
  if (beepOffMs && millis() >= beepOffMs) {
    beepOffMs = 0;
#if BUZZER_IS_ACTIVE
    digitalWrite(PIN_BUZZER, LOW);
#else
    noTone(PIN_BUZZER);
#endif
  }
  if (alarmLeft && !beepOffMs && millis() >= alarmNextMs) {
    alarmLeft--;
    beepStart(3200, 90);
    alarmNextMs = millis() + 180;
  }
}

void resetDetector() {
  for (uint8_t i = 0; i < BUF_LEN; i++) buf[i] = 0;
  head = 0; maIdx = 0; maSum = 0;
  maRing[0] = maRing[1] = maRing[2] = maRing[3] = 0;
  baseInit = false; baseAcc = 0; envelope = 0;
  detState = 0; sampleNo = 0; lastRSampleNo = 0;
  satHits = 0; satWindow = 0; leadsOff = false;
  rrCount = 0; rrIdx = 0; bpm = 0;
  haveBeat = false; abnStreak = 0; normStreak = 0; resultAbnormal = false;
  fP = fQ = fR = fS = 0;
  simIdx = 0;
}

/* ======================= setup ======================= */

void setup() {
  Serial.begin(115200);
  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);
#if USE_LEADOFF_PINS
  pinMode(PIN_LO_P, INPUT);
  pinMode(PIN_LO_M, INPUT);
#endif

  lcd.begin(16, 2);
  lcd.createChar(0, heartChar);
  lcd.setCursor(0, 0); lcd.print(F("NeuroCardio  v1"));
  lcd.setCursor(0, 1); lcd.print(F("ECG front-end   "));

  Serial.println(F("# NeuroCardio ECG front-end v1.0"));
  Serial.println(F("# fs=200Hz  buf=128  cal=0.004883mV/count"));
  Serial.println(F("# D,<filtered_q4>            waveform @100Hz"));
  Serial.println(F("# B,<ms>,<bpm>,<P>,<Q>,<R>,<S>,<result>"));
  Serial.println(F("# cmds: ? s t b c r"));

  beepStart(1800, 120);
  delay(1200);
  lcd.clear();
  lcd.setCursor(0, 0); lcd.print(F("HR:--- bpm"));
  lcd.setCursor(0, 1); lcd.print(F("PLACE ELECTRODES"));

  resetDetector();
  nextSampleUs = micros();
  lastBeatMs = millis();
}

/* ======================= main loop ======================= */

void loop() {
  handleSerial();
  beepService();

  uint32_t now = micros();
  if ((int32_t)(now - nextSampleUs) >= 0) {
    nextSampleUs += SAMPLE_US;
    if ((int32_t)(micros() - nextSampleUs) > (int32_t)SAMPLE_US)
      nextSampleUs = micros() + SAMPLE_US;      /* recover from long stalls */
    processSample(readInput());
  }

  if (millis() - lastLcdMs >= 700) {
    lastLcdMs = millis();
    updateLcd();
  }

  /* analog-pin finder: 10x/sec dump of every analog input, for wiring checks */
  if (analogDump && millis() - lastDumpMs >= 100) {
    lastDumpMs = millis();
    Serial.print(F("A,"));
    for (uint8_t i = 0; i < 6; i++) {
      Serial.print(analogRead(A0 + i));
      Serial.print(i < 5 ? ',' : '\n');
    }
  }

  /* human-readable debug line: raw ADC, filtered mV, detector state */
  if (humanDump && millis() - lastHumanMs >= 200) {
    lastHumanMs = millis();
    const __FlashStringHelper *stateName =
      detState == 0 ? F("IDLE") : detState == 1 ? F("RISING") : F("POST-R");
    Serial.print(F("# H  raw=")); Serial.print(lastRawADC);
    Serial.print(F("  filtered="));  Serial.print(q4ToMv(lastFilteredQ4), 3);
    Serial.print(F("mV  thr="));     Serial.print(q4ToMv(lastThr), 3);
    Serial.print(F("mV  state="));   Serial.print(stateName);
    Serial.print(F("  leads="));     Serial.print(leadsOff ? F("OFF") : F("ok"));
    Serial.print(F("  cal="));       Serial.println(calibrated ? F("yes") : F("NO"));
  }

  /* gentle nag: only while LIVE and not yet calibrated */
  if (simMode == 0 && !calibrated && signalPresent() &&
      millis() - lastCalReminderMs >= 5000) {
    lastCalReminderMs = millis();
    Serial.println(F("# reminder: press 'c' on a clean beat to calibrate"));
  }
}

/* ======================= acquisition ======================= */

int16_t readInput() {
  if (simMode == 0) return (int16_t)analogRead(PIN_ECG);

  const int16_t *tab = (simMode == 1) ? SIM_NORM : SIM_ABN;
  int16_t v = (int16_t)pgm_read_word(&tab[simIdx]);
  simIdx++;
  if (simIdx >= 150) simIdx = 0;
  /* +/-2 count dither so the detector sees realistic noise */
  return 512 + v + (int16_t)(random(0, 5) - 2);
}

/* ======================= DSP + detection ======================= */

void processSample(int16_t raw) {
  sampleNo++;

  /* 4-tap moving average: zeros at 50 Hz and 100 Hz when fs = 200 Hz */
  maSum += raw - maRing[maIdx];
  maRing[maIdx] = raw;
  maIdx = (maIdx + 1) & 3;

  /* IIR high-pass: subtract the slow baseline (wander + electrode DC) */
  if (!baseInit) { baseAcc = (int32_t)maSum << BASE_SHIFT; baseInit = true; }
  int32_t base = baseAcc >> BASE_SHIFT;
  baseAcc += (int32_t)maSum - base;
  int16_t fq = (int16_t)((int32_t)maSum - base);      /* Q4 units */

  /* electrode watchdog: a detached lead rails the amplifier output */
  if (raw <= 5 || raw >= 1018) { if (satHits < 255) satHits++; }
  if (++satWindow >= FS) {                 /* evaluate once per second */
    leadsOff = (satHits > (FS / 10));
    satWindow = 0; satHits = 0;
  }

  head = (head + 1) & BUF_MASK;
  buf[head] = fq;

  if (streamOn && (decimate = !decimate)) {           /* 100 Hz to the PC */
    Serial.print(F("D,"));
    Serial.println(fq);
  }

  /* adaptive threshold from a slowly decaying peak envelope */
  if (fq > envelope) envelope = fq;
  else               envelope -= (envelope >> ENV_DECAY_SHIFT) + 1;
  int32_t thr = (envelope * THRESH_NUM) / THRESH_DEN;
  if (thr < THRESH_MIN) thr = THRESH_MIN;

  lastRawADC = raw; lastFilteredQ4 = fq; lastThr = (int16_t)thr;  /* for 'h' dump */

  if (sampleNo < WARMUP_SAMPLES) return;
  if (leadsOff) { detState = 0; return; }

  switch (detState) {
    case 0:
      if (fq > thr && (sampleNo - lastRSampleNo) > REFRACTORY) {
        detState = 1; localMax = fq; localPos = head;
        localSampleNo = sampleNo; riseAge = 0;
      }
      break;

    case 1:
      riseAge++;
      if (fq > localMax) { localMax = fq; localPos = head; localSampleNo = sampleNo; }
      if (fq < (localMax >> 1) || riseAge > PEAK_SEARCH_MAX) {
        detState = 2; postWait = POST_R_WAIT;
        rPos = localPos; rSampleNo = localSampleNo;
      }
      break;

    case 2:
      if (--postWait == 0) {
        emitBeat();
        lastRSampleNo = rSampleNo;
        detState = 0;
      }
      break;
  }
}

/* Measure P, Q, R, S against the local isoelectric (TP segment) reference.
   The P and reference windows scale with the current R-R interval so the
   measurement stays valid at higher heart rates. */
void emitBeat() {
  uint16_t rr = 160;                            /* default 800 ms */
  if (lastRSampleNo != 0) {
    uint32_t d = rSampleNo - lastRSampleNo;
    if (d >= 50 && d <= 400) rr = (uint16_t)d;
  }

  int8_t refA = -(int8_t)min(64, (int)((uint32_t)rr * 2 / 5));   /* TP segment */
  int8_t refB = refA + 10;
  int8_t pA   = -(int8_t)min(46, (int)((uint32_t)rr * 3 / 10));  /* P search   */
  int8_t pB   = -(int8_t)min(20, (int)((uint32_t)rr * 13 / 100));
  if (pB <= pA) pB = pA + 4;

  uint8_t save = head;
  head = rPos;                       /* reuse at() with R as origin */

  int32_t ref = 0;
  for (int8_t o = refA; o < refB; o++) ref += at(o);
  ref /= (refB - refA);

  int16_t R = at(0) - (int16_t)ref;

  int16_t Q = 32767;
  for (int8_t o = -18; o <= -2; o++) { int16_t v = at(o); if (v < Q) Q = v; }
  Q -= (int16_t)ref;

  int16_t S = 32767;
  for (int8_t o = 2; o <= 16; o++) { int16_t v = at(o); if (v < S) S = v; }
  S -= (int16_t)ref;

  int16_t P = -32768;
  for (int8_t o = pA; o <= pB; o++) { int16_t v = at(o); if (v > P) P = v; }
  P -= (int16_t)ref;

  head = save;

  if (calRequest) {                  /* make this beat's R read 1.00 mV */
    calRequest = false;
    if (R > 20) {
      calGain = 1.00f / ((float)R * Q4_TO_MV_BASE);
      calibrated = true;
      Serial.print(F("# CALIBRATED. calGain=")); Serial.println(calGain, 4);
    } else {
      Serial.println(F("# calibration failed: R too small (bad contact? "
                       "check electrodes and try again)"));
    }
  }

  fP = q4ToMv(P); fQ = q4ToMv(Q); fR = q4ToMv(R); fS = q4ToMv(S);

  /* heart rate: 3-beat average of the R-R interval */
  if (lastRSampleNo != 0) {
    uint32_t d = rSampleNo - lastRSampleNo;
    if (d >= 50 && d <= 400) {                   /* 30..240 bpm plausible */
      rrHist[rrIdx] = (uint16_t)d;
      rrIdx = (rrIdx + 1) % 3;
      if (rrCount < 3) rrCount++;
      uint32_t sum = 0;
      for (uint8_t i = 0; i < rrCount; i++) sum += rrHist[i];
      bpm = (int)((60UL * FS * rrCount) / sum);
    }
  }

  /* on-board 2-of-3 screening rule */
  uint8_t score = 0;
  if (fP >  TH_P_ABN) score++;
  if (fQ <  TH_Q_ABN) score++;
  if (fR >  TH_R_ABN) score++;
  bool abn = (score >= 2);
  if (bpm && (bpm < BPM_BRADY || bpm > BPM_TACHY)) abn = true;

  if (abn) { abnStreak++; normStreak = 0; } else { normStreak++; abnStreak = 0; }
  bool trustResult = (simMode != 0) || calibrated;   /* sim tables are pre-scaled */
  if (abnStreak  >= 3 && !resultAbnormal && trustResult) {
    resultAbnormal = true;
    alarmLeft = 3; alarmNextMs = millis();
  }
  if (normStreak >= 3) resultAbnormal = false;

  haveBeat = true;
  lastBeatMs = millis();
  if (beepOnBeat && !alarmLeft) beepStart(2200, 12);

  Serial.print(F("B,"));   Serial.print(lastBeatMs);
  Serial.print(',');       Serial.print(bpm);
  Serial.print(',');       Serial.print(fP, 4);
  Serial.print(',');       Serial.print(fQ, 4);
  Serial.print(',');       Serial.print(fR, 4);
  Serial.print(',');       Serial.print(fS, 4);
  Serial.print(',');       Serial.println(
      trustResult ? (resultAbnormal ? F("ABNORMAL") : F("NORMAL")) : F("NORMAL"));
  if (!trustResult)
    Serial.println(F("# ^ UNCALIBRATED - press 'c' before trusting this "
                     "beat's result (P/Q/R above are still real, just "
                     "possibly on the wrong scale)"));
}

/* ======================= LCD ======================= */

bool signalPresent() {
  if (leadsOff) return false;
#if USE_LEADOFF_PINS
  if (digitalRead(PIN_LO_P) == HIGH || digitalRead(PIN_LO_M) == HIGH) return false;
#endif
  return haveBeat && (millis() - lastBeatMs) < LEADOFF_TIMEOUT;
}

void printPadded(const char *s) {
  uint8_t n = 0;
  while (s[n]) { lcd.write(s[n]); n++; }
  while (n < 16) { lcd.write(' '); n++; }
}

void updateLcd() {
  char line[17];
  char a[8], b[8];

  /* ---- line 1 : heart rate ---- */
  lcd.setCursor(0, 0);
  if (signalPresent() && bpm > 0) snprintf(line, sizeof(line), "HR:%3d bpm     ", bpm);
  else                            snprintf(line, sizeof(line), "HR:--- bpm     ");
  printPadded(line);
  lcd.setCursor(14, 0);
  lcd.write(simMode == 0 ? ' ' : (simMode == 1 ? 'N' : 'A'));
  lcd.setCursor(15, 0);
  if (signalPresent()) lcd.write((uint8_t)0); else lcd.write(' ');

  /* ---- line 2 : rotating detail ---- */
  lcd.setCursor(0, 1);
  if (!signalPresent()) {
    printPadded(leadsOff ? "LEAD OFF - CHECK" : "PLACE ELECTRODES");
    lcdView = 0;
    return;
  }
  switch (lcdView) {
    case 0:
      dtostrf(fP, 5, 2, a); dtostrf(fQ, 5, 2, b);
      snprintf(line, sizeof(line), "P%s Q%s", a, b);
      break;
    case 1:
      dtostrf(fR, 5, 2, a);
      snprintf(line, sizeof(line), "R%s mV", a);
      break;
    default:
      if (simMode == 0 && !calibrated)
        snprintf(line, sizeof(line), "CALIBRATE: c");
      else
        snprintf(line, sizeof(line), "RESULT: %s",
                 resultAbnormal ? "ABNORM" : "NORMAL");
      break;
  }
  printPadded(line);
  lcdView = (lcdView + 1) % 3;
}

/* ======================= serial commands ======================= */

void handleSerial() {
  while (Serial.available()) {
    char c = Serial.read();
    switch (c) {
      case 's':
        streamOn = !streamOn;
        Serial.print(F("# stream ")); Serial.println(streamOn ? F("ON") : F("OFF"));
        break;
      case 'b':
        beepOnBeat = !beepOnBeat;
        Serial.print(F("# beat beep ")); Serial.println(beepOnBeat ? F("ON") : F("OFF"));
        break;
      case 't':
        simMode = (simMode + 1) % 3;
        resetDetector();
        Serial.print(F("# mode "));
        Serial.println(simMode == 0 ? F("LIVE") :
                       simMode == 1 ? F("SIM-NORMAL") : F("SIM-ABNORMAL"));
        if (simMode == 0 && !calibrated)
          Serial.println(F("# LIVE mode: press 'c' on a clean beat to "
                           "calibrate before trusting NORMAL/ABNORMAL"));
        break;
      case 'c':
        calRequest = true;
        Serial.println(F("# calibrating on next beat..."));
        break;
      case 'r':
        calGain = 1.0f;
        calibrated = false;
        resetDetector();
        Serial.println(F("# reset (calibration cleared)"));
        break;
      case 'd':
        analogDump = !analogDump;
        if (analogDump)
          Serial.println(F("# ANALOG SCAN on: A,<A0>,<A1>,<A2>,<A3>,<A4>,<A5>"
                           " - watch which one pulses with your heartbeat"));
        else
          Serial.println(F("# analog scan off"));
        break;
      case 'h':
        humanDump = !humanDump;
        Serial.print(F("# human-readable debug ")); Serial.println(humanDump ? F("ON") : F("OFF"));
        break;
      case '?':
        Serial.println(F("# s=stream t=mode b=beep c=cal r=reset d=analog-scan h=readable-debug"));
        break;
      default:
        break;
    }
  }
}
