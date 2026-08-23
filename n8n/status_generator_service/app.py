from __future__ import annotations

from collections import defaultdict
import datetime as dt
import json
import os
import sys
import uuid
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from urllib.parse import quote
from zoneinfo import ZoneInfo

from flask import Flask, jsonify, request, send_from_directory
import mysql.connector
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


REPO_ROOT = Path(os.environ.get("ALUMAS_REPO_ROOT", "/workspace/alumas")).resolve()
RUNTIME_ROOT = Path(os.environ.get("STATUS_RUNTIME_DIR", "/data/alumas_runtime/statuses")).resolve()
PUBLIC_BASE_URL = os.environ.get("STATUS_GENERATOR_PUBLIC_BASE_URL", "http://status_generator:8000/generated").rstrip("/")
DEFAULT_COUNT = int(os.environ.get("STATUS_GENERATOR_DEFAULT_COUNT", "15"))
DEFAULT_ORDER = os.environ.get("STATUS_GENERATOR_DEFAULT_ORDER", "aleatorio")
DEFAULT_IMAGE_FOLDER = os.environ.get("PRODUCT_IMAGES_FOLDER", "").strip()
DEFAULT_IMAGE_URL = os.environ.get("PRODUCT_IMAGES_URL", "").strip()
DEFAULT_LOGO_PATH = os.environ.get("STATUS_GENERATOR_LOGO_PATH", str(REPO_ROOT / "img" / "LOGO3.png")).strip()
DEFAULT_RETENTION_DAYS = int(os.environ.get("STATUS_RETENTION_DAYS", "5"))
BOGOTA_TZ = ZoneInfo("America/Bogota")
REPORT_POINTS = ("ferreteria", "bodega")
POINT_LABELS = {
    "ferreteria": "Ferreteria",
    "bodega": "Bodega",
}
PAYMENT_TOTAL_KEYS = ("efectivo", "qr", "tarjeta")
MONEY_QUANT = Decimal("0.01")

if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import generar_estados_v3 as generator  # noqa: E402


app = Flask(__name__)


def _safe_within(base: Path, target: Path) -> Path:
    resolved = target.resolve()
    if base.resolve() not in resolved.parents and resolved != base.resolve():
        raise ValueError("Ruta fuera del directorio permitido.")
    return resolved


def _cleanup_old_runs(base_dir: Path, retention_days: int) -> None:
    if retention_days <= 0 or not base_dir.exists():
        return
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=retention_days)
    for child in base_dir.iterdir():
        try:
            modified = dt.datetime.fromtimestamp(child.stat().st_mtime, tz=dt.timezone.utc)
            if modified < cutoff:
                if child.is_dir():
                    for nested in sorted(child.rglob("*"), reverse=True):
                        if nested.is_file():
                            nested.unlink(missing_ok=True)
                        elif nested.is_dir():
                            nested.rmdir()
                    child.rmdir()
                elif child.is_file():
                    child.unlink(missing_ok=True)
        except Exception:
            continue


def _resolve_output_dir(output_subdir: str | None) -> Path:
    now = dt.datetime.now()
    folder = now.strftime("%Y%m%d")
    run_id = output_subdir or f"{now.strftime('%H%M%S')}_{uuid.uuid4().hex[:8]}"
    output_dir = RUNTIME_ROOT / folder / run_id
    output_dir.mkdir(parents=True, exist_ok=True)
    return output_dir


def _public_url_for(relative_path: Path) -> str:
    return f"{PUBLIC_BASE_URL}/{quote(relative_path.as_posix(), safe='/')}"


def _to_decimal(value: object) -> Decimal:
    if isinstance(value, Decimal):
        return value
    if value is None or value == "":
        return Decimal("0")
    return Decimal(str(value))


def _money(value: object) -> Decimal:
    return _to_decimal(value).quantize(MONEY_QUANT, rounding=ROUND_HALF_UP)


def _format_currency(value: object) -> str:
    return f"${float(_money(value)):,.2f}"


