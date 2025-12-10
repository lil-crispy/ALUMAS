import os
import datetime
import time
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from webdriver_manager.chrome import ChromeDriverManager


# ---------------------------------------------
# estados.py
# Publica estados (Status/Updates) en WhatsApp Web
# por día de la semana según rutas de imágenes.
# ---------------------------------------------


# Días en español
dias = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]
hoy = dias[datetime.datetime.now().weekday()]

# Extensiones permitidas para estados
ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".jfif", ".bmp"}

def _collect_images_for_day(folder_name: str):
    base = os.path.join(os.getcwd(), "img", "estados", folder_name)
    if not os.path.isdir(base):
        return []
    files = []
    for name in os.listdir(base):
        path = os.path.join(base, name)
        if os.path.isfile(path):
            ext = os.path.splitext(name)[1].lower()
            if ext in ALLOWED_EXTENSIONS:
                files.append(os.path.abspath(path))
    files.sort()
    return files

def _build_images_by_day():
    # Mapea clave del diccionario (con acentos) a carpeta en mayúsculas sin acento
    dir_map = {
        "lunes": "LUNES",
        "martes": "MARTES",
        "miércoles": "MIERCOLES",
        "jueves": "JUEVES",
        "viernes": "VIERNES",
        "sábado": "SABADO",
        "domingo": "DOMINGO",
    }
    result = {}
    for d in dias:
        result[d] = _collect_images_for_day(dir_map[d])
    return result


# Mapea cada día a una lista de rutas de imágenes a publicar.
# EDITA ESTE DICCIONARIO con las rutas reales (absolutas o relativas).
IMAGENES_POR_DIA = _build_images_by_day()


def inicializar_navegador():
    """Inicializa Chrome con perfil persistente y opciones estables.
    Si falla la creación de la sesión, intenta sin perfil como fallback.
    """
    def crear_opciones(usar_perfil=True):
        opciones = webdriver.ChromeOptions()
        opciones.add_experimental_option("detach", True)
        # Estabilidad de arranque
        opciones.add_argument("--disable-gpu")
        opciones.add_argument("--no-default-browser-check")
        opciones.add_argument("--no-first-run")
        opciones.add_argument("--disable-dev-shm-usage")
        opciones.add_argument("--disable-extensions")
        opciones.add_argument("--remote-allow-origins=*")
        # NOTA: --no-sandbox puede ayudar en algunos entornos, pero no suele ser necesario en Windows
        # opciones.add_argument("--no-sandbox")

        if usar_perfil:
            # Usa un perfil local para no pedir QR cada vez (si ya iniciaste sesión).
            perfil_chrome = os.path.join(os.getcwd(), "chrome_profile")
            os.makedirs(perfil_chrome, exist_ok=True)
            opciones.add_argument(f"--user-data-dir={perfil_chrome}")
        return opciones

    try:
        opciones = crear_opciones(usar_perfil=True)
        driver = webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=opciones)
        driver.maximize_window()
        return driver
    except Exception as e:
        print(f"Advertencia: no se pudo iniciar Chrome con perfil persistente ({e}). Reintentando sin perfil...")
        opciones_fallback = crear_opciones(usar_perfil=False)
        driver = webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=opciones_fallback)
        driver.maximize_window()
        return driver 


def abrir_whatsapp_web(driver):
    """Abre WhatsApp Web y espera a que la interfaz principal cargue."""
    driver.get("https://web.whatsapp.com/")
    # Espera a que cargue la app (si no has escaneado QR, hazlo aquí manualmente)
    try:
        WebDriverWait(driver, 120).until(
            EC.presence_of_element_located((By.ID, "app"))
        )
    except Exception:
        # Algunas veces el contenedor principal no usa ID fijo; esperamos algo interactivo.
        WebDriverWait(driver, 120).until(
            EC.presence_of_element_located((By.XPATH, "//div[@role='application']"))
        )


