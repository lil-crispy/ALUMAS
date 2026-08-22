import datetime
import io
import json
import logging
import os
import random
import shutil
import sys
import tempfile
import threading
import tkinter as tk
import urllib.parse
import urllib.request
import uuid
from decimal import Decimal
from pathlib import Path
from tkinter import ttk, messagebox, filedialog

try:
    from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance
except ImportError as e:
    print("ERROR: Pillow no instalado. Ejecute: pip install Pillow")
    print(e)
    sys.exit(1)

try:
    import mysql.connector
except ImportError as e:
    print("ERROR: mysql-connector-python no instalado.")
    print(e)
    sys.exit(1)


# ---------------------------------------------------------------
# Tema visual
# ---------------------------------------------------------------
COLOR_FONDO = "#12121f"
COLOR_PANEL = "#1b1b2f"
COLOR_PANEL_2 = "#252543"
COLOR_ACENTO = "#f5a623"
COLOR_AZUL = "#2a7bff"
COLOR_AZUL_CLARO = "#6aa8ff"
COLOR_TEXTO = "#e6e6ef"
COLOR_TEXTO_SUAVE = "#a0a0b8"


def aplicar_tema(root):
    style = ttk.Style(root)
    try:
        style.theme_use("clam")
    except Exception:
        pass
    style.configure(".", background=COLOR_FONDO, foreground=COLOR_TEXTO, fieldbackground="#17172a", bordercolor="#2a2a48", lightcolor="#2a2a48", darkcolor="#2a2a48")
    style.configure("TFrame", background=COLOR_FONDO)
    style.configure("TLabel", background=COLOR_FONDO, foreground=COLOR_TEXTO, font=("Segoe UI", 10))
    style.configure("TLabelFrame", background=COLOR_PANEL, foreground=COLOR_ACENTO, font=("Segoe UI", 10, "bold"))
    style.configure("TButton", background="#2e2e53", foreground=COLOR_TEXTO, borderwidth=0, focusthickness=0, padding=(14, 8), font=("Segoe UI", 10, "bold"))
    style.map("TButton", background=[("active", "#3e3e70"), ("pressed", COLOR_ACENTO)], foreground=[("pressed", "#000")])
    style.configure("Primary.TButton", background=COLOR_AZUL, foreground="#ffffff", padding=(18, 9), font=("Segoe UI", 10, "bold"))
    style.map("Primary.TButton", background=[("active", COLOR_AZUL_CLARO)])
    style.configure("Accent.TButton", background=COLOR_ACENTO, foreground="#14141f", padding=(20, 10), font=("Segoe UI", 11, "bold"))
    style.map("Accent.TButton", background=[("active", "#ffc457")])
    style.configure("TEntry", fieldbackground="#17172a", foreground=COLOR_TEXTO, insertcolor=COLOR_TEXTO, bordercolor="#2a2a48", padding=4)
    style.configure("TCombobox", fieldbackground="#17172a", foreground=COLOR_TEXTO, padding=4, arrowcolor=COLOR_ACENTO)
    style.map("TCombobox", fieldbackground=[("readonly", "#17172a")], foreground=[("readonly", COLOR_TEXTO)])
    style.configure("TNotebook", background=COLOR_FONDO, borderwidth=0)
    style.configure("TNotebook.Tab", background=COLOR_PANEL, foreground=COLOR_TEXTO_SUAVE, padding=(18, 8), font=("Segoe UI", 10, "bold"))
    style.map("TNotebook.Tab", background=[("selected", COLOR_AZUL_CLARO)], foreground=[("selected", "#0f0f1f")])
    style.configure("Vertical.TProgressbar", troughcolor=COLOR_PANEL, background=COLOR_ACENTO, bordercolor=COLOR_PANEL, lightcolor=COLOR_ACENTO, darkcolor=COLOR_ACENTO)
    style.configure("Horizontal.TProgressbar", troughcolor=COLOR_PANEL, background=COLOR_ACENTO, bordercolor=COLOR_PANEL, lightcolor=COLOR_ACENTO, darkcolor=COLOR_ACENTO)
    style.configure("Treeview", background="#17172a", fieldbackground="#17172a", foreground=COLOR_TEXTO, bordercolor="#2a2a48", rowheight=26, font=("Segoe UI", 10))
    style.configure("Treeview.Heading", background=COLOR_PANEL_2, foreground=COLOR_ACENTO, font=("Segoe UI", 10, "bold"))
    style.map("Treeview", background=[("selected", COLOR_AZUL)], foreground=[("selected", "#fff")])


# ---------------------------------------------------------------
# Utilidades de rutas, DB, descargas
# ---------------------------------------------------------------
def _base_dir():
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


BASE_DIR = _base_dir()
LOG_PATH = os.environ.get("ALUMAS_ESTADOS_LOG_PATH", os.path.join(BASE_DIR, "estados_debug.log"))
try:
    logging.basicConfig(
        filename=LOG_PATH, level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        encoding="utf-8", force=True,
    )
except OSError:
    LOG_PATH = os.path.join(tempfile.gettempdir(), "alumas_estados_debug.log")
    logging.basicConfig(
        filename=LOG_PATH, level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        encoding="utf-8", force=True,
    )


# ---------------------------------------------------------------
# Mensajes promocionales aleatorios (fijos + editables en pestaña)
# ---------------------------------------------------------------
PROMOS_DEFAULT = [
    "🔥 ¡HOY GRAN PROMO!",
    "✅ Disponible inmediato",
    "💥 ¡Oferta limitada!",
    "🛒 Pídalo HOY mismo",
    "⚡ ¡Últimas unidades!",
    "💎 Calidad ALUMAS garantizada",
    "🚚 Entrega hoy mismo",
    "✨ ¡Productos NUEVOS!",
    "🥇 El mejor precio del mercado",
    "🎯 Ahorre hoy con nosotros",
]


def _cargar_promos_guardadas_archivo():
    p = os.path.join(BASE_DIR, "promos_estados.json")
    if not os.path.isfile(p):
        return list(PROMOS_DEFAULT)
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            items = [str(item).strip() for item in data if str(item).strip()]
            if items:
                return items
    except Exception:
        pass
    return list(PROMOS_DEFAULT)


def _leer_env():
    cfg = {}
    rutas = [
        os.path.join(BASE_DIR, ".env"),
        os.path.join(Path.home(), "OneDrive", "Documentos", "GitHub", "ALUMAS", ".env"),
    ]
    for p in rutas:
        if not os.path.isfile(p):
            continue
        try:
            with open(p, "r", encoding="utf-8") as f:
                for raw in f:
                    line = raw.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    if line.startswith("export "):
                        line = line[7:]
                    k, v = line.split("=", 1)
                    cfg[k.strip()] = v.strip().strip('"').strip("'")
        except OSError:
            continue
    return cfg


def _guardar_clave_env(clave, valor):
    path = os.path.join(BASE_DIR, ".env")
    lineas = []
    encontrado = False
    if os.path.isfile(path):
        with open(path, "r", encoding="utf-8") as f:
            for raw in f:
                line = raw.rstrip("\r\n")
                if line.split("=", 1)[0].strip() == clave:
                    line = f"{clave}={valor}"
                    encontrado = True
                lineas.append(line)
    if not encontrado:
        lineas.append(f"{clave}={valor}")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lineas) + "\n")


def _db_config():
    cfg_env = _leer_env()
    return {
        "host": os.environ.get("DB_HOST") or cfg_env.get("DB_HOST", "72.62.166.253"),
        "port": int(os.environ.get("DB_PORT") or cfg_env.get("DB_PORT", "3306")),
        "user": os.environ.get("DB_USER") or cfg_env.get("DB_USER", "sistema_user"),
        "password": os.environ.get("DB_PASS") or cfg_env.get("DB_PASS", "12345"),
        "database": os.environ.get("DB_NAME") or cfg_env.get("DB_NAME", "sistema_contable"),
    }


