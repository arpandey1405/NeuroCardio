"""
NeuroCardio - SNN preview (stand-in until the trained SNN is ready)

Runs the real front half of the SNN pipeline on every beat: the same 60-sample
window, normalisation and ON/OFF level-crossing encoding as
notebook/NeuroCardio_SNN_Training.ipynb. The spikes then go through a small
*untrained* leaky integrate-and-fire network, so the dashboard can show
spiking activity.

It does NOT classify. Verdicts still come from the Random Forest, and the
dashboard says so. Swap in the trained neurocardio_snn.pt when it exists.
"""

import numpy as np

# must match the training notebook
PRE, POST = 20, 40                 # samples at 100 Hz around R
N_STEPS = PRE + POST
LC_THRESHOLD = 0.30
BETA = 0.90                        # membrane decay per step
V_TH = 1.0                         # firing threshold
H1, H2 = 32, 16                    # preview layer sizes


def normalize_beat(beat):
    beat = np.asarray(beat, dtype=np.float32)
    s = beat.std()
    return beat - np.median(beat) if s < 1e-8 else (beat - np.median(beat)) / s


def level_crossing_encode(beat, threshold=LC_THRESHOLD):
    """-> spikes [N_STEPS, 2] (ON, OFF), values 0/1, tracking reference."""
    spikes = np.zeros((len(beat), 2), np.float32)
    ref = beat[0]
    for t in range(1, len(beat)):
        d = beat[t] - ref
        if d >= threshold:
            spikes[t, 0] = 1
            ref += threshold * np.floor(d / threshold)
        elif d <= -threshold:
            spikes[t, 1] = 1
            ref -= threshold * np.floor(-d / threshold)
    return spikes


class PreviewSNN:
    """Two LIF layers with fixed random weights - for visualisation only."""

    label = "SNN preview"

    def __init__(self, seed=7):
        rng = np.random.default_rng(seed)
        # each hidden neuron prefers ON or OFF events, so the raster has structure
        pref = rng.random(H1) < 0.5
        self.w1 = np.where(pref, [[1.0], [0.25]], [[0.25], [1.0]]) * rng.uniform(0.35, 0.9, (2, H1))
        self.w2 = rng.normal(0.06, 0.12, (H1, H2))

    def run(self, window_mv):
        beat = normalize_beat(window_mv)
        x = level_crossing_encode(beat)
        v1, v2 = np.zeros(H1), np.zeros(H2)
        s1 = np.zeros((N_STEPS, H1), bool)
        s2 = np.zeros((N_STEPS, H2), bool)
        for t in range(N_STEPS):
            v1 = BETA * v1 + x[t] @ self.w1
            s1[t] = v1 >= V_TH
            v1[s1[t]] -= V_TH                      # reset by subtraction
            v2 = BETA * v2 + s1[t].astype(float) @ self.w2
            s2[t] = v2 >= V_TH
            v2[s2[t]] -= V_TH

        n_in, n1, n2 = int(x.sum()), int(s1.sum()), int(s2.sum())
        synops = n_in * H1 + n1 * H2               # one accumulate per spike per synapse
        dense = N_STEPS * (2 * H1 + H1 * H2)       # same net run densely (MACs)
        return dict(
            window=[round(float(v), 3) for v in beat],
            on=np.flatnonzero(x[:, 0]).tolist(),
            off=np.flatnonzero(x[:, 1]).tolist(),
            h1=np.argwhere(s1).tolist(),           # [t, neuron]
            h2=np.argwhere(s2).tolist(),
            sizes=dict(steps=N_STEPS, h1=H1, h2=H2),
            stats=dict(input_events=n_in, input_sparsity=round(1 - n_in / (2 * N_STEPS), 3),
                       h1_spikes=n1, h2_spikes=n2,
                       h1_rate=round(n1 / (H1 * N_STEPS), 3), h2_rate=round(n2 / (H2 * N_STEPS), 3),
                       synops=synops, dense_macs=dense),
        )
