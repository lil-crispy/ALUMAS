from __future__ import annotations

import datetime as dt
import json
import os
import sys
import uuid
from pathlib import Path
from urllib.parse import quote

from flask import Flask, jsonify, request, send_from_directory


REPO_ROOT = Path(os.environ.get("ALUMAS_REPO_ROOT", "/workspace/alumas")).resolve()
RUNTIME_ROOT = Path(os.environ.get("STATUS_RUNTIME_DIR", "/data/alumas_runtime/statuses")).resolve()
PUBLIC_BASE_URL = os.environ.get("STATUS_GENERATOR_PUBLIC_BASE_URL", "http://status_generator:8000/generated").rstrip("/")
DEFAULT_COUNT = int(os.environ.get("STATUS_GENERATOR_DEFAULT_COUNT", "15"))
DEFAULT_ORDER = os.environ.get("STATUS_GENERATOR_DEFAULT_ORDER", "aleatorio")
DEFAULT_IMAGE_FOLDER = os.environ.get("PRODUCT_IMAGES_FOLDER", "").strip()
DEFAULT_IMAGE_URL = os.environ.get("PRODUCT_IMAGES_URL", "").strip()
DEFAULT_LOGO_PATH = os.environ.get("STATUS_GENERATOR_LOGO_PATH", str(REPO_ROOT / "img" / "LOGO3.png")).strip()
DEFAULT_RETENTION_DAYS = int(os.environ.get("STATUS_RETENTION_DAYS", "5"))

if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import generar_estados_v3 as generator  # noqa: E402


app = Flask(__name__)


def _safe_within(base: Path, target: Path) -> Path:
    resolved = target.resolve()
    if base.resolve() not in resolved.parents and resolved != base.resolve():
        raise ValueError("Ruta fuera del directorio permitido.")
    return resolved


def _cleanup_old_runs(base_dir: Path, retention_days: int) -> None:
    if retention_days <= 0 or not base_dir.exists():
        return
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=retention_days)
    for child in base_dir.iterdir():
        try:
            modified = dt.datetime.fromtimestamp(child.stat().st_mtime, tz=dt.timezone.utc)
            if modified < cutoff:
                if child.is_dir():
                    for nested in sorted(child.rglob("*"), reverse=True):
                        if nested.is_file():
                            nested.unlink(missing_ok=True)
                        elif nested.is_dir():
                            nested.rmdir()
                    child.rmdir()
                elif child.is_file():
                    child.unlink(missing_ok=True)
        except Exception:
            continue


def _resolve_output_dir(output_subdir: str | None) -> Path:
    now = dt.datetime.now()
    folder = now.strftime("%Y%m%d")
    run_id = output_subdir or f"{now.strftime('%H%M%S')}_{uuid.uuid4().hex[:8]}"
    output_dir = RUNTIME_ROOT / folder / run_id
    output_dir.mkdir(parents=True, exist_ok=True)
    return output_dir


def _public_url_for(relative_path: Path) -> str:
    return f"{PUBLIC_BASE_URL}/{quote(relative_path.as_posix(), safe='/')}"


@app.get("/health")
def health():
    logo_exists = Path(DEFAULT_LOGO_PATH).is_file()
    return jsonify(
        {
            "status": "ok",
            "repo_root": str(REPO_ROOT),
            "runtime_root": str(RUNTIME_ROOT),
            "default_count": DEFAULT_COUNT,
            "default_order": DEFAULT_ORDER,
            "default_image_url": DEFAULT_IMAGE_URL or generator._product_images_default_url(),
            "default_image_folder": DEFAULT_IMAGE_FOLDER or generator._product_images_default_folder(),
            "logo_exists": logo_exists,
            "logo_path": DEFAULT_LOGO_PATH,
        }
    )


@app.post("/generate")
def generate():
    payload = request.get_json(silent=True) or {}
    count = int(payload.get("count") or DEFAULT_COUNT)
    order = str(payload.get("order") or DEFAULT_ORDER).strip()
    image_url = str(payload.get("image_url") or DEFAULT_IMAGE_URL or generator._product_images_default_url()).strip()
    image_folder = str(payload.get("image_folder") or DEFAULT_IMAGE_FOLDER or generator._product_images_default_folder()).strip()
    logo_path = str(payload.get("logo_path") or DEFAULT_LOGO_PATH).strip()
    promos = payload.get("promos")
    retention_days = int(payload.get("retention_days") or DEFAULT_RETENTION_DAYS)

    if count <= 0:
        return jsonify({"status": "error", "message": "count debe ser mayor que cero"}), 400

    _cleanup_old_runs(RUNTIME_ROOT, retention_days)
    output_dir = _resolve_output_dir(payload.get("output_subdir"))

    try:
        result = generator.generar_estados_lote(
            cantidad=count,
            orden=order,
            salida_dir=str(output_dir),
            url_imagenes=image_url,
            logo_path=logo_path if Path(logo_path).is_file() else None,
            carpeta_imagenes=image_folder,
            promos=promos,
        )
    except Exception as exc:
        return jsonify({"status": "error", "message": str(exc)}), 500

    enriched_files = []
    for item in result["generated_files"]:
        relative_path = Path(item["file_path"]).resolve().relative_to(RUNTIME_ROOT)
        enriched_files.append(
            {
                **item,
                "relative_path": relative_path.as_posix(),
                "public_url": _public_url_for(relative_path),
            }
        )

    metadata = {
        "status": "ok",
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "count": result["count"],
        "order": result["order"],
        "output_dir": str(output_dir),
        "image_url": image_url,
        "image_folder": image_folder,
        "logo_path": logo_path if Path(logo_path).is_file() else None,
        "generated_files": enriched_files,
    }
    (output_dir / "metadata.json").write_text(json.dumps(metadata, indent=2, ensure_ascii=False), encoding="utf-8")
    (RUNTIME_ROOT / "latest.json").write_text(json.dumps(metadata, indent=2, ensure_ascii=False), encoding="utf-8")
    return jsonify(metadata)


@app.get("/generated/<path:relative_path>")
def generated_file(relative_path: str):
    target = _safe_within(RUNTIME_ROOT, RUNTIME_ROOT / relative_path)
    return send_from_directory(target.parent, target.name)


if __name__ == "__main__":
    RUNTIME_ROOT.mkdir(parents=True, exist_ok=True)
    app.run(host="0.0.0.0", port=8000)
