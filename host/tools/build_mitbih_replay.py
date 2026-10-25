"""
Build host/replay/mitbih_ds2_clips.npz - real MIT-BIH beats for the dashboard's
"MIT-BIH replay" source.

Each clip is 60 s of an MIT-BIH record from the DS2 test set (patients the SNN
never saw in training), passed through the same software copy of the
NeuroCardio firmware that the training notebook uses: 200 Hz 10-bit ADC,
4-tap moving average, IIR high-pass, 100 Hz 'D,' stream. Per beat, P/Q/R/S,
heart rate and the on-device screening verdict are measured with the
firmware's own emitBeat() rules, and the cardiologist annotation is kept as
ground truth.

Clips are chosen from the annotations alone (never from any model's output):
"normal" clips are the 60 s windows with the fewest non-N beats, "abnormal"
clips the windows with the most.

Data: MIT-BIH Arrhythmia Database (Moody & Mark), PhysioNet,
Open Data Commons Attribution License v1.0.

Usage:  python host/tools/build_mitbih_replay.py <folder with 100.hea, 100.dat, 100.atr, ...>
Needs:  pip install wfdb
"""
import os
import sys

import numpy as np
import wfdb
from scipy.signal import lfilter, resample_poly

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "replay", "mitbih_ds2_clips.npz")

FS_DEVICE, FS_STREAM = 200, 100
ADC_MV_PER_COUNT, ADC_MID, BASE_SHIFT, Q4_TO_MV = 5000 / 1024 / 1000, 512, 8, 0.00122075
TH_P, TH_Q, TH_R, BRADY, TACHY = 0.28, -0.33, 1.05, 50, 120       # firmware screening rule
N_SYM = set("NLRej")
ABN_SYM = set("AaJSVEF")
CLIP_S = 60

NORMAL_RECORDS = ["100", "103", "113", "117", "121", "234"]        # DS2, mostly normal rhythm
ABNORMAL_RECORDS = ["200", "233", "221", "228", "232", "213"]      # DS2, frequent non-N beats


def firmware_filter(sig_mv, fs):
    """MIT-BIH mV -> 200 Hz ADC counts -> 4-tap MA + IIR high-pass (Q4 units), as in the sketch."""
    x = resample_poly(sig_mv, FS_DEVICE, fs)
    adc = np.clip(np.round(x / ADC_MV_PER_COUNT) + ADC_MID, 0, 1023)
    ma = np.convolve(adc, np.ones(4), mode="full")[: len(adc)]
    k = 1.0 / (1 << BASE_SHIFT)
    base = lfilter([0.0, k], [1.0, -(1.0 - k)], ma, zi=[ma[0]])[0]
    return ma - base


