import mimetypes
import os
import sys
import urllib.error
import urllib.request
import uuid


def build_multipart(fields: dict[str, str], file_field: str, file_path: str) -> tuple[bytes, str]:
    boundary = f"----TraeBoundary{uuid.uuid4().hex}"
    lines: list[bytes] = []

    for name, value in fields.items():
        lines.append(f"--{boundary}\r\n".encode("utf-8"))
        lines.append(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"))
        lines.append(f"{value}\r\n".encode("utf-8"))

    filename = os.path.basename(file_path)
    content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    with open(file_path, "rb") as handle:
        file_bytes = handle.read()

    lines.append(f"--{boundary}\r\n".encode("utf-8"))
    lines.append(
        f'Content-Disposition: form-data; name="{file_field}"; filename="{filename}"\r\n'.encode("utf-8")
    )
    lines.append(f"Content-Type: {content_type}\r\n\r\n".encode("utf-8"))
    lines.append(file_bytes)
    lines.append(b"\r\n")
    lines.append(f"--{boundary}--\r\n".encode("utf-8"))

    return b"".join(lines), boundary


def main() -> int:
    if len(sys.argv) < 3:
        print("Usage: send_evolution_status_file_test.py <api_key> <file_path> [caption]", file=sys.stderr)
        return 2

    api_key = sys.argv[1]
    file_path = sys.argv[2]
    caption = sys.argv[3] if len(sys.argv) > 3 else ""

    body, boundary = build_multipart(
        {
            "type": "image",
            "caption": caption,
            "allContacts": "true",
        },
        "file",
        file_path,
    )

    request = urllib.request.Request(
        "http://127.0.0.1:8081/message/sendStatus/alumas",
        data=body,
        headers={
            "apikey": api_key,
            "Content-Type": f"multipart/form-data; boundary={boundary}",
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
