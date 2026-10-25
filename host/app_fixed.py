"""
NeuroCardio - optional Flask page (fixed).

Changes vs the inherited app.py:
  * loads models/rf_model.joblib produced by train_model.py, instead of the
    scikit-learn 1.0.2 pickle that no longer unpickles;
  * predicts on a named DataFrame so scikit-learn stops warning about
    missing feature names;
  * returns the model's confidence as well as the label.

Run:  python app_fixed.py      then open http://127.0.0.1:5000
Put index.html in templates/ and style.css + background.jpg in static/.
"""
import os
import numpy as np
import pandas as pd
import joblib
from flask import Flask, request, render_template, jsonify

HERE = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__)

model = joblib.load(os.path.join(HERE, "models", "rf_model.joblib"))
label_encoder = joblib.load(os.path.join(HERE, "models", "label_encoder.joblib"))
FEATURES = ["P", "Q", "R"]


def generate_ecg_waveform(p, q, r):
    x = np.linspace(0, 1, 200)
    y = (0.1 * np.sin(2 * np.pi * 5 * (x - 0.1)) * (x < 0.2)
         - 0.15 * np.exp(-100 * (x - 0.25) ** 2) * (x < 0.3)
         + 0.8 * np.exp(-200 * (x - 0.3) ** 2)
         - 0.1 * np.exp(-100 * (x - 0.35) ** 2) * (x < 0.4)
         + 0.15 * np.sin(2 * np.pi * 2 * (x - 0.45)) * (x > 0.4))
    y = y * r + p * 0.02 - q * 0.01
    return {"x": x.tolist(), "y": y.tolist()}


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/predict", methods=["POST"])
def predict():
    try:
        p = float(request.form["p"])
        q = float(request.form["q"])
        r = float(request.form["r"])
        row = pd.DataFrame([[p, q, r]], columns=FEATURES)
        proba = model.predict_proba(row)[0]
        label = label_encoder.classes_[int(proba.argmax())]
        return jsonify({"prediction": str(label),
                        "confidence": round(float(proba.max()), 3),
                        "ecg_data": generate_ecg_waveform(p, q, r)})
    except Exception as e:
        return jsonify({"error": f"Prediction failed: {e}"}), 400


if __name__ == "__main__":
    app.run(debug=True)
