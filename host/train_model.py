"""
NeuroCardio - retrain the beat classifier from data.csv

WHY THIS EXISTS
    The .pkl / .joblib files you inherited were pickled with scikit-learn
    1.0.2 (Oct 2024). On any modern scikit-learn they fail to load with:

        ValueError: node array from the pickle has an incompatible dtype
        ModuleNotFoundError: No module named 'sklearn.ensemble._gb_losses'

    Pickles are not portable across scikit-learn versions. Rather than pin an
    old version, retrain from the source data - it takes under a second and
    the models are then guaranteed to load on your machine.

RUN
    python train_model.py

OUTPUT
    models/rf_model.joblib
    models/label_encoder.joblib
"""

import os
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.svm import SVC
from sklearn.preprocessing import LabelEncoder
from sklearn.model_selection import train_test_split, cross_val_score
from sklearn.metrics import classification_report, confusion_matrix
import joblib

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data.csv")
OUTDIR = os.path.join(HERE, "models")
FEATURES = ["P", "Q", "R"]


def main():
    df = pd.read_csv(DATA)
    print(f"Loaded {len(df)} samples from data.csv")
    print(df.groupby("Label")[FEATURES].agg(["min", "max"]).round(3))
    print()

    X = df[FEATURES]
    le = LabelEncoder()
    y = le.fit_transform(df["Label"])
    print(f"Classes: {dict(enumerate(le.classes_))}\n")

    X_tr, X_te, y_tr, y_te = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )

    models = {
        "RandomForest": RandomForestClassifier(n_estimators=200, random_state=42),
        "LogisticRegression": LogisticRegression(max_iter=1000),
        "SVC": SVC(probability=True, random_state=42),
    }

    for name, m in models.items():
        m.fit(X_tr, y_tr)
        cv = cross_val_score(m, X, y, cv=5)
        print(f"{name:20s} test={m.score(X_te, y_te):.3f}  "
              f"5-fold CV={cv.mean():.3f} +/- {cv.std():.3f}")

    rf = models["RandomForest"]
    print("\nRandom Forest, held-out test set:")
    print(classification_report(y_te, rf.predict(X_te), target_names=le.classes_))
    print("Confusion matrix (rows = true, cols = predicted):")
    print(pd.DataFrame(confusion_matrix(y_te, rf.predict(X_te)),
                       index=le.classes_, columns=le.classes_))
    print("\nFeature importances:",
          dict(zip(FEATURES, np.round(rf.feature_importances_, 3))))

    # Retrain on all 100 rows before saving - the dataset is tiny.
    rf_final = RandomForestClassifier(n_estimators=200, random_state=42).fit(X, y)

    os.makedirs(OUTDIR, exist_ok=True)
    joblib.dump(rf_final, os.path.join(OUTDIR, "rf_model.joblib"))
    joblib.dump(le, os.path.join(OUTDIR, "label_encoder.joblib"))
    print(f"\nSaved -> {OUTDIR}/rf_model.joblib, label_encoder.joblib")

    # Sanity-check against the feature values the firmware actually produces
    print("\nSanity check on firmware-measured feature vectors:")
    probes = [("sim NORMAL   80 bpm", (0.173, -0.245, 0.740)),
              ("sim NORMAL  109 bpm", (0.132, -0.289, 0.700)),
              ("sim ABNORMAL 80 bpm", (0.412, -0.413, 1.254))]
    for label, v in probes:
        p = rf_final.predict_proba(pd.DataFrame([v], columns=FEATURES))[0]
        print(f"  {label}  P={v[0]:+.3f} Q={v[1]:+.3f} R={v[2]:+.3f}"
              f"  ->  {le.classes_[p.argmax()]}  (conf {p.max():.2f})")

    print("\nNOTE FOR THE REVIEW: data.csv is 100 rows of *synthetic* data whose\n"
          "two classes do not overlap at all (Normal P maxes at 0.197, Abnormal\n"
          "P starts at 0.303). Any classifier scores 100%. Say this before the\n"
          "examiner asks - it is a Review-2 problem to solve with real records\n"
          "(MIT-BIH / PTB-XL), not something to defend.")


if __name__ == "__main__":
    main()
