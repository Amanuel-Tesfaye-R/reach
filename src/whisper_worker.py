import sys
import os
import json

os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"

try:
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    model_size = sys.argv[1] if len(sys.argv) > 1 else "base"
    try:
        from faster_whisper import WhisperModel
        model = WhisperModel(model_size, device="cpu", compute_type="int8")
        emit({"ready": True, "model": model_size})
    except Exception as e:
        emit({"ready": False, "error": str(e)})
        sys.exit(1)

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            if req.get("cmd") == "quit":
                break
            audio_path = req.get("path", "")
            if not audio_path or not os.path.exists(audio_path):
                emit({"ok": False, "error": f"Audio file not found: {audio_path}"})
                continue

            segments, info = model.transcribe(audio_path, beam_size=5)
            text = " ".join([seg.text for seg in segments]).strip()
            emit({"ok": True, "text": text, "language": getattr(info, "language", "unknown")})
        except Exception as e:
            emit({"ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
