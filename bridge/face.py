"""
Reconhecimento facial local para o JARVIS.

Usa YuNet (detecção) + SFace (assinatura) via OpenCV ONNX — sem LLM, sem cloud.
Corre como subprocesso do bridge Node.js: recebe JSON em stdin, devolve JSON em stdout.

Comandos:
  verify   { "image": "<base64 JPEG>" }
           → { "verified": bool, "name": str|null, "score": float|null, "reason": str|null }

  enroll   { "name": "<nome>", "images": ["<base64>", ...] }
           → { "enrolled": bool, "name": str, "samples": int }

  forget   {}
           → { "forgotten": bool }

  status   {}
           → { "enrolled": bool, "name": str|null, "models_ok": bool }

Instalar dependências (uma vez):
  pip install opencv-python-headless numpy

Os modelos ficam em bridge/models/ (não entram no git — são 37 MB).
Para os obter, copie de face-hi ou corra:
  python bridge/face.py --download
"""

from __future__ import annotations

import json
import math
import os
import sys
import threading
from pathlib import Path

MODELS_DIR = Path(__file__).parent / "models"
DETECTOR_FILE = MODELS_DIR / "face_detection_yunet_2023mar.onnx"
RECOGNIZER_FILE = MODELS_DIR / "face_recognition_sface_2021dec.onnx"
FACE_DB = Path.home() / ".jarvis-face.json"

MATCH_THRESHOLD = 0.42
MIN_FACE_PX = 60
ENROLL_MIN_SAMPLES = 3

_lock = threading.Lock()
_engine: _Engine | None = None


# ---------------------------------------------------------------------------
# Download helper
# ---------------------------------------------------------------------------

def _download_models() -> None:
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    base = "https://github.com/opencv/opencv_zoo/raw/main/models"
    files = {
        DETECTOR_FILE: f"{base}/face_detection_yunet/face_detection_yunet_2023mar.onnx",
        RECOGNIZER_FILE: f"{base}/face_recognition_sface/face_recognition_sface_2021dec.onnx",
    }
    import urllib.request
    for path, url in files.items():
        if path.exists():
            print(f"  já existe: {path.name}", flush=True)
            continue
        print(f"  a transferir {path.name} …", flush=True)
        urllib.request.urlretrieve(url, path)
        print(f"  guardado em {path}", flush=True)


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------

class _Engine:
    def __init__(self) -> None:
        import cv2
        self._cv2 = cv2
        self._detector = cv2.FaceDetectorYN.create(
            str(DETECTOR_FILE), "", (320, 320), 0.8
        )
        self._recognizer = cv2.FaceRecognizerSF.create(str(RECOGNIZER_FILE), "")

    def embedding(self, image_bytes: bytes) -> list[float] | None:
        import numpy as np
        cv2 = self._cv2
        with _lock:
            frame = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)
            if frame is None:
                return None
            h, w = frame.shape[:2]
            scale = min(1.0, 640 / w)
            if scale < 1.0:
                frame = cv2.resize(frame, (int(w * scale), int(h * scale)))
            self._detector.setInputSize((frame.shape[1], frame.shape[0]))
            _, dets = self._detector.detect(frame)
            if dets is None or len(dets) == 0:
                return None
            # Pick the largest face
            best = sorted(dets, key=lambda d: d[2] * d[3], reverse=True)[0]
            # Minimum face size check
            if best[2] / scale < MIN_FACE_PX:
                return None
            feat = self._recognizer.feature(
                self._recognizer.alignCrop(frame, best)
            ).flatten()
            norm = float(np.linalg.norm(feat)) or 1.0
            return (feat / norm).tolist()


def _get_engine() -> _Engine | None:
    global _engine
    if _engine is not None:
        return _engine
    if not DETECTOR_FILE.exists() or not RECOGNIZER_FILE.exists():
        return None
    try:
        _engine = _Engine()
        return _engine
    except Exception as exc:
        sys.stderr.write(f"[face] engine init failed: {exc}\n")
        return None


# ---------------------------------------------------------------------------
# Face DB  (~/.jarvis-face.json)
# ---------------------------------------------------------------------------

def _load_db() -> dict:
    if FACE_DB.exists():
        try:
            return json.loads(FACE_DB.read_text())
        except Exception:
            pass
    return {}


def _save_db(db: dict) -> None:
    FACE_DB.write_text(json.dumps(db, indent=2))


def _cosine(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_verify(image_b64: str) -> dict:
    import base64
    engine = _get_engine()
    if not engine:
        return {"verified": False, "name": None, "score": None,
                "reason": "models_not_found"}

    try:
        img = base64.b64decode(image_b64)
    except Exception:
        return {"verified": False, "name": None, "score": None, "reason": "bad_image"}

    emb = engine.embedding(img)
    if emb is None:
        return {"verified": False, "name": None, "score": None, "reason": "no_face"}

    db = _load_db()
    if not db:
        return {"verified": False, "name": None, "score": None, "reason": "no_identity"}

    name = db.get("name", "utilizador")
    ref = db.get("embedding")
    if not ref:
        return {"verified": False, "name": None, "score": None, "reason": "no_identity"}

    score = _cosine(emb, ref)
    if score >= MATCH_THRESHOLD:
        return {"verified": True, "name": name, "score": round(score, 3)}
    return {"verified": False, "name": None, "score": round(score, 3),
            "reason": "below_threshold"}


def cmd_enroll(name: str, images_b64: list[str]) -> dict:
    import base64
    engine = _get_engine()
    if not engine:
        return {"enrolled": False, "name": name, "samples": 0}

    embeddings = []
    for b64 in images_b64:
        try:
            img = base64.b64decode(b64)
        except Exception:
            continue
        emb = engine.embedding(img)
        if emb is not None:
            embeddings.append(emb)

    if len(embeddings) < ENROLL_MIN_SAMPLES:
        return {"enrolled": False, "name": name, "samples": len(embeddings),
                "reason": f"need at least {ENROLL_MIN_SAMPLES} clear face frames"}

    # Average the embeddings and re-normalise
    n = len(embeddings)
    dim = len(embeddings[0])
    avg = [sum(e[i] for e in embeddings) / n for i in range(dim)]
    norm = math.sqrt(sum(x * x for x in avg)) or 1.0
    avg = [x / norm for x in avg]

    _save_db({"name": name, "embedding": avg, "samples": n})
    return {"enrolled": True, "name": name, "samples": n}


def cmd_forget() -> dict:
    if FACE_DB.exists():
        FACE_DB.unlink()
        return {"forgotten": True}
    return {"forgotten": False}


def cmd_status() -> dict:
    models_ok = DETECTOR_FILE.exists() and RECOGNIZER_FILE.exists()
    db = _load_db()
    return {
        "enrolled": bool(db.get("embedding")),
        "name": db.get("name"),
        "models_ok": models_ok,
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "--download":
        _download_models()
        return

    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except Exception as exc:
        print(json.dumps({"error": f"invalid JSON: {exc}"}), flush=True)
        return

    cmd = payload.get("cmd", "verify")
    try:
        if cmd == "verify":
            result = cmd_verify(payload.get("image", ""))
        elif cmd == "enroll":
            result = cmd_enroll(payload.get("name", ""), payload.get("images", []))
        elif cmd == "forget":
            result = cmd_forget()
        elif cmd == "status":
            result = cmd_status()
        else:
            result = {"error": f"unknown command: {cmd}"}
    except Exception as exc:
        result = {"error": str(exc)}

    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
