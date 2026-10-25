"""
NeuroCardio - trained spiking neural network for live beat classification.

Loads host/models/neurocardio_snn.pt, exported by
notebook/NeuroCardio_SNN_Training.ipynb, and runs it on the laptop with NumPy.
The pre-processing is exactly the notebook's: a 60-sample window of the 100 Hz
'D,' stream around R, median/std normalisation, and ON/OFF level-crossing
spikes. The LIF update reproduces snnTorch's `Leaky` neuron (reset by
subtraction, reset_delay=True) step for step, so the outputs match the
notebook. Only PyTorch is needed to read the .pt file; snnTorch is not.
"""

import os

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PATH = os.path.join(HERE, "models", "neurocardio_snn.pt")


def normalize_beat(beat):
    beat = np.asarray(beat, dtype=np.float32)
    s = beat.std()
    return beat - np.median(beat) if s < 1e-8 else (beat - np.median(beat)) / s


def level_crossing_encode(beat, threshold):
    """-> spikes [T, 2] (ON, OFF), values 0/1, tracking reference (as in the notebook)."""
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


class TrainedSNN:
    """The notebook's ECG_SNN: Linear(2,H) - LIF - Linear(H,H) - LIF - Linear(H,2)."""

    def __init__(self, path=DEFAULT_PATH):
        import torch  # only to read the checkpoint

        ck = torch.load(path, map_location="cpu", weights_only=True)
        if ck.get("format") != "neurocardio-snn-v1":
            raise ValueError(f"{os.path.basename(path)} is not a NeuroCardio SNN export")
        sd = {k: v.numpy().astype(np.float64) for k, v in ck["state_dict"].items()}
        cfg = ck["config"]
        self.config = cfg
        self.W1, self.b1 = sd["fc1.weight"], sd["fc1.bias"]
        self.W2, self.b2 = sd["fc2.weight"], sd["fc2.bias"]
        self.W3, self.b3 = sd["fc3.weight"], sd["fc3.bias"]
        self.beta = [float(np.clip(sd.get(f"lif{i}.beta", cfg["architecture"]["beta"]), 0, 1)) for i in (1, 2)]
        self.theta = [float(sd.get(f"lif{i}.threshold", 1.0)) for i in (1, 2)]
        for i in (1, 2):
            if float(sd.get(f"lif{i}.reset_mechanism_val", 0)) != 0:
                raise ValueError("only reset-by-subtraction LIF layers are supported")
        inp = cfg["input"]
        self.pre, self.post = int(inp["pre_samples"]), int(inp["post_samples"])
        self.steps = self.pre + self.post
        self.lc = float(inp["lc_threshold"])
        self.classes = list(cfg["classes"])
        self.threshold = float(cfg["decision_threshold"])
        self.hidden = int(self.W1.shape[0])
        self.label = "SNN"
        self.test_metrics = cfg.get("test_metrics", {})
        self.trained = cfg.get("trained")

    # ------------------------------------------------------------ network
    def forward(self, spikes):
        """spikes [T, 2] -> (logits[2], hidden-1 spikes [T,H], hidden-2 spikes [T,H], cumulative logits [T,2])."""
        T, H = len(spikes), self.hidden
        m1, m2 = np.zeros(H), np.zeros(H)
        s1 = np.zeros((T, H), bool)
        s2 = np.zeros((T, H), bool)
        logits, cum = np.zeros(2), np.zeros((T, 2))
        (b1, b2), (t1, t2) = self.beta, self.theta
        for t in range(T):
            cur1 = self.W1 @ spikes[t] + self.b1
            m1 = b1 * m1 + cur1 - (m1 - t1 > 0) * t1        # reset uses the previous membrane
            s1[t] = m1 - t1 > 0
            cur2 = self.W2 @ s1[t] + self.b2
            m2 = b2 * m2 + cur2 - (m2 - t2 > 0) * t2
            s2[t] = m2 - t2 > 0
            logits = logits + self.W3 @ s2[t] + self.b3
            cum[t] = logits
        return logits, s1, s2, cum

    @staticmethod
    def softmax(z):
        e = np.exp(z - np.max(z, axis=-1, keepdims=True))
        return e / e.sum(axis=-1, keepdims=True)

    # ------------------------------------------------------------ live use
    def run(self, window_mv):
        """Classify one beat window (pre+post samples of the 100 Hz stream, R at index `pre`)."""
        beat = normalize_beat(window_mv)
        x = level_crossing_encode(beat, self.lc)
        logits, s1, s2, cum = self.forward(x)
        p = self.softmax(logits)
        p_abn = float(p[1])
        label = self.classes[1] if p_abn >= self.threshold else self.classes[0]
        conf = p_abn if label == self.classes[1] else 1.0 - p_abn
        n_in, n1, n2 = int(x.sum()), int(s1.sum()), int(s2.sum())
        H = self.hidden
        synops = n_in * H + n1 * H + n2 * 2           # one accumulate per spike per outgoing synapse
        dense = self.steps * (2 * H + H * H + H * 2)  # the same network evaluated densely (MACs)
        return dict(
            label=label,
            conf=round(conf, 3),
            p_abnormal=round(p_abn, 4),
            threshold=self.threshold,
            trained=True,
            window=[round(float(v), 3) for v in beat],
            on=np.flatnonzero(x[:, 0]).tolist(),
            off=np.flatnonzero(x[:, 1]).tolist(),
            h1=np.argwhere(s1).tolist(),
            h2=np.argwhere(s2).tolist(),
            evidence=[round(float(v), 3) for v in self.softmax(cum)[:, 1]],
            sizes=dict(steps=self.steps, h1=H, h2=H),
            stats=dict(input_events=n_in, input_sparsity=round(1 - n_in / (2 * self.steps), 3),
                       h1_spikes=n1, h2_spikes=n2,
                       h1_rate=round(n1 / (H * self.steps), 3), h2_rate=round(n2 / (H * self.steps), 3),
                       synops=synops, dense_macs=dense),
        )


def load(path=DEFAULT_PATH):
    """TrainedSNN, or None if no trained model has been exported yet."""
    return TrainedSNN(path) if os.path.exists(path) else None
