import argparse
import datetime as dt
import json
import urllib.request
import zipfile
from pathlib import Path


def _post_json(url: str, payload: dict) -> dict:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=300) as response:
        return json.loads(response.read().decode("utf-8"))


def _download_file(url: str, destination: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "ALUMAS-manual-status-bundle/1.0"})
    with urllib.request.urlopen(request, timeout=180) as response:
        destination.write_bytes(response.read())


def _zip_directory(source_dir: Path, zip_path: Path) -> None:
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for file_path in sorted(source_dir.rglob("*")):
            if file_path.is_file():
                archive.write(file_path, arcname=file_path.relative_to(source_dir))


def main() -> int:
    parser = argparse.ArgumentParser(description="Create a local manual WhatsApp status bundle.")
    parser.add_argument("--output-root", required=True, help="Directory where the bundle folder and zip will be created.")
    parser.add_argument("--generate-url", default="http://72.62.166.253:8000/generate", help="Status generator endpoint.")
    parser.add_argument("--count", type=int, default=15, help="Number of statuses to request.")
    parser.add_argument("--order", default="aleatorio", help="Product order for generation.")
    parser.add_argument("--label", default="manual", help="Suffix label for the generated folder name.")
    args = parser.parse_args()

    timestamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    output_root = Path(args.output_root).resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    bundle_dir = output_root / f"estados_{args.label}_{timestamp}"
    bundle_dir.mkdir(parents=True, exist_ok=True)

    response = _post_json(args.generate_url, {"count": args.count, "order": args.order})
    generated_files = response.get("generated_files") or []
    if not generated_files:
        raise SystemExit("No generated_files returned by status generator")

    for index, item in enumerate(generated_files, start=1):
        public_url = str(item.get("public_url") or item.get("internal_url") or "").strip()
        if not public_url:
            raise SystemExit(f"Generated item {index} does not contain a downloadable URL")
        file_name = str(item.get("delivery_file_name") or item.get("file_name") or f"status_{index:02d}.jpg").strip()
        destination = bundle_dir / file_name
        _download_file(public_url, destination)
        item["downloaded_file"] = str(destination)

    metadata_path = bundle_dir / "metadata.json"
    metadata_path.write_text(json.dumps(response, ensure_ascii=False, indent=2), encoding="utf-8")

    zip_path = output_root / f"{bundle_dir.name}.zip"
    _zip_directory(bundle_dir, zip_path)

    print(json.dumps({
        "bundle_dir": str(bundle_dir),
        "zip_path": str(zip_path),
        "count": len(generated_files),
    }, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