def emit_beat(fq, r, rr):
    """Port of emitBeat(): amplitudes against the local TP-segment reference (200 Hz offsets)."""
    ref_a = -min(64, rr * 2 // 5)
    ref_b = ref_a + 10
    p_a = -min(46, rr * 3 // 10)
    p_b = -min(20, rr * 13 // 100)
    if p_b <= p_a:
        p_b = p_a + 4
    at = lambda o: fq[r + o]                                       # noqa: E731
    ref = int(sum(at(o) for o in range(ref_a, ref_b)) / (ref_b - ref_a))
    R = at(0) - ref
    Q = min(at(o) for o in range(-18, -1)) - ref
    S = min(at(o) for o in range(2, 17)) - ref
    P = max(at(o) for o in range(p_a, p_b + 1)) - ref
    return [v * Q4_TO_MV for v in (P, Q, R, S)]


def record_beats(rec_id, folder):
    path = os.path.join(folder, rec_id)
    rec, ann = wfdb.rdrecord(path), wfdb.rdann(path, "atr")
    lead = rec.sig_name.index("MLII") if "MLII" in rec.sig_name else 0
    fq = firmware_filter(rec.p_signal[:, lead], rec.fs)
    stream = (fq[::2] * Q4_TO_MV).astype(np.float32)               # what the laptop receives
    beats, last_r, rr_hist = [], None, []
    for samp, sym in zip(ann.sample, ann.symbol):
        if sym not in N_SYM | ABN_SYM:
            continue
        r = int(round(samp * FS_DEVICE / rec.fs))
        lo, hi = max(0, r - 16), min(len(fq), r + 17)              # snap to the filtered peak (+/- 80 ms)
        r = lo + int(np.argmax(fq[lo:hi]))
        if r < 4 * FS_DEVICE or r + 20 >= len(fq):                 # high-pass warm-up / end of record
            continue
        rr = 160 if last_r is None or not 50 <= r - last_r <= 400 else r - last_r
        if last_r is not None and 50 <= r - last_r <= 400:
            rr_hist = (rr_hist + [r - last_r])[-3:]
        bpm = int(60 * FS_DEVICE * len(rr_hist) / sum(rr_hist)) if rr_hist else 0
        P, Q, R, S = emit_beat(fq, r, rr)
        beats.append(dict(r100=int(round(r / 2)), sym=sym, abnormal=sym in ABN_SYM,
                          P=P, Q=Q, R=R, S=S, bpm=bpm))
        last_r = r
    # the firmware's device verdict: 2-of-3 screen or brady/tachy, confirmed over 3 beats
    abn_streak = norm_streak = 0
    result = False
    for b in beats:
        score = (b["P"] > TH_P) + (b["Q"] < TH_Q) + (b["R"] > TH_R)
        abn = score >= 2 or (b["bpm"] and (b["bpm"] < BRADY or b["bpm"] > TACHY))
        abn_streak, norm_streak = (abn_streak + 1, 0) if abn else (0, norm_streak + 1)
        if abn_streak >= 3:
            result = True
        if norm_streak >= 3:
            result = False
        b["device"] = result
    return stream, beats


def pick_clip(beats, want_abnormal):
    """60 s window (in 100 Hz samples) with the most / fewest non-N beats."""
    n = CLIP_S * FS_STREAM
    rs = np.array([b["r100"] for b in beats])
    ab = np.array([b["abnormal"] for b in beats])
    best, best_score = None, None
    for start in range(rs[0] + 50, rs[-1] - n, 5 * FS_STREAM):
        m = (rs >= start + 40) & (rs < start + n - 45)
        if m.sum() < 30:
            continue
        score = ab[m].sum() if want_abnormal else -ab[m].sum()
        if best_score is None or score > best_score:
            best, best_score = start, score
    return best


def main(folder):
    clips = []
    for kind, records in (("normal", NORMAL_RECORDS), ("abnormal", ABNORMAL_RECORDS)):
        for rec_id in records:
            stream, beats = record_beats(rec_id, folder)
            start = pick_clip(beats, kind == "abnormal")
            n = CLIP_S * FS_STREAM
            sel = [b for b in beats if start + 40 <= b["r100"] < start + n - 45]
            clips.append(dict(record=rec_id, kind=kind, wave=stream[start:start + n],
                              beats=[dict(b, r100=b["r100"] - start) for b in sel]))
            k = sum(b["abnormal"] for b in sel)
            syms = "".join(sorted({b["sym"] for b in sel}))
            print(f"{kind:8s} {rec_id}: {len(sel)} beats, {k} non-N  symbols {syms}")

    data = dict(fs=np.int32(FS_STREAM), n_clips=np.int32(len(clips)))
    for i, c in enumerate(clips):
        data[f"c{i}_record"] = np.array(c["record"])
        data[f"c{i}_kind"] = np.array(c["kind"])
        data[f"c{i}_wave"] = c["wave"].astype(np.float16)
        data[f"c{i}_r"] = np.array([b["r100"] for b in c["beats"]], np.int32)
        data[f"c{i}_sym"] = np.array([b["sym"] for b in c["beats"]])
        data[f"c{i}_feat"] = np.array([[b["P"], b["Q"], b["R"], b["S"]] for b in c["beats"]], np.float32)
        data[f"c{i}_bpm"] = np.array([b["bpm"] for b in c["beats"]], np.int16)
        data[f"c{i}_device"] = np.array([b["device"] for b in c["beats"]], bool)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    np.savez_compressed(OUT, **data)
    print(f"wrote {OUT} ({os.path.getsize(OUT) / 1024:.0f} KB)")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