def _format_currency_compact(value: object) -> str:
    return f"${float(_money(value)):,.0f}"


def _normalize_payment_method(value: object) -> str | None:
    normalized = str(value or "").strip().upper()
    if normalized in {"EFECTIVO", "CASH", "10"}:
        return "efectivo"
    if normalized in {"QR", "42"}:
        return "qr"
    if normalized in {"TARJETA", "CARD", "48"}:
        return "tarjeta"
    return None


def _format_electronic_status(factura_electronica: object, electronic_status: object) -> str:
    if not bool(factura_electronica):
        return "NO APLICA"
    normalized = str(electronic_status or "").strip().lower()
    if normalized == "validated":
        return "VALIDADA"
    if normalized == "pending":
        return "PENDIENTE"
    return normalized.upper() if normalized else "SIN ESTADO"


def _document_type(row: dict) -> str:
    return "FACTURA ELECTRONICA" if bool(row.get("factura_electronica")) else "REMISION"


def _build_report_message(total_general: Decimal) -> str:
    return (
        "Adjunto reporte de ventas de HOY por punto de venta:\n"
        "- Ferreteria\n"
        "- Bodega\n"
        f"total vendido : {_format_currency(total_general)}"
    )


def _get_db_connection():
    cfg = generator._db_config()
    return mysql.connector.connect(
        host=cfg["host"],
        port=int(cfg["port"]),
        user=cfg["user"],
        password=cfg["password"],
        database=cfg["database"],
        use_pure=True,
        connection_timeout=15,
        charset="utf8mb4",
    )


def _query_sales_rows(report_date: dt.date, point_sale: str) -> list[dict]:
    start_dt = dt.datetime.combine(report_date, dt.time.min)
    end_dt = dt.datetime.combine(report_date, dt.time.max.replace(microsecond=0))
    query = """
        SELECT
            v.id_consecutivo,
            v.fecha,
            v.total,
            UPPER(TRIM(COALESCE(v.tipo_pago, ''))) AS tipo_pago,
            UPPER(TRIM(COALESCE(v.forma_pago, ''))) AS forma_pago,
            LOWER(TRIM(COALESCE(v.punto_venta, 'ferreteria'))) AS punto_venta,
            COALESCE(c.nombre, 'Cliente General') AS cliente_nombre,
            COALESCE(u.nombre, CONCAT('Usuario ', v.usuario_id)) AS vendedor_nombre,
            COALESCE(v.factura_electronica, 0) AS factura_electronica,
            COALESCE(v.electronic_status, '') AS electronic_status,
            COALESCE(v.factus_number, '') AS factus_number,
            COALESCE(ab.total_abonos, 0) AS total_abonos
        FROM ventas v
        LEFT JOIN clientes c
            ON c.id_cliente = v.cliente_id
        LEFT JOIN usuarios u
            ON u.id_usuario = v.usuario_id
        LEFT JOIN (
            SELECT id_consecutivo, SUM(monto_abono) AS total_abonos
            FROM cartera
            GROUP BY id_consecutivo
        ) ab
            ON ab.id_consecutivo = v.id_consecutivo
        WHERE v.fecha >= %s
          AND v.fecha <= %s
          AND LOWER(TRIM(COALESCE(v.punto_venta, 'ferreteria'))) = %s
          AND (
              UPPER(TRIM(COALESCE(v.tipo_pago, ''))) = 'CONTADO'
              OR (
                  UPPER(TRIM(COALESCE(v.tipo_pago, ''))) = 'CREDITO'
                  AND COALESCE(ab.total_abonos, 0) >= COALESCE(v.total, 0)
              )
          )
        ORDER BY v.id_consecutivo DESC
    """
    conn = _get_db_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute(
            query,
            (
                start_dt.strftime("%Y-%m-%d %H:%M:%S"),
                end_dt.strftime("%Y-%m-%d %H:%M:%S"),
                point_sale,
            ),
        )
        return cursor.fetchall()
    finally:
        cursor.close()
        conn.close()


