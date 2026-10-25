# NeuroCardio SNN training notebook

`NeuroCardio_SNN_Training.ipynb` trains the spiking neural network that the
dashboard runs live on the laptop. It uses MIT-BIH beats processed through a
software copy of the NeuroCardio firmware, so the model learns from the same
signal the electrodes deliver.

The same file runs on **Google Colab**, **Kaggle** or a local Jupyter. It
detects where it is and sets paths, data loading and downloads to match.

## Run it on Google Colab
1. colab.research.google.com → **File → Upload notebook**, and pick
   `NeuroCardio_SNN_Training.ipynb`.
2. **Runtime → Change runtime type → T4 GPU**.
3. Choose how the data gets in with `COLAB_DATA` in the configuration cell:
   - `"upload"` (default): when the data cell runs, click **Choose files** and
     pick `mit-bih-arrhythmia-database-1.0.0.zip` (73 MB).
   - `"drive"`: put the zip in your Google Drive (top level or one folder
     down). The notebook mounts Drive and finds it. This is faster for re-runs.
   - `"download"`: fetch it from PhysioNet (can be slow).
4. **Runtime → Run all**, and keep the tab open (Colab stops idle sessions).
5. At the end the browser downloads `neurocardio_snn.pt` and the two result
   CSVs (allow multiple downloads if asked). They're also in the **Files**
   panel under `/content`. Put the `.pt` in `NeuroCardio/host/models/`.

## Run it on Kaggle
1. kaggle.com → **Create → New Notebook** → **File → Import Notebook**, and
   pick `NeuroCardio_SNN_Training.ipynb`.
2. In **Settings** (right-hand panel):
   - **Accelerator → GPU T4 x2**. The P100 may not work with Kaggle's
     PyTorch; if the GPU fails, the notebook falls back to CPU and says so.
   - **Internet → On**. This is needed for `pip install wfdb snntorch`, and
     Kaggle only allows it on a phone-verified account.
3. **Add Input → Upload → New Dataset**, then upload
   `mit-bih-arrhythmia-database-1.0.0.zip`. The notebook finds the records
   anywhere under `/kaggle/input`, whether Kaggle extracted the zip or not.
   With no input attached, it downloads MIT-BIH from PhysioNet (slower).
4. **Run All**, or **Save Version → Save & Run All (Commit)** to run it in the
   background.
5. Everything is written to `/kaggle/working`. Download the files from the
   **Output** panel (or the committed version's *Output* tab).

## What you get
- `neurocardio_snn.pt`: the model plus every pre-processing parameter.
  Put it in `NeuroCardio/host/models/`.
- `neurocardio_model_comparison.csv`: SNN vs. Random Forest vs. 1D CNN.
- `neurocardio_snn_efficiency.csv`: spikes, synaptic ops and energy estimate.

Set `QUICK_TEST = True` in the configuration cell for a ~2 minute dry run
that only checks the pipeline. A full run took 8 minutes on a laptop CPU, so
it should take a few minutes on a GPU.

## What the dashboard has to reproduce
Everything is stored in `neurocardio_snn.pt["config"]`:

| Step | Value |
|---|---|
| Input | firmware `D,` stream, 100 Hz, mV = q4 × 0.00122075 |
| R peak | argmax of the last 30 samples when the beat is reported |
| Window | 20 samples before R + 40 from R = 60 steps (0.6 s) |
| Normalise | (x − median) / std |
| Encode | level crossing, threshold 0.30, 2 channels (ON, OFF) |
| Network | Linear(2,64) → LIF → Linear(64,64) → LIF → Linear(64,2), β = 0.9 |
| Output | sum over time → softmax → abnormal if p ≥ `decision_threshold` |
