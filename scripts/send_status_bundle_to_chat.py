import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


def normalize_number(raw_number: str) -> str:
    digits = "".join(ch for ch in str(raw_number) if ch.isdigit())
    if len(digits) == 10 and digits.startswith("3"):
        digits = f"57{digits}"
    return digits


def send_image(api_key: str, number: str, media_url: str, caption: str) -> None:
    payload = {
        "number": number,
        "mediatype": "image",
        "media": media_url,
        "caption": caption,
        "fileName": media_url.rstrip("/").split("/")[-1] or "status.jpg",
    }
    request = urllib.request.Request(
        "http://127.0.0.1:8081/message/sendMedia/alumas",
        data=json.dumps(payload).encode("utf-8"),
        headers={"apikey": api_key, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=600) as response:
        response.read()


def main() -> int:
    if len(sys.argv) < 4:
        print("Usage: send_status_bundle_to_chat.py <api_key> <number> <bundle_metadata_path>", file=sys.stderr)
        return 2

    api_key = sys.argv[1]
    number = normalize_number(sys.argv[2])
    metadata_path = Path(sys.argv[3])
    data = json.loads(metadata_path.read_text(encoding="utf-8"))
    generated_files = data.get("generated_files") or []
    if not generated_files:
        raise SystemExit("No generated_files found in metadata")

    for index, item in enumerate(generated_files, start=1):
        media_url = str(item.get("public_url") or item.get("internal_url") or "").strip()
        if not media_url:
            raise SystemExit(f"Missing URL for item {index}")
        caption = ""
        try:
            send_image(api_key, number, media_url, caption)
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise SystemExit(f"HTTP {exc.code} sending item {index}: {body}") from exc
        time.sleep(2)

    print(json.dumps({
        "sent_count": len(generated_files),
        "number": number,
        "metadata_path": str(metadata_path),
    }, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