def _query_abono_breakdown(sale_ids: list[int]) -> dict[int, dict[str, Decimal]]:
    if not sale_ids:
        return {}
    placeholders = ", ".join(["%s"] * len(sale_ids))
    query = f"""
        SELECT
            id_consecutivo,
            UPPER(TRIM(COALESCE(metodo_pago, ''))) AS metodo_pago,
            SUM(monto_abono) AS total_abonos
        FROM cartera
        WHERE id_consecutivo IN ({placeholders})
        GROUP BY id_consecutivo, UPPER(TRIM(COALESCE(metodo_pago, '')))
    """
    breakdown: dict[int, dict[str, Decimal]] = defaultdict(dict)
    conn = _get_db_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute(query, tuple(sale_ids))
        for row in cursor.fetchall():
            sale_id = int(row["id_consecutivo"])
            method_key = _normalize_payment_method(row.get("metodo_pago"))
            if not method_key:
                continue
            breakdown[sale_id][method_key] = _money(row.get("total_abonos"))
    finally:
        cursor.close()
        conn.close()
    return dict(breakdown)


def _query_payment_details_breakdown(sale_ids: list[int]) -> dict[int, dict[str, Decimal]]:
    if not sale_ids:
        return {}
    placeholders = ", ".join(["%s"] * len(sale_ids))
    query = f"""
        SELECT
            venta_id,
            UPPER(TRIM(COALESCE(payment_method_code, ''))) AS payment_method_code,
            SUM(amount) AS total_amount
        FROM ventas_payment_details
        WHERE venta_id IN ({placeholders})
        GROUP BY venta_id, UPPER(TRIM(COALESCE(payment_method_code, '')))
    """
    breakdown: dict[int, dict[str, Decimal]] = defaultdict(dict)
    conn = _get_db_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute(query, tuple(sale_ids))
        for row in cursor.fetchall():
            sale_id = int(row["venta_id"])
            method_key = _normalize_payment_method(row.get("payment_method_code"))
            if not method_key:
                continue
            breakdown[sale_id][method_key] = _money(row.get("total_amount"))
    finally:
        cursor.close()
        conn.close()
    return dict(breakdown)


def _build_payment_totals(records: list[dict]) -> dict[str, Decimal]:
    totals = {key: Decimal("0") for key in PAYMENT_TOTAL_KEYS}
    for record in records:
        total_sale = _money(record.get("total"))
        tipo_pago = str(record.get("tipo_pago") or "").upper()
        payment_details_breakdown = record.get("payment_details_breakdown") or {}
        if payment_details_breakdown:
            recognized_total = sum((_money(amount) for amount in payment_details_breakdown.values()), Decimal("0"))
            if recognized_total > 0:
                factor = min(Decimal("1"), total_sale / recognized_total) if total_sale > 0 else Decimal("1")
                for method, amount in payment_details_breakdown.items():
                    if method in totals:
                        totals[method] += _money(amount) * factor
                continue
        if tipo_pago == "CREDITO":
            breakdown = record.get("abono_breakdown") or {}
            recognized_total = sum((_money(amount) for amount in breakdown.values()), Decimal("0"))
            if recognized_total > 0:
                factor = min(Decimal("1"), total_sale / recognized_total)
                for method, amount in breakdown.items():
                    if method in totals:
                        totals[method] += _money(amount) * factor
                continue
        payment_key = _normalize_payment_method(record.get("forma_pago"))
        if payment_key in totals:
            totals[payment_key] += total_sale
    return {key: _money(value) for key, value in totals.items()}