def _product_images_default_url():
    cfg = _leer_env()
    if cfg.get("PRODUCT_IMAGES_URL"):
        return cfg["PRODUCT_IMAGES_URL"].rstrip("/") + "/"
    return "https://ferredistribucionesalumas.com/img/productos/"


def _build_remote_image_url(nombre_archivo, url_base_opcional=""):
    nombre_limpio = (nombre_archivo or "").strip()
    if not nombre_limpio:
        return None
    nombre_archivo_web = os.path.basename(nombre_limpio.replace("\\", "/"))
    if not nombre_archivo_web:
        return None
    base = (url_base_opcional or _product_images_default_url()).rstrip("/")
    return base + "/" + urllib.parse.quote(nombre_archivo_web)


def _product_images_default_folder():
    cfg = _leer_env()
    if cfg.get("PRODUCT_IMAGES_FOLDER") and os.path.isdir(cfg["PRODUCT_IMAGES_FOLDER"]):
        return cfg["PRODUCT_IMAGES_FOLDER"]
    candidato_escritorio = os.path.join(BASE_DIR, "..", "imagenes productis")
    try:
        candidato_escritorio = os.path.abspath(candidato_escritorio)
        if os.path.isdir(candidato_escritorio):
            return candidato_escritorio
    except Exception:
        pass
    return ""


def _traer_productos_bd(lote=15, orden="nuevos"):
    cfg = _db_config()
    conn = mysql.connector.connect(
        host=cfg["host"], user=cfg["user"], password=cfg["password"],
        database=cfg["database"], port=int(cfg["port"]), use_pure=True,
        connection_timeout=15, charset="utf8mb4",
    )
    cur = conn.cursor(dictionary=True)
    where_imagen = "TRIM(COALESCE(imagen,'')) <> '' AND stock > 0"
    if orden == "nuevos":
        order = "fecha_actualizacion DESC, id_producto DESC"
    elif orden == "antiguos":
        order = "fecha_actualizacion ASC, id_producto ASC"
    elif orden == "aleatorio":
        order = "RAND()"
    elif orden == "mayor_stock":
        order = "stock DESC"
    else:
        order = "id_producto DESC"
    cur.execute(
        f"""
        SELECT id_producto, nombre, precio_final, precio_mayorista, stock,
               imagen, fecha_actualizacion
        FROM productos
        WHERE {where_imagen}
        ORDER BY {order}
        LIMIT %s
        """,
        (lote,),
    )
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return rows


# ---------------------------------------------------------------
# Fuentes seguras para el render de imágenes
# ---------------------------------------------------------------
def _cargar_fuente(tam, peso="normal"):
    rutas = []
    if peso == "bold":
        rutas += [
            "C:/Windows/Fonts/arialbd.ttf",
            "C:/Windows/Fonts/segoeuib.ttf",
            "C:/Windows/Fonts/arial.ttf",
        ]
    else:
        rutas += [
            "C:/Windows/Fonts/segoeui.ttf",
            "C:/Windows/Fonts/arial.ttf",
        ]
    rutas += ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]
    for r in rutas:
        if os.path.isfile(r):
            try:
                return ImageFont.truetype(r, tam)
            except Exception:
                continue
    return ImageFont.load_default()


def _medir_texto(draw, txt, font):
    if hasattr(draw, "textbbox"):
        l, t, r, b = draw.textbbox((0, 0), txt, font=font)
        return r - l, b - t
    return draw.textsize(txt, font=font)


def _ajustar_fuente(draw, texto, font_size_inicial, ancho_max, min_size=18, bold=True):
    fs = font_size_inicial
    while fs >= min_size:
        font = _cargar_fuente(fs, "bold" if bold else "normal")
        w, _ = _medir_texto(draw, texto, font)
        if w <= ancho_max:
            return font
        fs -= 2
    return _cargar_fuente(min_size, "bold" if bold else "normal")


def _envolver_texto(draw, texto, font, ancho_max):
    palabras = texto.split()
    lineas = []
    actual = ""
    for p in palabras:
        prueba = (actual + " " + p).strip()
        w, _ = _medir_texto(draw, prueba, font)
        if w <= ancho_max:
            actual = prueba
        else:
            if actual:
                lineas.append(actual)
            actual = p
    if actual:
        lineas.append(actual)
    return lineas or [""]


# ---------------------------------------------------------------
# Descarga / carga de imagen del producto
# ---------------------------------------------------------------
def _descargar_http(url, timeout=10):
    req = urllib.request.Request(
        url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
    )
    ctx_ssl = None
    try:
        import ssl
        ctx_ssl = ssl.create_default_context()
        ctx_ssl.check_hostname = False
        ctx_ssl.verify_mode = ssl.CERT_NONE
    except Exception:
        pass
    with urllib.request.urlopen(req, timeout=timeout, context=ctx_ssl) as resp:
        data = resp.read()
        if len(data) < 200:
            return None
        return Image.open(io.BytesIO(data)).convert("RGBA")


def _cargar_imagen_producto(nombre_archivo, url_base_opcional="", carpeta_extra=""):
    # 1) Carpeta LOCAL que el usuario configuró (la más prioritaria)
    carpetas_a_probar = []
    if carpeta_extra and os.path.isdir(carpeta_extra):
        carpetas_a_probar.append(carpeta_extra)
    # 2) Carpeta conocida del escritorio "imagenes productis"
    known1 = os.path.abspath(os.path.join(BASE_DIR, "..", "imagenes productis"))
    if os.path.isdir(known1):
        carpetas_a_probar.append(known1)
    # 3) img/productos local del programa
    carpetas_a_probar.append(os.path.join(BASE_DIR, "img", "productos"))
    # 4) IMG ESTADOS / carpetas con fotos del Escritorio
    for extra in [
        os.path.join(BASE_DIR, "..", "IMG ESTADOS"),
        os.path.join(BASE_DIR, "img", "estados"),
    ]:
        p = os.path.abspath(extra) if extra else ""
        if p and os.path.isdir(p):
            carpetas_a_probar.append(p)

    nombre_limpio = (nombre_archivo or "").strip()
    base_sin_ext = os.path.splitext(nombre_limpio)[0].lower() if nombre_limpio else ""
    extensiones = [os.path.splitext(nombre_limpio)[1].lower() or ".png", ".jpg", ".jpeg", ".webp", ".png"]

    def _buscar_en_carpeta(carpeta):
        if not os.path.isdir(carpeta):
            return None
        # A) Coincidencia exacta
        for ext in extensiones:
            candidato = os.path.join(carpeta, nombre_limpio if ext == os.path.splitext(nombre_limpio)[1].lower() else base_sin_ext + ext)
            if os.path.isfile(candidato):
                try:
                    return Image.open(candidato).convert("RGBA")
                except Exception:
                    pass
            if nombre_limpio and os.path.isfile(os.path.join(carpeta, nombre_limpio)):
                try:
                    return Image.open(os.path.join(carpeta, nombre_limpio)).convert("RGBA")
                except Exception:
                    pass
        # B) Búsqueda difusa: por iniciales del nombre de archivo o ID numérico
        try:
            archivos = os.listdir(carpeta)
        except Exception:
            return None
        mejor_puntaje = 0
        mejor = None
        prefijo_id = ""
        if base_sin_ext:
            partes = base_sin_ext.split("_", 1)
            if partes and partes[0].isdigit():
                prefijo_id = partes[0]
        for f in archivos:
            fbase = os.path.splitext(f)[0].lower()
            punt = 0
            if prefijo_id and (fbase.startswith(prefijo_id + "_") or fbase == prefijo_id or f.startswith(prefijo_id + ".")):
                punt += 50
            if base_sin_ext and base_sin_ext in fbase:
                punt += 80
            elif base_sin_ext and base_sin_ext[:20] and base_sin_ext[:20] in fbase:
                punt += 30
            if punt and punt >= mejor_puntaje:
                mejor_puntaje = punt
                try:
                    mejor = Image.open(os.path.join(carpeta, f)).convert("RGBA")
                except Exception:
                    mejor = None
        return mejor if mejor_puntaje >= 30 else None

    for carp in carpetas_a_probar:
        res = _buscar_en_carpeta(carp)
        if res is not None:
            return res

    # 5) URL base personalizada HTTP
    if nombre_limpio:
        url = _build_remote_image_url(nombre_limpio, url_base_opcional)
        try:
            if url:
                img = _descargar_http(url)
                if img:
                    return img
        except Exception:
            pass

    # 6) Nombre dentro de carpetas de materiales ALUMAS (fallback)
    for cat in ["distribucion", "MATERIALES", "PLACAS", "TECHOPVC", "UV", "WPC", "LUNES", "MARTES", "MIERCOLES", "JUEVES", "VIERNES"]:
        d = os.path.join(BASE_DIR, "img", cat)
        if not os.path.isdir(d):
            continue
        for f in sorted(os.listdir(d)):
            base = os.path.splitext(f)[0].lower()
            if base[:4] and base[:4] in (nombre_limpio or "").lower():
                try:
                    return Image.open(os.path.join(d, f)).convert("RGBA")
                except Exception:
                    pass

    # 7) Placeholder (se genera fuera)
    return None


