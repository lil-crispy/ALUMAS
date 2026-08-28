import json
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 4:
        print("Usage: build_status_batch_from_contacts.py <contacts_json> <start> <count>", file=sys.stderr)
        return 2

    path = Path(sys.argv[1])
    start = int(sys.argv[2])
    count = int(sys.argv[3])

    data = json.loads(path.read_text())
    items = data if isinstance(data, list) else data.get("data") or data.get("contacts") or []
    jids = [
        item.get("remoteJid")
        for item in items
        if isinstance(item, dict) and isinstance(item.get("remoteJid"), str) and item["remoteJid"].endswith("@s.whatsapp.net")
    ]

    batch = jids[start : start + count]
    print(",".join(batch))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