def _create_pdf_report(file_path: Path, filtered_data: list[dict], generated_at: dt.datetime, point_sale: str) -> dict[str, Decimal | int]:
    doc = SimpleDocTemplate(str(file_path), pagesize=A4)
    story = []
    styles = getSampleStyleSheet()

    title_style = ParagraphStyle(
        "CustomTitle",
        parent=styles["Heading1"],
        fontSize=18,
        spaceAfter=30,
        alignment=1,
    )

    story.append(Paragraph("REPORTE DE VENTAS", title_style))
    story.append(Paragraph(f"Generado el: {generated_at.strftime('%d/%m/%Y %H:%M')}", styles["Normal"]))
    story.append(Paragraph(f"Punto de venta: {POINT_LABELS.get(point_sale, point_sale.title())}", styles["Normal"]))
    story.append(Spacer(1, 20))

    total_ventas = sum((_money(record.get("total")) for record in filtered_data), Decimal("0"))
    num_facturas = len(filtered_data)
    promedio = (total_ventas / num_facturas) if num_facturas > 0 else Decimal("0")
    payment_totals = _build_payment_totals(filtered_data)

    resumen_data = [
        ["Metrica", "Valor"],
        ["Total de Ventas", _format_currency(total_ventas)],
        ["Numero de Facturas", str(num_facturas)],
        ["Promedio por Venta", _format_currency(promedio)],
        ["Total Ventas en Efectivo", _format_currency(payment_totals["efectivo"])],
        ["Total Ventas en QR", _format_currency(payment_totals["qr"])],
        ["Total Ventas en Tarjeta", _format_currency(payment_totals["tarjeta"])],
    ]

    resumen_table = Table(resumen_data)
    resumen_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.grey),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.whitesmoke),
                ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, 0), 14),
                ("BOTTOMPADDING", (0, 0), (-1, 0), 12),
                ("BACKGROUND", (0, 1), (-1, -1), colors.beige),
                ("GRID", (0, 0), (-1, -1), 1, colors.black),
            ]
        )
    )

    story.append(Paragraph("Resumen Ejecutivo", styles["Heading2"]))
    story.append(resumen_table)
    story.append(Spacer(1, 20))
    story.append(Paragraph("Detalle de Ventas", styles["Heading2"]))

    table_data = [[
        "Documento",
        "Interno",
        "Tipo Doc.",
        "Fecha",
        "Cliente",
        "Vendedor",
        "Estado FE",
        "Total",
    ]]

    for record in filtered_data[:50]:
        fecha = record.get("fecha")
        fecha_str = fecha.strftime("%d/%m/%Y") if hasattr(fecha, "strftime") else str(fecha or "")
        table_data.append(
            [
                str(record.get("numero_visible") or record.get("id_consecutivo") or ""),
                str(record.get("id_consecutivo") or ""),
                str(record.get("tipo_documento") or "")[:16],
                fecha_str,
                str(record.get("cliente_nombre") or "")[:20],
                str(record.get("vendedor_nombre") or "")[:20],
                str(record.get("estado_electronico_label") or "")[:12],
                _format_currency_compact(record.get("total")),
            ]
        )

    data_table = Table(
        table_data,
        colWidths=[55, 45, 60, 55, 95, 90, 60, 65],
        repeatRows=1,
    )
    data_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.grey),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.whitesmoke),
                ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, 0), 10),
                ("BOTTOMPADDING", (0, 0), (-1, 0), 12),
                ("BACKGROUND", (0, 1), (-1, -1), colors.beige),
                ("GRID", (0, 0), (-1, -1), 1, colors.black),
                ("FONTSIZE", (0, 1), (-1, -1), 8),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ]
        )
    )

    story.append(data_table)

    if not filtered_data:
        story.append(Spacer(1, 10))
        story.append(Paragraph("Sin ventas registradas para este punto de venta en HOY.", styles["Normal"]))
    elif len(filtered_data) > 50:
        story.append(Spacer(1, 10))
        story.append(
            Paragraph(
                f"Nota: Se muestran los primeros 50 registros de {len(filtered_data)} totales.",
                styles["Normal"],
            )
        )

    doc.build(story)
    return {
        "total_ventas": _money(total_ventas),
        "num_facturas": num_facturas,
        "promedio": _money(promedio),
        "total_efectivo": payment_totals["efectivo"],
        "total_qr": payment_totals["qr"],
        "total_tarjeta": payment_totals["tarjeta"],
    }


