// Ring buffer behind the ECG strip. Lives outside React so 100 samples/s never
// trigger re-renders, and so the strip keeps its history across page changes.
export const FS = 100;
export const SECONDS = 6;
export const N = FS * SECONDS;

export type Marker = { abs: number; abn: boolean; bpm: number };

class WaveStore {
  buf = new Float32Array(N).fill(NaN);
  total = 0;          // samples written into buf (absolute index)
  received = 0;       // samples received from the server (absolute index)
  pending: number[] = [];
  recent: [number, number][] = [];
  markers: Marker[] = [];
  lastSampleAt = 0;

  reset() {
    this.buf.fill(NaN);
    this.total = 0;
    this.received = 0;
    this.pending = [];
    this.recent = [];
    this.markers = [];
  }

  receive(samples: number[]) {
    for (const v of samples) {
      this.pending.push(v);
      this.recent.push([this.received++, v]);
    }
    if (this.recent.length > 60) this.recent.splice(0, this.recent.length - 60);
    if (this.pending.length > 3000) this.pending.splice(0, this.pending.length - N);
    this.lastSampleAt = performance.now();
  }

  /** Write straight into the strip, no animation (used on (re)connect). */
  prefill(samples: number[]) {
    for (const v of samples.slice(-N)) {
      this.buf[this.total % N] = v;
      this.total++;
      this.received++;
    }
    if (samples.length) this.lastSampleAt = performance.now();
  }

  /** The R peak is the tallest of the most recently received samples. */
  markBeat(abn: boolean, bpm: number) {
    let best: [number, number] | null = null;
    for (const r of this.recent.slice(-40)) if (!best || r[1] > best[1]) best = r;
    if (best) this.markers.push({ abs: best[0], abn, bpm });
    if (this.markers.length > 40) this.markers.shift();
  }

  /** Move `count` pending samples into the visible buffer. */
  advance(count: number) {
    for (const v of this.pending.splice(0, count)) {
      this.buf[this.total % N] = v;
      this.total++;
    }
  }
}

export const wave = new WaveStore();
