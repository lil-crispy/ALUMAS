import json
import os
import sys
import time
import datetime
import urllib.parse
import logging
import ctypes
import tkinter as tk
from tkinter import messagebox
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from webdriver_manager.chrome import ChromeDriverManager
from selenium.common.exceptions import TimeoutException, NoSuchElementException

# Configuración de Logging
logging.basicConfig(
    filename='envio_log.txt',
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    encoding='utf-8'
)

# Inicializar Tkinter oculto para popups
def show_info(title, message):
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    messagebox.showinfo(title, message)
    root.destroy()

def show_error(title, message):
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    messagebox.showerror(title, message)
    root.destroy()

def ask_yes_no(title, message):
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    res = messagebox.askyesno(title, message)
    root.destroy()
    return res

def setup_driver():
    """Configura el driver de Chrome con persistencia de sesión."""
    opciones = webdriver.ChromeOptions()
    
    user_data_dir = os.path.join(os.environ['LOCALAPPDATA'], 'AlumasBot', 'ChromeProfile')
    if not os.path.exists(user_data_dir):
        os.makedirs(user_data_dir)
    
    opciones.add_argument(f"user-data-dir={user_data_dir}")
    opciones.add_argument("--start-maximized")
    opciones.add_experimental_option("detach", True)
    opciones.add_argument("--log-level=3")
    
    try:
        service = Service(ChromeDriverManager().install())
        driver = webdriver.Chrome(service=service, options=opciones)
        return driver
    except Exception as e:
        logging.error(f"Error al iniciar el driver: {e}")
        show_error("Error", f"No se pudo iniciar Chrome: {e}")
        sys.exit(1)

def cargar_datos():
    """Carga los contactos y promociones desde contactos.json."""
    json_path = 'contactos.json'
    
    if getattr(sys, 'frozen', False):
        application_path = os.path.dirname(sys.executable)
        json_path = os.path.join(application_path, 'contactos.json')
    else:
        application_path = os.path.dirname(os.path.abspath(__file__))
        json_path = os.path.join(application_path, 'contactos.json')

    try:
        with open(json_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        show_error("Error", f"No se encontró el archivo contactos.json en: {json_path}")
        sys.exit(1)
    except json.JSONDecodeError as e:
        show_error("Error", f"El archivo contactos.json está dañado: {e}")
        sys.exit(1)

def obtener_semana_del_mes(dia):
    if 1 <= dia <= 8: return 1
    elif 9 <= dia <= 16: return 2
    elif 17 <= dia <= 24: return 3
    else: return 4

def esperar_inicio_sesion(driver):
    """Espera a que el usuario inicie sesión en WhatsApp Web."""
    driver.get("https://web.whatsapp.com")
    
    # Intentar detectar sesión automáticamente
    try:
        wait = WebDriverWait(driver, 60)
        wait.until(EC.presence_of_element_located((By.XPATH, '//div[@contenteditable="true"][@data-tab="3"]')))
        return True
    except TimeoutException:
        return ask_yes_no("Inicio de Sesión", "¿Ya inició sesión en WhatsApp Web (escaneó el QR)?")

def enviar_mensaje(driver, numero, mensaje_base, promocion):
    full_message = f"{mensaje_base}\n\n{promocion}"
    mensaje_encoded = urllib.parse.quote(full_message)
    url = f"https://web.whatsapp.com/send?phone={numero}&text={mensaje_encoded}"
    
    try:
        driver.get(url)
        wait = WebDriverWait(driver, 30)
        
        try:
            # Manejar alertas de alerta
            WebDriverWait(driver, 3).until(EC.alert_is_present())
            alert = driver.switch_to.alert
            alert.accept()
        except:
            pass

        input_box = wait.until(EC.presence_of_element_located((By.XPATH, '//div[@contenteditable="true"][@data-tab="10"]')))
        time.sleep(1) 
        input_box.send_keys(Keys.ENTER)
        time.sleep(3) 
        
        logging.info(f"Mensaje enviado a {numero}")
        return True
        
    except Exception as e:
        logging.error(f"Error enviando a {numero}: {e}")
        return False

def main():
    # Cargar datos
    datos = cargar_datos()
    mensajes_por_dia = datos.get("mensajes_por_dia", {})
    promociones_por_semana = datos.get("promociones_por_semana", {})
    
    dias = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]
    hoy_idx = datetime.datetime.now().weekday()
    hoy = dias[hoy_idx]
    
    if hoy not in mensajes_por_dia or not mensajes_por_dia[hoy]:
        show_info("Info", f"Hoy es {hoy.upper()} y no hay mensajes programados.")
        return

    dia_mes = datetime.datetime.now().day
    semana_actual = obtener_semana_del_mes(dia_mes)
    
    promo = promociones_por_semana.get(str(semana_actual), "")
    if not promo:
        promo = promociones_por_semana.get(semana_actual, "")
        
    lista_mensajes = mensajes_por_dia[hoy]
    
    if not ask_yes_no("Confirmar Envío", 
                      f"Hoy es {hoy.upper()}.\n\n"
                      f"Se enviarán {len(lista_mensajes)} mensajes.\n"
                      f"Promoción semana {semana_actual}: {promo[:30]}...\n\n"
                      "¿Desea continuar?"):
        return

    # Iniciar navegador
    driver = setup_driver()
    
    if not esperar_inicio_sesion(driver):
        show_error("Error", "No se pudo verificar el inicio de sesión. El programa se cerrará.")
        driver.quit()
        return
        
    enviados = 0
    errores = 0
    
    for item in lista_mensajes:
        numero = item[0]
        mensaje = item[1]
        
        if enviar_mensaje(driver, numero, mensaje, promo):
            enviados += 1
        else:
            errores += 1
        time.sleep(2)
        
    show_info("Finalizado", f"Envío completado.\n✅ Enviados: {enviados}\n❌ Errores: {errores}")

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        logging.critical(f"Error fatal: {e}")
        show_error("Error Fatal", f"Ocurrió un error inesperado: {e}")