def _build_sales_report_for_point(report_date: dt.date, point_sale: str, output_dir: Path, generated_at: dt.datetime) -> dict:
    rows = _query_sales_rows(report_date, point_sale)
    sale_ids = [int(row["id_consecutivo"]) for row in rows]
    abono_breakdown = _query_abono_breakdown(sale_ids)
    payment_details_breakdown = _query_payment_details_breakdown(sale_ids)
    records = []

    for row in rows:
        sale_id = int(row["id_consecutivo"])
        records.append(
            {
                **row,
                "numero_visible": row.get("factus_number") or row.get("id_consecutivo"),
                "tipo_documento": _document_type(row),
                "estado_electronico_label": _format_electronic_status(
                    row.get("factura_electronica"),
                    row.get("electronic_status"),
                ),
                "abono_breakdown": abono_breakdown.get(sale_id, {}),
                "payment_details_breakdown": payment_details_breakdown.get(sale_id, {}),
                "total": _money(row.get("total")),
                "total_abonos": _money(row.get("total_abonos")),
            }
        )

    filename = f"reporte_ventas_{point_sale}_{report_date.strftime('%Y%m%d')}.pdf"
    pdf_path = output_dir / filename
    summary = _create_pdf_report(pdf_path, records, generated_at, point_sale)
    relative_path = pdf_path.resolve().relative_to(RUNTIME_ROOT)
    return {
        "point_sale": point_sale,
        "label": POINT_LABELS.get(point_sale, point_sale.title()),
        "date": report_date.isoformat(),
        "file_name": filename,
        "file_path": str(pdf_path),
        "relative_path": relative_path.as_posix(),
        "public_url": _public_url_for(relative_path),
        "records_total": len(records),
        "summary": {
            "total_ventas": float(summary["total_ventas"]),
            "num_facturas": summary["num_facturas"],
            "promedio": float(summary["promedio"]),
            "total_efectivo": float(summary["total_efectivo"]),
            "total_qr": float(summary["total_qr"]),
            "total_tarjeta": float(summary["total_tarjeta"]),
        },
    }


@app.get("/health")
def health():
    logo_exists = Path(DEFAULT_LOGO_PATH).is_file()
    return jsonify(
        {
            "status": "ok",
            "repo_root": str(REPO_ROOT),
            "runtime_root": str(RUNTIME_ROOT),
            "default_count": DEFAULT_COUNT,
            "default_order": DEFAULT_ORDER,
            "default_image_url": DEFAULT_IMAGE_URL or generator._product_images_default_url(),
            "default_image_folder": DEFAULT_IMAGE_FOLDER or generator._product_images_default_folder(),
            "logo_exists": logo_exists,
            "logo_path": DEFAULT_LOGO_PATH,
        }
    )