def ir_a_novedades(driver):
    """Intenta abrir la vista de Novedades/Estados/Updates."""
    selectores = [
        # Aria-labels comunes
        "//div[@role='button' and contains(translate(@aria-label,'NOVEDADES','novedades'),'novedades')]",
        "//div[@role='button' and contains(translate(@aria-label,'UPDATES','updates'),'updates')]",
        "//div[@role='button' and contains(translate(@aria-label,'ESTADOS','estados'),'estados')]",
        "//div[@role='button' and @aria-label='Actualizaciones en Estados']",
        "//button[@aria-label='Actualizaciones en Estados']",
        "//*[@aria-label='Actualizaciones en Estados']",
        "//*[@aria-label='Actualizaciones en Estados']/ancestor::*[@role='button']",
        "//button[contains(translate(@aria-label,'NOVEDADES','novedades'),'novedades') or contains(translate(@aria-label,'UPDATES','updates'),'updates') or contains(translate(@aria-label,'ESTADOS','estados'),'estados') or contains(translate(@aria-label,'STATUS','status'),'status')]",
        # data-testid usado por la barra lateral en algunas versiones
        "//*[@data-testid='updates-tab']",
        "//*[@data-testid='status-tab']",
        "//*[@data-testid='updates']",
        "//*[@data-testid='status']",
        # icono legacy
        "//*[@data-icon='status']",
        # Texto visible dentro de elementos clicables
        "//div[@role='button'][.//span[contains(translate(.,'NOVEDADESUPDATES','novedadesupdates'),'novedades') or contains(translate(.,'UPDATES','updates'),'updates') or contains(translate(.,'ESTADOSSTATUS','estadosstatus'),'estados')]]",
    ]

    for xpath in selectores:
        try:
            boton = WebDriverWait(driver, 10).until(
                EC.element_to_be_clickable((By.XPATH, xpath))
            )
            boton.click()
            time.sleep(1)
            return True
        except Exception:
            continue

    print("No se pudo abrir la vista de Novedades/Estados. Ajusta los selectores si cambia la UI.")
    try:
        # Diagnóstico: listar aria-label y data-testid presentes para ayudar a ajustar selectores
        elems_aria = driver.find_elements(By.XPATH, "//*[@aria-label]")
        labels = sorted({e.get_attribute("aria-label") or "" for e in elems_aria if e.get_attribute("aria-label")})
        print(f"Aria-labels detectados ({len(labels)}): {labels[:50]}")
        elems_testid = driver.find_elements(By.XPATH, "//*[@data-testid]")
        testids = sorted({e.get_attribute("data-testid") or "" for e in elems_testid if e.get_attribute("data-testid")})
        print(f"data-testid detectados ({len(testids)}): {testids[:50]}")
    except Exception:
        pass
    return False


