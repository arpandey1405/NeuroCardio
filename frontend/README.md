# NeuroCardio dashboard (Next.js)

The web front end for NeuroCardio. It shows the live ECG strip, per-beat
features and Random Forest verdicts, controls the Arduino, reviews recorded
sessions and lets you probe the classifier.

This app is UI only. The Python backend `host/dashboard.py` owns the serial
port, the model and the CSV recordings. The browser connects to it directly
over HTTP and Server-Sent Events.

## Run it

Two terminals, both started from the `NeuroCardio/` folder:

```bash
python host/dashboard.py --no-browser          # backend on :8050 (synthetic signal)
python host/dashboard.py --no-browser --port COM5   # ...or straight onto the Arduino
```

```bash
cd frontend
npm install        # first time only
npm run dev        # http://localhost:3000
```

For a production build: `npm run build`, then `npm start`.

### SNN preview (until the trained SNN is ready)

Use the **Model** toggle in the Controls card (*Random Forest* / *SNN*), or start
the backend already in that mode:

```bash
python host/dashboard.py --no-browser --model snn-preview
```

SNN mode adds a **Spiking neural network** card under the ECG strip. Every beat is
cut and spike-encoded exactly as in the training notebook (60-sample window,
ON/OFF level crossing). The spikes then run through a small **untrained** LIF
network, and the card shows the spike rasters, firing rates and synaptic
operations. Verdicts still come from the Random Forest, and the card says so.
When `neurocardio_snn.pt` is ready, the trained network replaces the preview.

If the backend runs somewhere other than `http://127.0.0.1:8050`, set
`NEXT_PUBLIC_API_URL` in `frontend/.env.local`. The backend accepts browser
requests only from `localhost` / `127.0.0.1` origins.

## Pages

| Route       | What it does |
|-------------|--------------|
| `/`         | Live monitor: ECG strip (sweep / scroll), heart rate, verdict + confidence, P/Q/R/S bars against class ranges and device thresholds, trends, beat log, controls, event log, alarm banner and optional sound |
| `/sessions` | Every `host/session_*.csv`, with stats, charts, a beat table and a CSV download |
| `/lab`      | P/Q/R sliders and presets → live prediction, synthesised beat, position in the training data, feature importance |
| `/system`   | Signal chain, firmware facts, serial protocol, limitations and roadmap |

The same keyboard shortcuts as `host_monitor.py` work on any page. Live mode:
`t c s b d h r`. Synthetic mode: `x` (auto episodes), `n` (normal), `a` (abnormal).

## Layout

```
src/app/                 routes (layout, /, /sessions, /lab, /system)
src/components/
  live-provider.tsx      one EventSource for the whole app: status, beats, logs, model
  shell.tsx              sidebar, header, source pill, record + theme buttons, alarm banner
  monitor/               ECG strip (canvas), KPI cards, charts, beat log, controls
  sessions-view.tsx, lab-view.tsx
src/lib/
  wave-store.ts          ECG ring buffer outside React (100 samples/s, no re-renders)
  api.ts, types.ts, format.ts
```
