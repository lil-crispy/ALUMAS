import json
import sys
import urllib.error
import urllib.request


def main() -> int:
    if len(sys.argv) < 4:
        print(
            "Usage: send_evolution_media_chat_test.py <api_key> <number_jid> <content_url> [caption]",
            file=sys.stderr,
        )
        return 2

    api_key = sys.argv[1]
    number_jid = sys.argv[2]
    content_url = sys.argv[3]
    caption = sys.argv[4] if len(sys.argv) > 4 else ""

    payload = {
        "number": number_jid,
        "mediatype": "image",
        "media": content_url,
        "caption": caption,
        "fileName": "chat-test.jpg",
    }

    request = urllib.request.Request(
        "http://127.0.0.1:8081/message/sendMedia/alumas",
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
