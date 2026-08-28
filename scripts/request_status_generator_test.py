import json
import urllib.request


def main() -> int:
    payload = {
        "count": 1,
        "order": "aleatorio",
    }

    request = urllib.request.Request(
        "http://127.0.0.1:8000/generate",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )

    with urllib.request.urlopen(request, timeout=180) as response:
        body = json.loads(response.read().decode("utf-8"))

    generated_files = body.get("generated_files") or []
    if not generated_files:
        raise SystemExit("No generated_files returned by status_generator")

    first = generated_files[0]
    print(json.dumps(first, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
