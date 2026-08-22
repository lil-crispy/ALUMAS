#!/usr/bin/env python3
import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo


DAY_NAMES = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]


def week_bucket(day_of_month: int) -> int:
    if 1 <= day_of_month <= 8:
        return 1
    if 9 <= day_of_month <= 16:
        return 2
    if 17 <= day_of_month <= 24:
        return 3
    return 4


def load_contacts(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def normalize_day(value: str) -> str:
    lowered = value.strip().lower()
    aliases = {
        "miercoles": "miércoles",
        "sabado": "sábado",
    }
    return aliases.get(lowered, lowered)


def build_campaign(data: dict, timezone_name: str, forced_day: str | None = None) -> dict:
    now = datetime.now(ZoneInfo(timezone_name))
    today = DAY_NAMES[now.weekday()]
    selected_day = normalize_day(forced_day) if forced_day else today

    mensajes_por_dia = data.get("mensajes_por_dia", {})
    promociones_por_semana = data.get("promociones_por_semana", {})
    selected_week = week_bucket(now.day)
    promotion = promociones_por_semana.get(str(selected_week), "") or promociones_por_semana.get(selected_week, "")
    contacts = mensajes_por_dia.get(selected_day, [])

    return {
        "timezone": timezone_name,
        "generated_at": now.isoformat(),
        "system_day": today,
        "selected_day": selected_day,
        "day_matches_system": selected_day == today,
        "selected_week_bucket": selected_week,
        "promotion": promotion,
        "contact_count": len(contacts),
        "contacts": [
            {
                "phone": item[0],
                "message": item[1],
            }
            for item in contacts
            if isinstance(item, list) and len(item) >= 2
        ],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Resuelve la campaña diaria de WhatsApp de ALUMAS para n8n."
    )
    parser.add_argument("--contacts-path", required=True, help="Ruta absoluta a contactos.json")
    parser.add_argument(
        "--timezone",
        default="America/Bogota",
        help="Zona horaria IANA para resolver el día activo",
    )
    parser.add_argument(
        "--force-day",
        default="",
        help="Sobrescribe el día calculado. Solo para validaciones controladas.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="No intenta enviar. Solo devuelve el plan de campaña.",
    )
    parser.add_argument(
        "--output-path",
        default="",
        help="Opcional. Guarda el resultado JSON en disco además de imprimirlo.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    contacts_path = Path(args.contacts_path).expanduser().resolve()
    if not contacts_path.exists():
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": f"No existe el archivo de contactos: {contacts_path}",
                },
                ensure_ascii=False,
            )
        )
        return 1

    try:
        data = load_contacts(contacts_path)
        campaign = build_campaign(
            data=data,
            timezone_name=args.timezone,
            forced_day=args.force_day or None,
        )
    except Exception as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": str(exc),
                },
                ensure_ascii=False,
            )
        )
        return 1

    payload = {
        "ok": True,
        "mode": "dry-run" if args.dry_run else "plan-only",
        "transport_ready": False,
        "transport_message": (
            "La capa de envio Linux aun no esta implementada. "
            "Este script resuelve el dia correcto, la promocion vigente y el lote del dia."
        ),
        **campaign,
    }

    rendered = json.dumps(payload, ensure_ascii=False, indent=2)
    if args.output_path:
        output_path = Path(args.output_path).expanduser().resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(rendered + "\n", encoding="utf-8")

    print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
