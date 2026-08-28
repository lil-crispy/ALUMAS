import json
import sys
import urllib.error
import urllib.request


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: fetch_evolution_contacts_test.py <api_key> [offset] [page]", file=sys.stderr)
        return 2

    api_key = sys.argv[1]
    offset = int(sys.argv[2]) if len(sys.argv) > 2 else 20
    page = int(sys.argv[3]) if len(sys.argv) > 3 else 1

    payload = {
        "offset": offset,
        "page": page,
    }

    request = urllib.request.Request(
        "http://127.0.0.1:8081/chat/findContacts/alumas",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "apikey": api_key,
            "Content-Type": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            print(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        print(body, file=sys.stderr)
        raise

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
