import json
import sys
import urllib.request
import urllib.error


def main() -> int:
    if len(sys.argv) < 3:
        print(
            "Usage: send_evolution_status_test.py <api_key> <content_url> [caption] [status_jid_csv]",
            file=sys.stderr,
        )
        return 2

    api_key = sys.argv[1]
    content_url = sys.argv[2]
    caption = sys.argv[3] if len(sys.argv) > 3 else ""
    status_jid_csv = sys.argv[4] if len(sys.argv) > 4 else ""
    status_jid_list = [item.strip() for item in status_jid_csv.split(",") if item.strip()]

    payload = {
        "type": "image",
        "content": content_url,
        "caption": caption,
    }
    if status_jid_list:
        payload["allContacts"] = False
        payload["statusJidList"] = status_jid_list
    else:
        payload["allContacts"] = True

    request = urllib.request.Request(
        "http://127.0.0.1:8081/message/sendStatus/alumas",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "apikey": api_key,
            "Content-Type": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=600) as response:
            print(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        print(body, file=sys.stderr)
        raise

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