def subir_imagen_estado(driver, ruta_imagen):
    """Clic en 'nuevo estado' y subir imagen desde el disco."""
    # Busca botón de nuevo estado (generalmente un ícono '+') y luego input file
    # Intentamos primero encontrar un input file de estados.
    selectores_input = [
        "//input[@type='file' and contains(@accept,'image')]",
        "//input[@type='file' and contains(@accept,'video')]",
        "//input[@type='file']",
    ]
    for sx in selectores_input:
        try:
            input_file = WebDriverWait(driver, 5).until(
                EC.presence_of_element_located((By.XPATH, sx))
            )
            input_file.send_keys(os.path.abspath(ruta_imagen))
            return True
        except Exception:
            continue

    # Si no aparece, intentamos pulsar el botón de 'nuevo estado' primero
    selectores_boton_nuevo = [
        # aria-label puede variar según idioma/versión
        "//div[@role='button' and (contains(translate(@aria-label,'NUEVOA├æADIRCREAR','nuevoa├æadircrear'),'nuevo') or contains(translate(@aria-label,'ADD','add'),'add') or contains(translate(@aria-label,'CREAR','crear'),'crear') or contains(translate(@aria-label,'ESTADO','estado'),'estado') or contains(translate(@aria-label,'ACTUALIZACI├ôN','actualizaci├ôn'),'actualizaci├ôn'))]",
        "//button[contains(translate(@aria-label,'ESTADO','estado'),'estado') or contains(translate(@aria-label,'ACTUALIZACI├ôN','actualizaci├ôn'),'actualizaci├ôn')]",
        "//span[@data-icon='status-add']",
        "//*[@data-testid='status-add']",
        "//*[@data-testid='media-picker']",
        "//*[@data-testid='status-v3-upload']",
    ]
    for bx in selectores_boton_nuevo:
        try:
            boton_nuevo = WebDriverWait(driver, 8).until(
                EC.element_to_be_clickable((By.XPATH, bx))
            )
            boton_nuevo.click()
            time.sleep(1)
            # Tras abrir el menú, intenta seleccionar "Fotos y videos"
            opciones_media = [
                "//*[contains(text(),'Fotos y videos')]",
                "//*[contains(text(),'Photos and videos')]",
                "//*[@data-testid='status-v3-upload']",
            ]
            for opt in opciones_media:
                try:
                    btn_media = WebDriverWait(driver, 5).until(
                        EC.element_to_be_clickable((By.XPATH, opt))
                    )
                    btn_media.click()
                    time.sleep(0.8)
                    break
                except Exception:
                    continue
            for sx in selectores_input:
                try:
                    input_file = WebDriverWait(driver, 10).until(
                        EC.presence_of_element_located((By.XPATH, sx))
                    )
                    input_file.send_keys(os.path.abspath(ruta_imagen))
                    return True
                except Exception:
                    continue
        except Exception:
            continue

    print("No se encontró el input para subir imagen del estado. Revisa los selectores.")
    return False


def enviar_estado(driver):
    """Confirma el envío del estado (clic en Enviar/Send)."""
    posibles_enviar = ["Enviar", "Send", "Publicar", "Post"]
    for label in posibles_enviar:
        try:
            btn = WebDriverWait(driver, 10).until(
                EC.element_to_be_clickable((By.XPATH, f"//div[@role='button' and (contains(@aria-label,'{label}') or @aria-label='{label}')]"))
            )
            btn.click()
            time.sleep(2)
            return True
        except Exception:
            continue

    # Botón por texto visible
    try:
        btn2 = WebDriverWait(driver, 10).until(
            EC.element_to_be_clickable((By.XPATH, "//span[contains(text(),'Enviar') or contains(text(),'Send') or contains(text(),'Publicar') or contains(text(),'Post')]/ancestor::div[@role='button']"))
        )
        btn2.click()
        time.sleep(2)
        return True
    except Exception:
        pass

    print("No se pudo localizar el botón de enviar estado. Ajusta los selectores.")
    return False


def publicar_estados_de_hoy():
    print(f"Hoy es {hoy.upper()}\n")

    imagenes = IMAGENES_POR_DIA.get(hoy, [])
    if not imagenes:
        print("No hay imágenes configuradas para publicar hoy.")
        return

    driver = inicializar_navegador()
    try:
        abrir_whatsapp_web(driver)

        if not ir_a_novedades(driver):
            print("No se pudo acceder a la sección de estados.")
            return

        for ruta in imagenes:
            print(f"Publicando estado: {ruta}")
            if not os.path.exists(ruta):
                print(f"❌ Archivo no encontrado: {ruta}")
                continue

            if not subir_imagen_estado(driver, ruta):
                print("❌ Falló la subida del archivo. Saltando al siguiente.")
                continue

            if not enviar_estado(driver):
                print("❌ Falló el envío del estado.")
                continue

            print("✅ Estado publicado")
            time.sleep(3)

    finally:
        # Opcional: cerrar navegador
        # driver.quit()
        pass


if __name__ == "__main__":
    publicar_estados_de_hoy()