@app.post("/generate")
def generate():
    payload = request.get_json(silent=True) or {}
    count = int(payload.get("count") or DEFAULT_COUNT)
    order = str(payload.get("order") or DEFAULT_ORDER).strip()
    image_url = str(payload.get("image_url") or DEFAULT_IMAGE_URL or generator._product_images_default_url()).strip()
    image_folder = str(payload.get("image_folder") or DEFAULT_IMAGE_FOLDER or generator._product_images_default_folder()).strip()
    logo_path = str(payload.get("logo_path") or DEFAULT_LOGO_PATH).strip()
    promos = payload.get("promos")
    retention_days = int(payload.get("retention_days") or DEFAULT_RETENTION_DAYS)

    if count <= 0:
        return jsonify({"status": "error", "message": "count debe ser mayor que cero"}), 400

    _cleanup_old_runs(RUNTIME_ROOT, retention_days)
    output_dir = _resolve_output_dir(payload.get("output_subdir"))

    try:
        result = generator.generar_estados_lote(
            cantidad=count,
            orden=order,
            salida_dir=str(output_dir),
            url_imagenes=image_url,
            logo_path=logo_path if Path(logo_path).is_file() else None,
            carpeta_imagenes=image_folder,
            promos=promos,
        )
    except Exception as exc:
        return jsonify({"status": "error", "message": str(exc)}), 500

    enriched_files = []
    for item in result["generated_files"]:
        relative_path = Path(item["file_path"]).resolve().relative_to(RUNTIME_ROOT)
        enriched_files.append(
            {
                **item,
                "relative_path": relative_path.as_posix(),
                "public_url": _public_url_for(relative_path),
            }
        )

    metadata = {
        "status": "ok",
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "count": result["count"],
        "order": result["order"],
        "output_dir": str(output_dir),
        "image_url": image_url,
        "image_folder": image_folder,
        "logo_path": logo_path if Path(logo_path).is_file() else None,
        "generated_files": enriched_files,
    }
    (output_dir / "metadata.json").write_text(json.dumps(metadata, indent=2, ensure_ascii=False), encoding="utf-8")
    (RUNTIME_ROOT / "latest.json").write_text(json.dumps(metadata, indent=2, ensure_ascii=False), encoding="utf-8")
    return jsonify(metadata)


@app.post("/generate-sales-reports")
def generate_sales_reports():
    payload = request.get_json(silent=True) or {}
    date_value = str(payload.get("date") or "").strip()
    retention_days = int(payload.get("retention_days") or DEFAULT_RETENTION_DAYS)
    requested_points = payload.get("points")
    if isinstance(requested_points, list) and requested_points:
        points = [str(point or "").strip().lower() for point in requested_points if str(point or "").strip()]
    else:
        points = list(REPORT_POINTS)
    points = [point for point in points if point in REPORT_POINTS]
    if not points:
        return jsonify({"status": "error", "message": "Debe especificar al menos un punto de venta valido."}), 400

    try:
        report_date = dt.datetime.strptime(date_value, "%Y-%m-%d").date() if date_value else dt.datetime.now(BOGOTA_TZ).date()
    except ValueError:
        return jsonify({"status": "error", "message": "La fecha debe estar en formato YYYY-MM-DD."}), 400

    _cleanup_old_runs(RUNTIME_ROOT, retention_days)
    output_dir = _resolve_output_dir(payload.get("output_subdir") or f"sales_reports_{report_date.strftime('%Y%m%d')}")
    generated_at = dt.datetime.now(BOGOTA_TZ)

    try:
        report_files = [_build_sales_report_for_point(report_date, point_sale, output_dir, generated_at) for point_sale in points]
    except Exception as exc:
        return jsonify({"status": "error", "message": str(exc)}), 500

    total_general = sum((Decimal(str(report["summary"]["total_ventas"])) for report in report_files), Decimal("0"))
    metadata = {
        "status": "ok",
        "generated_at": generated_at.isoformat(),
        "report_date": report_date.isoformat(),
        "reports": report_files,
        "total_general": float(_money(total_general)),
        "message_text": _build_report_message(_money(total_general)),
        "recipients": ["3232818874", "3028379185", "3015827791"],
    }
    (output_dir / "metadata.json").write_text(json.dumps(metadata, indent=2, ensure_ascii=False), encoding="utf-8")
    (RUNTIME_ROOT / "latest_sales_reports.json").write_text(json.dumps(metadata, indent=2, ensure_ascii=False), encoding="utf-8")
    return jsonify(metadata)


@app.get("/generated/<path:relative_path>")
def generated_file(relative_path: str):
    target = _safe_within(RUNTIME_ROOT, RUNTIME_ROOT / relative_path)
    return send_from_directory(target.parent, target.name)


if __name__ == "__main__":
    RUNTIME_ROOT.mkdir(parents=True, exist_ok=True)
    app.run(host="0.0.0.0", port=8000)
