import json
import subprocess
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path


def send_status(api_key: str, content_url: str, batch: list[str]) -> str:
    payload = {
        "type": "image",
        "content": content_url,
        "caption": "",
        "allContacts": False,
        "statusJidList": batch,
    }
    request = urllib.request.Request(
        "http://127.0.0.1:8081/message/sendStatus/alumas",
        data=json.dumps(payload).encode("utf-8"),
        headers={"apikey": api_key, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=600) as response:
        data = json.loads(response.read().decode("utf-8"))
    return ((data.get("key") or {}).get("id")) or ""


def recent_logs() -> str:
    result = subprocess.run(
        ["docker", "logs", "--since", "3m", "evolution_api"],
        capture_output=True,
        text=True,
        check=False,
    )
    return (result.stdout or "") + (result.stderr or "")


def evaluate_message(message_id: str, wait_seconds: int) -> str:
    deadline = time.time() + wait_seconds
    while time.time() < deadline:
        logs = recent_logs()
        if message_id in logs and '"status": 0' in logs:
            return "failed"
        if message_id in logs and 'messageStubParameters' in logs and '"400"' in logs:
            return "failed"
        if message_id in logs and "status@broadcast" in logs and "status: 1" in logs:
            # keep waiting a bit in case it later flips to 0
            time.sleep(6)
            continue
        time.sleep(6)
    return "no_failure_seen"


def main() -> int:
    if len(sys.argv) < 6:
        print(
            "Usage: scan_status_batches.py <api_key> <contacts_json> <content_url> <batch_size> <max_batches>",
            file=sys.stderr,
        )
        return 2

    api_key = sys.argv[1]
    contacts_json = Path(sys.argv[2])
    content_url = sys.argv[3]
    batch_size = int(sys.argv[4])
    max_batches = int(sys.argv[5])

    data = json.loads(contacts_json.read_text())
    items = data if isinstance(data, list) else data.get("data") or data.get("contacts") or []
    jids = [
        item.get("remoteJid")
        for item in items
        if isinstance(item, dict) and isinstance(item.get("remoteJid"), str) and item["remoteJid"].endswith("@s.whatsapp.net")
    ]

    results = []
    for batch_index in range(max_batches):
        start = batch_index * batch_size
        batch = jids[start : start + batch_size]
        if not batch:
            break
        message_id = send_status(api_key, content_url, batch)
        status = evaluate_message(message_id, wait_seconds=40)
        results.append(
            {
                "batch_index": batch_index,
                "start": start,
                "count": len(batch),
                "message_id": message_id,
                "status": status,
                "sample_first": batch[0],
                "sample_last": batch[-1],
            }
        )
        print(json.dumps(results[-1], ensure_ascii=True), flush=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