def _placeholder_imagen_producto(nombre, ancho, alto):
    iniciales = "".join([w[:1] for w in str(nombre).split() if w][:2]).upper() or "AL"
    grad = Image.new("RGBA", (ancho, alto), (30, 30, 60, 255))
    draw = ImageDraw.Draw(grad)
    for y in range(alto):
        t = y / max(1, alto - 1)
        r = int(25 + (55 - 25) * t)
        g = int(30 + (120 - 30) * t)
        b = int(80 + (200 - 80) * t)
        draw.line([(0, y), (ancho, y)], fill=(r, g, b, 255))
    # Círculo central con iniciales
    cx, cy, cr = ancho // 2, alto // 2, min(ancho, alto) // 3
    draw.ellipse((cx - cr, cy - cr, cx + cr, cy + cr), fill=(255, 255, 255, 36), outline=(255, 255, 255, 180), width=6)
    font = _cargar_fuente(cr * 2 // 3, "bold")
    w, h = _medir_texto(draw, iniciales, font)
    draw.text((cx - w // 2, cy - h // 2 - 6), iniciales, fill=(255, 255, 255, 245), font=font)
    return grad


def _nombre_archivo_estado(producto, indice):
    safe = "".join([
        c if c.isalnum() or c in " -_" else "_"
        for c in (producto.get("nombre") or "p")
    ]).strip()
    safe = safe or "producto"
    return f"{indice:02d}_{str(producto['id_producto'])}__{safe[:60]}.png"


def _json_safe_value(value):
    if isinstance(value, Decimal):
        return float(value)
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value


def generar_estados_lote(
    cantidad=15,
    orden="nuevos",
    salida_dir=None,
    url_imagenes="",
    logo_path=None,
    carpeta_imagenes="",
    promos=None,
):
    rows = _traer_productos_bd(int(cantidad), orden)
    if not rows:
        raise RuntimeError("No hay productos con imagen y stock > 0 para generar estados.")

    output_dir = salida_dir or tempfile.mkdtemp(prefix="ALUMAS_estados_")
    os.makedirs(output_dir, exist_ok=True)

    promos_pool = [str(item).strip() for item in (promos or _cargar_promos_guardadas_archivo()) if str(item).strip()]
    if not promos_pool:
        promos_pool = list(PROMOS_DEFAULT)
    random.shuffle(promos_pool)

    generated_files = []
    for idx, prod in enumerate(rows, start=1):
        promo = promos_pool[(idx - 1) % len(promos_pool)]
        img = render_estado(prod, url_imagenes, promo, logo_path if logo_path else None, carpeta_imagenes)
        fname = _nombre_archivo_estado(prod, idx)
        fpath = os.path.join(output_dir, fname)
        img.save(fpath, "PNG", optimize=True)
        generated_files.append({
            "index": idx,
            "file_name": fname,
            "file_path": fpath,
            "promo": promo,
            "product": {
                "id_producto": prod.get("id_producto"),
                "nombre": prod.get("nombre"),
                "precio_final": _json_safe_value(prod.get("precio_final")),
                "precio_mayorista": _json_safe_value(prod.get("precio_mayorista")),
                "stock": _json_safe_value(prod.get("stock")),
                "imagen": _json_safe_value(prod.get("imagen")),
                "fecha_actualizacion": _json_safe_value(prod.get("fecha_actualizacion")),
            },
        })

    return {
        "output_dir": output_dir,
        "count": len(generated_files),
        "order": orden,
        "generated_files": generated_files,
    }


# ---------------------------------------------------------------
# Motor de render del estado WhatsApp 1080 x 1920
# ---------------------------------------------------------------
TAM_ESTADO = (1080, 1920)


def _fondo_gradiente(w, h):
    img = Image.new("RGBA", (w, h), (10, 10, 22, 255))
    draw = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(1, h - 1)
        r = int(12 + (40 - 12) * t)
        g = int(18 + (52 - 18) * t)
        b = int(40 + (120 - 40) * t)
        draw.line([(0, y), (w, y)], fill=(r, g, b, 255))
    # Manchas atmosféricas de brillo (estilo que te gustan)
    for (cx, cy, rad, color) in [
        (w * 0.20, h * 0.15, 420, (245, 166, 35, 45)),
        (w * 0.82, h * 0.88, 540, (42, 123, 255, 40)),
        (w * 0.50, h * 0.50, 700, (120, 180, 255, 12)),
    ]:
        s = rad * 2
        blob = Image.new("RGBA", (s, s), (0, 0, 0, 0))
        bd = ImageDraw.Draw(blob)
        for i in range(50, 0, -1):
            opa = int(color[3] * (i / 50))
            bd.ellipse(
                ((s // 2 - rad * (i / 50), s // 2 - rad * (i / 50)),
                 (s // 2 + rad * (i / 50), s // 2 + rad * (i / 50))),
                fill=(color[0], color[1], color[2], opa),
            )
        blob = blob.filter(ImageFilter.GaussianBlur(6))
        img.alpha_composite(blob, (int(cx - s // 2), int(cy - s // 2)))
    return img


def render_estado(producto, url_imagenes="", promo_texto=None, logo_path=None, carpeta_imagenes=""):
    W, H = TAM_ESTADO
    canvas = _fondo_gradiente(W, H)
    draw = ImageDraw.Draw(canvas)

    # ------- Marco azul (contorno interior separado del margen) -------
    MARCO_MARGEN = 40
    MARCO_GROSOR = 6
    azul_borde = (42, 123, 255, 255)
    azul_brillo = (106, 168, 255, 255)
    # Brillo exterior
    for i in range(8):
        opa = 130 - i * 15
        if opa <= 0:
            break
        draw.rounded_rectangle(
            (MARCO_MARGEN - i, MARCO_MARGEN - i,
             W - MARCO_MARGEN + i, H - MARCO_MARGEN + i),
            radius=42, outline=(azul_brillo[0], azul_brillo[1], azul_brillo[2], max(0, opa)), width=2,
        )
    draw.rounded_rectangle(
        (MARCO_MARGEN, MARCO_MARGEN, W - MARCO_MARGEN, H - MARCO_MARGEN),
        radius=40, outline=azul_borde, width=MARCO_GROSOR,
    )
    # Borde interior oscuro
    draw.rounded_rectangle(
        (MARCO_MARGEN + 10, MARCO_MARGEN + 10,
         W - MARCO_MARGEN - 10, H - MARCO_MARGEN - 10),
        radius=34, outline=(255, 255, 255, 28), width=2,
    )

    # ------- Zonas internas -------
    INTERIOR_X1 = MARCO_MARGEN + 40
    INTERIOR_X2 = W - MARCO_MARGEN - 40
    INTERIOR_Y1 = MARCO_MARGEN + 40
    INTERIOR_Y2 = H - MARCO_MARGEN - 40
    ancho_int = INTERIOR_X2 - INTERIOR_X1
    alto_int = INTERIOR_Y2 - INTERIOR_Y1

    # 1) Etiqueta promo aleatoria superior
    promo_txt = promo_texto or random.choice(PROMOS_DEFAULT)
    promo_padding_x, promo_padding_y = 26, 18
    font_promo = _cargar_fuente(52, "bold")
    pw, ph = _medir_texto(draw, promo_txt, font_promo)
    promo_cx = (INTERIOR_X1 + INTERIOR_X2) // 2
    promo_y1 = INTERIOR_Y1 + 12
    x1 = promo_cx - pw // 2 - promo_padding_x
    y1 = promo_y1
    x2 = promo_cx + pw // 2 + promo_padding_x
    y2 = promo_y1 + ph + promo_padding_y * 2
    draw.rounded_rectangle((x1, y1, x2, y2), radius=30,
                           fill=(245, 166, 35, 255),
                           outline=(255, 255, 255, 80), width=3)
    # Sombra al texto promo
    draw.text((promo_cx - pw // 2 + 3, promo_y1 + promo_padding_y + 3), promo_txt,
              fill=(0, 0, 0, 110), font=font_promo)
    draw.text((promo_cx - pw // 2, promo_y1 + promo_padding_y), promo_txt,
              fill=(22, 22, 35, 255), font=font_promo)

    # 2) Imagen del producto
    foto_y1 = y2 + 50
    foto_h = 980
    foto_area_x1 = INTERIOR_X1 + 30
    foto_area_x2 = INTERIOR_X2 - 30
    foto_area_y1 = foto_y1
    foto_area_y2 = foto_y1 + foto_h
    foto_w = foto_area_x2 - foto_area_x1
    # Fondo panel foto
    draw.rounded_rectangle(
        (foto_area_x1 - 10, foto_area_y1 - 10, foto_area_x2 + 10, foto_area_y2 + 10),
        radius=36, fill=(255, 255, 255, 10), outline=(255, 255, 255, 28), width=2,
    )
    draw.rounded_rectangle(
        (foto_area_x1, foto_area_y1, foto_area_x2, foto_area_y2),
        radius=32, fill=(255, 255, 255, 255),
    )
    # Cargar imagen
    imagen_p = _cargar_imagen_producto(producto.get("imagen") or "", url_imagenes, carpeta_imagenes)
    if imagen_p is None:
        imagen_p = _placeholder_imagen_producto(producto.get("nombre") or "ALUMAS", foto_w, foto_h)
    # Fit (contain) con fondo blanco
    iw, ih = imagen_p.size
    ratio = min(foto_w / max(1, iw), foto_h / max(1, ih))
    niw, nih = int(iw * ratio), int(ih * ratio)
    imagen_p = imagen_p.resize((niw, nih), Image.LANCZOS)
    # Sombras proyectadas soft
    sombra = Image.new("RGBA", (foto_w, foto_h), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sombra)
    sd.rounded_rectangle((0, 0, foto_w, foto_h), radius=32, fill=(0, 0, 0, 100))
    sombra = sombra.filter(ImageFilter.GaussianBlur(20))
    canvas.alpha_composite(sombra, (foto_area_x1 + 14, foto_area_y1 + 18))
    # Pegar centrado
    canvas.paste(imagen_p, (foto_area_x1 + (foto_w - niw) // 2, foto_area_y1 + (foto_h - nih) // 2), imagen_p)

    # 3) Nombre del producto debajo
    nombre_y1 = foto_area_y2 + 56
    font_nombre = _ajustar_fuente(draw, producto.get("nombre") or "Producto", 70, ancho_int - 40, min_size=40, bold=True)
    lineas = _envolver_texto(draw, producto.get("nombre") or "Producto", font_nombre, ancho_int - 40)
    # Limitar a 2 lineas
    lineas = lineas[:2]
    ny = nombre_y1
    for ln in lineas:
        w, h = _medir_texto(draw, ln, font_nombre)
        draw.text(((INTERIOR_X1 + INTERIOR_X2) // 2 - w // 2 + 3, ny + 3), ln,
                  fill=(0, 0, 0, 90), font=font_nombre)
        draw.text(((INTERIOR_X1 + INTERIOR_X2) // 2 - w // 2, ny), ln,
                  fill=(255, 255, 255, 255), font=font_nombre)
        ny += h + 12

    # 4) Badge ÚNICO: PRECIO MAYORISTA centrado, grande
    badges_y = ny + 46
    badges_w = min(880, ancho_int - 80)
    badges_h = 220
    precio_mayo = producto.get("precio_mayorista") or 0 or producto.get("precio_final") or 0

    def _draw_badge_centrado(x1, y1, x2, y2, titulo, valor, color_fondo, color_texto):
        draw.rounded_rectangle((x1, y1, x2, y2), radius=34, fill=color_fondo,
                               outline=(255, 255, 255, 90), width=3)
        # Sombra interior suave
        draw.rounded_rectangle((x1 + 6, y1 + 6, x2 - 6, y2 - 6), radius=28,
                               outline=(255, 255, 255, 28), width=2)
        ft = _cargar_fuente(38, "bold")
        w, h = _medir_texto(draw, titulo, ft)
        titulo_cx = (x1 + x2) // 2
        draw.text((titulo_cx - w // 2, y1 + 30), titulo, fill=color_texto, font=ft)
        fv = _ajustar_fuente(draw, valor, 110, (x2 - x1) - 80, min_size=60, bold=True)
        w2, h2 = _medir_texto(draw, valor, fv)
        # Sombra al número
        draw.text(((x1 + x2) // 2 - w2 // 2 + 4, y1 + (y2 - y1) // 2 - 6 + 4), valor,
                  fill=(0, 0, 0, 90), font=fv)
        draw.text(((x1 + x2) // 2 - w2 // 2, y1 + (y2 - y1) // 2 - 6), valor, fill=color_texto, font=fv)

    txt_mayo = f"${precio_mayo:,.0f}".replace(",", ".")
    bx1 = (INTERIOR_X1 + INTERIOR_X2) // 2 - badges_w // 2
    _draw_badge_centrado(
        bx1, badges_y, bx1 + badges_w, badges_y + badges_h,
        "PRECIO MAYORISTA", txt_mayo,
        (42, 123, 255, 255), (255, 255, 255, 255),
    )

    # 5) Logo ALUMAS responsive abajo, MUCHO MÁS GRANDE (2x)
    logo_area_y = INTERIOR_Y2 - 240
    logo_area_x1 = INTERIOR_X1 + 10
    logo_area_x2 = INTERIOR_X2 - 10
    max_logo_w = logo_area_x2 - logo_area_x1
    max_logo_h = 220
    logo_ok = False
    if logo_path and os.path.isfile(logo_path):
        try:
            logo = Image.open(logo_path).convert("RGBA")
            lw, lh = logo.size
            r = min(max_logo_w / max(1, lw), max_logo_h / max(1, lh), 1.4)
            logo = logo.resize((int(lw * r), int(lh * r)), Image.LANCZOS)
            lw2, lh2 = logo.size
            lx = logo_area_x1 + (max_logo_w - lw2) // 2
            ly = logo_area_y + (max_logo_h - lh2) // 2
            # Sombra del logo (más fuerte porque es más grande)
            shad = logo.copy()
            alpha = shad.split()[-1].point(lambda px: 120 if px else 0)
            shad.putalpha(alpha)
            shad = shad.filter(ImageFilter.GaussianBlur(9))
            canvas.alpha_composite(shad, (lx + 5, ly + 8))
            canvas.alpha_composite(logo, (lx, ly))
            logo_ok = True
        except Exception:
            logo_ok = False
    if not logo_ok:
        font_log = _cargar_fuente(90, "bold")
        t = "ALUMAS"
        w, h = _medir_texto(draw, t, font_log)
        cx = (logo_area_x1 + logo_area_x2) // 2
        cy = logo_area_y + max_logo_h // 2
        draw.line((logo_area_x1 + 60, cy - h // 2 - 18, logo_area_x2 - 60, cy - h // 2 - 18),
                  fill=(245, 166, 35, 240), width=7)
        draw.line((logo_area_x1 + 60, cy + h // 2 + 18, logo_area_x2 - 60, cy + h // 2 + 18),
                  fill=(245, 166, 35, 240), width=7)
        draw.text((cx - w // 2 + 3, cy - h // 2 + 3), t, fill=(0, 0, 0, 140), font=font_log)
        draw.text((cx - w // 2, cy - h // 2), t, fill=(245, 166, 35, 255), font=font_log)

    # Convertir a RGB (WhatsApp prefiere JPG/PNG)
    return canvas.convert("RGB")


# ---------------------------------------------------------------
# Aplicación Tkinter
# ---------------------------------------------------------------
class GeneradorEstadosApp:
    def __init__(self, root):
        self.root = root
        self.root.title("ALUMAS · Generador de Estados de WhatsApp desde Inventario v3")
        self.root.geometry("1280x820")
        self.root.minsize(1180, 720)
        self.root.configure(bg=COLOR_FONDO)
        aplicar_tema(self.root)

        # Estado
        self.productos_seleccionados = []
        self.carpeta_temporal_actual = None
        self.thread_worker = None
        self._cancelar = False
        self.promos_usuario = list(PROMOS_DEFAULT)
        self._cargar_promos_guardadas()

        # Header
        header = tk.Frame(root, bg=COLOR_PANEL, height=84)
        header.pack(fill=tk.X)
        header.pack_propagate(False)
        tk.Label(header, text="🎨 ALUMAS", bg=COLOR_PANEL, fg=COLOR_ACENTO,
                 font=("Segoe UI", 22, "bold")).pack(side=tk.LEFT, padx=24)
        tk.Label(header, text="Generador de Estados · 15 productos desde la BD Inventario",
                 bg=COLOR_PANEL, fg=COLOR_TEXTO_SUAVE, font=("Segoe UI", 11)).pack(side=tk.LEFT)
        self.lbl_resumen = tk.Label(header, text="Listo.", bg=COLOR_PANEL, fg=COLOR_AZUL_CLARO,
                                    font=("Segoe UI", 11, "bold"))
        self.lbl_resumen.pack(side=tk.RIGHT, padx=24)

        nb = ttk.Notebook(root)
        nb.pack(fill=tk.BOTH, expand=True, padx=14, pady=14)

        # Pestaña 1: Configurar y generar
        f1 = ttk.Frame(nb)
        nb.add(f1, text="  🛠️  Configuración y Generar  ")
        self._ui_pestana_generar(f1)

        # Pestaña 2: Promociones editables
        f2 = ttk.Frame(nb)
        nb.add(f2, text="  ✨  Mensajes Promocionales  ")
        self._ui_pestana_promos(f2)

        # Pestaña 3: Resultados / carpeta temporal
        f3 = ttk.Frame(nb)
        nb.add(f3, text="  📂  Estados Generados  ")
        self._ui_pestana_resultados(f3)

    # -------------------- UI Pestañas --------------------
    def _ui_pestana_generar(self, parent):
        wrap = tk.Frame(parent, bg=COLOR_FONDO)
        wrap.pack(fill=tk.BOTH, expand=True, padx=8, pady=8)

        # Columna izquierda: configuración
        cfg_frm = tk.LabelFrame(wrap, text=" CONEXIÓN Y PARÁMETROS ", bg=COLOR_PANEL, fg=COLOR_ACENTO,
                                font=("Segoe UI", 10, "bold"), bd=0, padx=14, pady=12)
        cfg_frm.pack(side=tk.LEFT, fill=tk.Y, padx=(0, 12))
        cfg_frm.configure(width=420)
        cfg_frm.pack_propagate(False)

        # URL imágenes
        tk.Label(cfg_frm, text="URL base donde están las fotos de productos (HTTP, opcional):",
                 bg=COLOR_PANEL, fg=COLOR_TEXTO_SUAVE, font=("Segoe UI", 9)).pack(anchor=tk.W)
        self.var_url_img = tk.StringVar(value=_product_images_default_url())
        e1 = ttk.Entry(cfg_frm, textvariable=self.var_url_img, width=42)
        e1.pack(fill=tk.X, pady=(4, 4), ipady=5)
        hint = ("Ejemplos:\n"
                "  https://tusitio.com/uploads/productos\n"
                "  https://dominio.hstn.me/public/img/productos\n\n"
                "Si no sabes la URL, NO lo rellenes y usa la\n"
                "opción CARPETA LOCAL de abajo (recomendado).")
        tk.Label(cfg_frm, text=hint, bg=COLOR_PANEL, fg=COLOR_TEXTO_SUAVE,
                 font=("Segoe UI", 9), justify=tk.LEFT).pack(anchor=tk.W, pady=(6, 6))

        # Carpeta LOCAL de fotos (PRIORIDAD 1)
        tk.Label(cfg_frm, text="📂 Carpeta LOCAL donde están las fotos de productos (¡prioridad!):",
                 bg=COLOR_PANEL, fg=COLOR_AZUL_CLARO, font=("Segoe UI", 9, "bold")).pack(anchor=tk.W)
        self.var_carpeta_img = tk.StringVar(value=_product_images_default_folder())
        frm_carp = tk.Frame(cfg_frm, bg=COLOR_PANEL)
        frm_carp.pack(fill=tk.X, pady=(4, 4))
        ttk.Entry(frm_carp, textvariable=self.var_carpeta_img).pack(side=tk.LEFT, fill=tk.X, expand=True, ipady=3)
        ttk.Button(frm_carp, text="…", command=self._elegir_carpeta_img, width=3).pack(side=tk.LEFT, padx=4)
        hint2 = ("El programa buscará las fotos automáticamente:\n"
                 "  1) En esta carpeta (coincidencia exacta o por ID de producto)\n"
                 "  2) En la carpeta del Escritorio 'imagenes productis' (si existe)\n"
                 "  3) En img/productos dentro de la carpeta del programa\n"
                 "  4) Si no se encuentra, dibuja un placeholder elegante.")
        tk.Label(cfg_frm, text=hint2, bg=COLOR_PANEL, fg=COLOR_TEXTO_SUAVE,
                 font=("Segoe UI", 9), justify=tk.LEFT).pack(anchor=tk.W, pady=(2, 14))

        # Logo
        tk.Label(cfg_frm, text="Logo ALUMAS (PNG):", bg=COLOR_PANEL,
                 fg=COLOR_TEXTO_SUAVE, font=("Segoe UI", 9)).pack(anchor=tk.W)
        logo_defecto = os.path.join(BASE_DIR, "img", "LOGO3.png")
        self.var_logo = tk.StringVar(value=logo_defecto if os.path.isfile(logo_defecto) else "")
        frm_logo = tk.Frame(cfg_frm, bg=COLOR_PANEL)
        frm_logo.pack(fill=tk.X, pady=(4, 12))
        ttk.Entry(frm_logo, textvariable=self.var_logo).pack(side=tk.LEFT, fill=tk.X, expand=True, ipady=3)
        ttk.Button(frm_logo, text="…", command=self._elegir_logo, width=3).pack(side=tk.LEFT, padx=4)

        # Cantidad
        tk.Label(cfg_frm, text="Cantidad de estados a generar:", bg=COLOR_PANEL,
                 fg=COLOR_TEXTO_SUAVE, font=("Segoe UI", 9)).pack(anchor=tk.W)
        self.var_cant = tk.IntVar(value=15)
        ttk.Combobox(cfg_frm, textvariable=self.var_cant, state="readonly",
                     values=[10, 15, 20, 25, 30, 40, 50]).pack(fill=tk.X, pady=(4, 12), ipady=4)

        # Orden
        tk.Label(cfg_frm, text="Orden de selección (desde inventario Hostinger):",
                 bg=COLOR_PANEL, fg=COLOR_TEXTO_SUAVE, font=("Segoe UI", 9)).pack(anchor=tk.W)
        self.var_orden = tk.StringVar(value="nuevos")
        ordenes = [
            ("🆕 Nuevos / recién actualizados (recomendado)", "nuevos"),
            ("🎲 Aleatorios", "aleatorio"),
            ("📦 Mayor stock primero", "mayor_stock"),
            ("⏳ Más antiguos", "antiguos"),
        ]
        frm_orden = tk.Frame(cfg_frm, bg=COLOR_PANEL)
        frm_orden.pack(fill=tk.X, pady=(4, 12))
        for text, val in ordenes:
            ttk.Radiobutton(frm_orden, text=text, value=val, variable=self.var_orden).pack(anchor=tk.W, pady=1)

        # Botones principales
        ttk.Button(cfg_frm, text="🔌 Probar conexión BD + URL fotos",
                   command=self._probar_conexion).pack(fill=tk.X, pady=(8, 4))
        ttk.Button(cfg_frm, text="💾 Guardar ajustes (URL + carpeta + logo)",
                   command=self._guardar_ajustes, style="TButton").pack(fill=tk.X, pady=4)
        ttk.Button(cfg_frm, text="🚀 GENERAR 15 ESTADOS AHORA",
                   command=self._generar, style="Accent.TButton").pack(fill=tk.X, pady=(18, 0))

        # Columna derecha: tabla productos
        tab_frm = tk.LabelFrame(wrap, text=" 15 PRODUCTOS A GENERAR (última selección) ",
                                bg=COLOR_PANEL, fg=COLOR_ACENTO,
                                font=("Segoe UI", 10, "bold"), bd=0, padx=10, pady=10)
        tab_frm.pack(side=tk.RIGHT, fill=tk.BOTH, expand=True)
        cols = ("id", "nombre", "mayor", "img")
        tv = ttk.Treeview(tab_frm, columns=cols, show="headings")
        for c, txt, w in [
            ("id", "ID", 60), ("nombre", "Producto", 400),
            ("mayor", "$ Mayorista", 150), ("img", "Imagen (archivo)", 260)
        ]:
            tv.heading(c, text=txt)
            tv.column(c, width=w, anchor=tk.W)
        vsb = ttk.Scrollbar(tab_frm, orient="vertical", command=tv.yview)
        tv.configure(yscrollcommand=vsb.set)
        tv.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        vsb.pack(side=tk.RIGHT, fill=tk.Y)
        self.tree = tv

        # Barra progreso
        prog_frm = tk.Frame(parent, bg=COLOR_FONDO)
        prog_frm.pack(fill=tk.X, padx=18, pady=(0, 14))
        self.pb = ttk.Progressbar(prog_frm, mode="determinate", maximum=100)
        self.pb.pack(fill=tk.X, side=tk.LEFT, expand=True, padx=(0, 10))
        self.btn_cancelar = ttk.Button(prog_frm, text="⏹ Cancelar", command=self._cancelar_generacion, state="disabled")
        self.btn_cancelar.pack(side=tk.RIGHT)

    def _ui_pestana_promos(self, parent):
        wrap = tk.Frame(parent, bg=COLOR_FONDO)
        wrap.pack(fill=tk.BOTH, expand=True, padx=14, pady=12)
        tk.Label(wrap, text="Mensajes aleatorios (se elige uno diferente por cada estado):",
                 bg=COLOR_FONDO, fg=COLOR_TEXTO,
                 font=("Segoe UI", 11, "bold")).pack(anchor=tk.W, pady=(0, 8))
        frm_p = tk.Frame(wrap, bg=COLOR_FONDO)
        frm_p.pack(fill=tk.BOTH, expand=True)
        self.lst_promos = tk.Listbox(frm_p, bg="#17172a", fg=COLOR_TEXTO,
                                     selectbackground=COLOR_AZUL,
                                     selectforeground="#fff",
                                     font=("Segoe UI", 12), bd=0, activestyle="none",
                                     highlightthickness=0)
        self.lst_promos.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=(0, 12))
        for p in self.promos_usuario:
            self.lst_promos.insert(tk.END, p)
        btns = tk.Frame(frm_p, bg=COLOR_FONDO)
        btns.pack(side=tk.RIGHT, fill=tk.Y)
        ttk.Button(btns, text="➕ Añadir", command=self._anadir_promo).pack(fill=tk.X, pady=3)
        ttk.Button(btns, text="✏ Editar", command=self._editar_promo).pack(fill=tk.X, pady=3)
        ttk.Button(btns, text="❌ Eliminar", command=self._eliminar_promo).pack(fill=tk.X, pady=3)
        ttk.Button(btns, text="↺ Restablecer", command=self._resetear_promos).pack(fill=tk.X, pady=3)
        ttk.Button(btns, text="💾 Guardar lista", command=self._guardar_promos,
                   style="Primary.TButton").pack(fill=tk.X, pady=(14, 3))

    def _ui_pestana_resultados(self, parent):
        wrap = tk.Frame(parent, bg=COLOR_FONDO)
        wrap.pack(fill=tk.BOTH, expand=True, padx=14, pady=12)
        cab = tk.LabelFrame(wrap, text=" CARPETA TEMPORAL (se elimina al cerrar el programa) ",
                            bg=COLOR_PANEL, fg=COLOR_ACENTO,
                            font=("Segoe UI", 10, "bold"), bd=0, padx=14, pady=12)
        cab.pack(fill=tk.X)
        self.lbl_carpeta = tk.Label(cab, text="(aún no se ha generado nada)",
                                    bg=COLOR_PANEL, fg=COLOR_AZUL_CLARO,
                                    font=("Consolas", 11, "bold"))
        self.lbl_carpeta.pack(anchor=tk.W)
        frm_botones = tk.Frame(cab, bg=COLOR_PANEL)
        frm_botones.pack(fill=tk.X, pady=(10, 0))
        ttk.Button(frm_botones, text="📋 Copiar ruta al portapapeles",
                   command=self._copiar_ruta_temp).pack(side=tk.LEFT, padx=(0, 10))
        ttk.Button(frm_botones, text="📂 Abrir carpeta en Explorador",
                   command=self._abrir_carpeta_temp, style="Primary.TButton").pack(side=tk.LEFT, padx=(0, 10))
        ttk.Button(frm_botones, text="💾 Guardar copia permanente…",
                   command=self._guardar_permanente).pack(side=tk.LEFT)
        ttk.Button(frm_botones, text="🗑 Eliminar y limpiar",
                   command=self._limpiar_carpeta_temp).pack(side=tk.RIGHT)
        # Mini galeria
        gframe = tk.LabelFrame(wrap, text=" VISTA PREVIA (primeros 6 estados) ",
                               bg=COLOR_PANEL, fg=COLOR_ACENTO,
                               font=("Segoe UI", 10, "bold"), bd=0, padx=10, pady=10)
        gframe.pack(fill=tk.BOTH, expand=True, pady=(14, 0))
        self.preview_imagenes = []  # Para previews
        self.galeria = tk.Frame(gframe, bg=COLOR_PANEL)
        self.galeria.pack(fill=tk.BOTH, expand=True)
        self.lbl_info_galeria = tk.Label(gframe,
                                         text="(sin miniaturas; genera los estados primero)",
                                         bg=COLOR_PANEL, fg=COLOR_TEXTO_SUAVE,
                                         font=("Segoe UI", 10))
        self.lbl_info_galeria.pack()
        # Al cerrar, limpiar carpeta temporal
        self.root.protocol("WM_DELETE_WINDOW", self._al_cerrar)

    # -------------------- Logica: ajustes --------------------
    def _elegir_logo(self):
        f = filedialog.askopenfilename(
            title="Elegir logo ALUMAS (PNG recomendado)",
            filetypes=[("Imágenes", "*.png *.jpg *.jpeg *.webp *.bmp"), ("Todos", "*.*")],
            initialdir=BASE_DIR,
        )
        if f:
            self.var_logo.set(f)

    def _elegir_carpeta_img(self):
        from tkinter import filedialog
        inicial = self.var_carpeta_img.get().strip() or os.path.expanduser("~")
        f = filedialog.askdirectory(title="Selecciona la carpeta con las fotos de productos",
                                    initialdir=inicial if os.path.isdir(inicial) else os.path.expanduser("~"))
        if f:
            self.var_carpeta_img.set(f)

    def _guardar_ajustes(self):
        u = self.var_url_img.get().strip().rstrip("/")
        if u:
            _guardar_clave_env("PRODUCT_IMAGES_URL", u)
        c = self.var_carpeta_img.get().strip()
        if c and os.path.isdir(c):
            _guardar_clave_env("PRODUCT_IMAGES_FOLDER", c)
        l = self.var_logo.get().strip()
        if l and os.path.isfile(l):
            try:
                shutil.copyfile(l, os.path.join(BASE_DIR, "logo_alumas.png"))
            except Exception:
                pass
        messagebox.showinfo("Guardado", "Ajustes guardados en .env y carpeta local.")

    def _probar_conexion(self):
        self._set_resumen("Probando conexión BD + fotos…")

        def worker():
            info = []
            try:
                rows = _traer_productos_bd(3, self.var_orden.get())
                info.append(f"✅ BD OK: {len(rows)} productos con imagen y stock>0")
                for r in rows:
                    info.append(f"   · {r['nombre'][:45]}  (img={r['imagen']})")
            except Exception as e:
                logging.error("Conexion BD fallo: %s", e)
                self.root.after(0, lambda: messagebox.showerror("BD falló", str(e)))
                self.root.after(0, lambda: self._set_resumen("❌ Fallo BD"))
                return
            url = self.var_url_img.get().strip()
            carpeta = self.var_carpeta_img.get().strip()
            # Probar carga de imágenes combinando todas las fuentes
            alguna_ok = False
            for r in rows[:3]:
                try:
                    img = _cargar_imagen_producto(r.get("imagen") or "", url, carpeta)
                    if img is not None:
                        alguna_ok = True
                        info.append(f"✅ Imagen OK para: {r['nombre'][:40]} (w={img.size[0]}x{img.size[1]})")
                    else:
                        info.append(f"⚠ Placeholder para: {r['nombre'][:40]} (no encontrada en carpeta/URL)")
                except Exception as ex:
                    info.append(f"⚠ Fallo {r['nombre'][:40]}: {str(ex)[:80]}")
            if not alguna_ok and not carpeta and not url:
                info.append("ℹ Sin carpeta ni URL. Se usarán placeholders (diseño elegante).")
            if carpeta:
                info.append(f"ℹ Carpeta local: {carpeta}")
            self.root.after(0, lambda: messagebox.showinfo("Prueba de conexión", "\n".join(info)))
            self.root.after(0, lambda: self._set_resumen("Prueba finalizada."))

        threading.Thread(target=worker, daemon=True).start()

    # -------------------- Logica: generar --------------------
    def _generar(self):
        if self.thread_worker and self.thread_worker.is_alive():
            messagebox.showinfo("Ya hay un proceso", "Espera o cancela el actual.")
            return
        self._cancelar = False
        self.btn_cancelar.state(["!disabled"])
        self.pb["value"] = 0
        self._set_resumen("Seleccionando 15 productos de la BD…")

        def worker():
            # 1) Seleccionar productos
            try:
                rows = _traer_productos_bd(int(self.var_cant.get()), self.var_orden.get())
            except Exception as e:
                logging.error("BD al generar: %s", e)
                self.root.after(0, lambda: messagebox.showerror("Error BD", str(e)))
                self.root.after(0, lambda: self._set_resumen("❌ Fallo al consultar productos"))
                self.root.after(0, lambda: self.btn_cancelar.state(["disabled"]))
                return
            if not rows:
                self.root.after(0, lambda: messagebox.showwarning("Sin productos",
                    "No hay productos con imagen y stock>0 en la BD."))
                self.root.after(0, lambda: self._set_resumen("Nada que generar."))
                self.root.after(0, lambda: self.btn_cancelar.state(["disabled"]))
                return
            self.productos_seleccionados = rows
            self.root.after(0, lambda: self._refrescar_tabla(rows))

            # 2) Carpeta temporal
            if self.carpeta_temporal_actual and os.path.isdir(self.carpeta_temporal_actual):
                try:
                    shutil.rmtree(self.carpeta_temporal_actual, ignore_errors=True)
                except Exception:
                    pass
            tmp = tempfile.mkdtemp(prefix="ALUMAS_estados_")
            self.carpeta_temporal_actual = tmp
            self.root.after(0, lambda: self.lbl_carpeta.config(text=tmp))

            # 3) Renderizar cada uno
            ok = 0
            url_img = self.var_url_img.get().strip()
            carp_img = self.var_carpeta_img.get().strip()
            logo = self.var_logo.get().strip()
            total = len(rows)
            # Elegir N promos distintas para los 15 productos
            promos_pool = list(self.promos_usuario or PROMOS_DEFAULT)
            random.shuffle(promos_pool)

            miniaturas = []
            for idx, prod in enumerate(rows, start=1):
                if self._cancelar:
                    break
                try:
                    promo = promos_pool[(idx - 1) % len(promos_pool)]
                    img = render_estado(prod, url_img, promo, logo if logo else None, carp_img)
                    # Nombre archivo seguro
                    safe = "".join([c if c.isalnum() or c in " -_" else "_" for c in (prod.get("nombre") or "p")])
                    fname = f"{idx:02d}_{str(prod['id_producto'])}__{safe[:60]}.png"
                    fpath = os.path.join(tmp, fname)
                    img.save(fpath, "PNG", optimize=True)
                    ok += 1
                    # Miniatura
                    if len(miniaturas) < 6:
                        miniaturas.append((fpath, prod.get("nombre") or ""))
                except Exception as e:
                    logging.error("Fallo render producto %s: %s", prod.get("id_producto"), e, exc_info=True)
                pct = int((idx / total) * 100)
                self.root.after(0, lambda p=pct, i=idx, t=total:
                    (self.pb.configure(value=p), self._set_resumen(f"Generando {i}/{t}…")))
            self.root.after(0, lambda: self.pb.configure(value=100))
            self.root.after(0, lambda: self.btn_cancelar.state(["disabled"]))
            self.root.after(0, lambda m=miniaturas, k=ok: self._pintar_galeria(m, k))
            msg = f"✅ {ok} de {total} estados generados en carpeta temporal."
            self.root.after(0, lambda: self._set_resumen(msg))
            self.root.after(0, lambda: messagebox.showinfo("¡Listo!",
                f"{msg}\n\nCarpeta temporal:\n{tmp}\n\n"
                "Puedes copiar la ruta y subir manualmente los PNGs a WhatsApp como estados.\n"
                "Cierra el programa para borrar todo automáticamente."))

        self.thread_worker = threading.Thread(target=worker, daemon=True)
        self.thread_worker.start()

    def _cancelar_generacion(self):
        self._cancelar = True
        self._set_resumen("Cancelando…")

    def _refrescar_tabla(self, rows):
        self.tree.delete(*self.tree.get_children())
        for r in rows:
            mayor = r.get("precio_mayorista") or 0 or r.get("precio_final") or 0
            self.tree.insert("", tk.END, values=(
                r.get("id_producto"),
                r.get("nombre") or "",
                f"${mayor:,.0f}".replace(",", "."),
                r.get("imagen") or "",
            ))

    def _pintar_galeria(self, miniaturas, cantidad):
        # Limpiar
        for w in self.galeria.winfo_children():
            w.destroy()
        self.lbl_info_galeria.destroy() if False else None
        self.preview_imagenes.clear()
        if not miniaturas:
            tk.Label(self.galeria, text="Sin miniaturas (no se generaron imágenes).",
                     bg=COLOR_PANEL, fg=COLOR_TEXTO_SUAVE).pack(pady=30)
            return
        try:
            from PIL import ImageTk
        except Exception:
            tk.Label(self.galeria,
                     text="Miniaturas desactivadas (PIL no cargó ImageTk). Usa la carpeta.",
                     bg=COLOR_PANEL, fg=COLOR_TEXTO_SUAVE).pack(pady=30)
            return
        cols = 3
        for i, (ruta, nombre) in enumerate(miniaturas):
            frm = tk.Frame(self.galeria, bg=COLOR_PANEL)
            frm.grid(row=i // cols, column=i % cols, padx=10, pady=10)
            try:
                img = Image.open(ruta)
                ratio = min(280 / img.width, 480 / img.height, 1.0)
                img = img.resize((int(img.width * ratio), int(img.height * ratio)), Image.LANCZOS)
                tkpi = ImageTk.PhotoImage(img)
                self.preview_imagenes.append(tkpi)
                lbl = tk.Label(frm, image=tkpi, bg=COLOR_PANEL)
                lbl.pack()
            except Exception:
                tk.Label(frm, text="(sin miniatura)", bg=COLOR_PANEL, fg=COLOR_TEXTO_SUAVE).pack()
            tk.Label(frm, text=nombre[:50], bg=COLOR_PANEL, fg=COLOR_TEXTO_SUAVE,
                     font=("Segoe UI", 9)).pack(pady=(4, 0))

    # -------------------- Logica: carpeta temporal --------------------
    def _copiar_ruta_temp(self):
        if not self.carpeta_temporal_actual:
            messagebox.showwarning("No hay carpeta", "Genera primero los estados.")
            return
        self.root.clipboard_clear()
        self.root.clipboard_append(self.carpeta_temporal_actual)
        self.root.update()
        self._toast("Ruta copiada al portapapeles: " + self.carpeta_temporal_actual)

    def _abrir_carpeta_temp(self):
        if not self.carpeta_temporal_actual or not os.path.isdir(self.carpeta_temporal_actual):
            messagebox.showwarning("No hay carpeta", "Genera primero los estados.")
            return
        try:
            os.startfile(self.carpeta_temporal_actual)  # Windows
        except AttributeError:
            import subprocess
            subprocess.Popen(["xdg-open", self.carpeta_temporal_actual])
        except Exception as e:
            messagebox.showerror("No se pudo abrir", str(e))

    def _guardar_permanente(self):
        if not self.carpeta_temporal_actual:
            messagebox.showwarning("No hay nada", "Primero genera los estados.")
            return
        dest = filedialog.askdirectory(title="Guardar copia permanente en…",
                                        initialdir=BASE_DIR)
        if not dest:
            return
        import time
        sub = os.path.join(dest, f"estados_alumas_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}")
        shutil.copytree(self.carpeta_temporal_actual, sub)
        messagebox.showinfo("Guardado", f"Copia permanente en:\n{sub}")

    def _limpiar_carpeta_temp(self):
        if not self.carpeta_temporal_actual:
            return
        try:
            shutil.rmtree(self.carpeta_temporal_actual, ignore_errors=True)
        except Exception as e:
            logging.warning("No se pudo limpiar temp: %s", e)
        self.carpeta_temporal_actual = None
        self.lbl_carpeta.config(text="(limpiada)")
        for w in self.galeria.winfo_children():
            w.destroy()
        self.preview_imagenes.clear()
        tk.Label(self.galeria, text="(genera nuevos estados para ver miniaturas)",
                 bg=COLOR_PANEL, fg=COLOR_TEXTO_SUAVE).pack(pady=30)
        self._set_resumen("Carpeta temporal limpiada.")

    def _al_cerrar(self):
        if self.carpeta_temporal_actual and os.path.isdir(self.carpeta_temporal_actual):
            try:
                shutil.rmtree(self.carpeta_temporal_actual, ignore_errors=True)
            except Exception:
                pass
        try:
            self.root.destroy()
        except Exception:
            sys.exit(0)

    # -------------------- Lógica: promos --------------------
    def _cargar_promos_guardadas(self):
        self.promos_usuario = _cargar_promos_guardadas_archivo()

    def _guardar_promos(self):
        items = list(self.lst_promos.get(0, tk.END))
        if not items:
            messagebox.showwarning("Vacío", "Añade al menos una promoción.")
            return
        self.promos_usuario = items
        p = os.path.join(BASE_DIR, "promos_estados.json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump(items, f, indent=2, ensure_ascii=False)
        self._toast("Promociones guardadas.")

    def _anadir_promo(self):
        txt = simpledialog("Nueva promoción", "Texto del mensaje (emojis permitidos):", parent=self.root)
        if not txt:
            return
        self.lst_promos.insert(tk.END, txt)

    def _editar_promo(self):
        sel = self.lst_promos.curselection()
        if not sel:
            return
        cur = self.lst_promos.get(sel[0])
        txt = simpledialog("Editar promoción", "Texto:", initialvalue=cur, parent=self.root)
        if txt:
            self.lst_promos.delete(sel[0])
            self.lst_promos.insert(sel[0], txt)

    def _eliminar_promo(self):
        sel = self.lst_promos.curselection()
        if not sel:
            return
        self.lst_promos.delete(sel[0])

    def _resetear_promos(self):
        self.lst_promos.delete(0, tk.END)
        for p in PROMOS_DEFAULT:
            self.lst_promos.insert(tk.END, p)
        self.promos_usuario = list(PROMOS_DEFAULT)
        self._toast("Lista por defecto restablecida.")

    # -------------------- Utilidades misc --------------------
    def _set_resumen(self, txt):
        self.lbl_resumen.config(text=txt)

    def _toast(self, texto):
        try:
            top = tk.Toplevel(self.root)
            top.overrideredirect(True)
            top.attributes("-topmost", True)
            tk.Label(top, text=texto, bg=COLOR_ACENTO, fg="#1a1a2a",
                     font=("Segoe UI", 10, "bold"), padx=22, pady=10).pack()
            self.root.update_idletasks()
            x = self.root.winfo_rootx() + self.root.winfo_width() - top.winfo_width() - 24
            y = self.root.winfo_rooty() + 24
            top.geometry(f"+{x}+{y}")
            top.after(1800, top.destroy)
        except Exception:
            pass


def simpledialog(titulo, prompt, initialvalue="", parent=None):
    import tkinter.simpledialog as sd
    return sd.askstring(titulo, prompt, initialvalue=initialvalue, parent=parent or tk._default_root)


def main():
    root = tk.Tk()
    app = GeneradorEstadosApp(root)
    # Precargar demo
    try:
        rows = _traer_productos_bd(15, "nuevos")
        app.productos_seleccionados = rows
        app._refrescar_tabla(rows)
        app._set_resumen(f"Precargados {len(rows)} productos (Nuevos). Pulsa GENERAR.")
    except Exception as e:
        app._set_resumen(f"⚠ Sin conexión BD inicial ({str(e)[:60]})")
    root.mainloop()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        logging.critical("Fallo fatal: %s", e, exc_info=True)
        try:
            messagebox.showerror("Error Fatal", f"{e}\n\nLog: {LOG_PATH}")
        except Exception:
            print("Fallo fatal:", e)
        sys.exit(1)
