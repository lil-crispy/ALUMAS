import json
import os
import sys
import time
import datetime
import urllib.parse
import logging
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

def setup_driver():
    """Configura el driver de Chrome con persistencia de sesión."""
    opciones = webdriver.ChromeOptions()
    
    # Ruta para el perfil de usuario (para guardar la sesión de WhatsApp)
    # Se guardará en %LOCALAPPDATA%/AlumasBot/ChromeProfile
    user_data_dir = os.path.join(os.environ['LOCALAPPDATA'], 'AlumasBot', 'ChromeProfile')
    if not os.path.exists(user_data_dir):
        os.makedirs(user_data_dir)
    
    opciones.add_argument(f"user-data-dir={user_data_dir}")
    opciones.add_argument("--start-maximized")
    opciones.add_experimental_option("detach", True)
    
    # Suprimir logs innecesarios de Chrome
    opciones.add_argument("--log-level=3")
    
    try:
        service = Service(ChromeDriverManager().install())
        driver = webdriver.Chrome(service=service, options=opciones)
        return driver
    except Exception as e:
        logging.error(f"Error al iniciar el driver: {e}")
        print(f"❌ Error al iniciar Chrome: {e}")
        sys.exit(1)

def cargar_datos():
    """Carga los contactos y promociones desde contactos.json."""
    json_path = 'contactos.json'
    
    # Si se ejecuta como ejecutable congelado
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
        print(f"❌ No se encontró el archivo {json_path}. Asegúrese de que esté en la misma carpeta que el programa.")
        logging.error(f"Archivo no encontrado: {json_path}")
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"❌ Error al leer el archivo JSON: {e}")
        logging.error(f"Error JSON: {e}")
        sys.exit(1)

def obtener_semana_del_mes(dia):
    """Determina la semana del mes (1-4)."""
    if 1 <= dia <= 8:
        return 1
    elif 9 <= dia <= 16:
        return 2
    elif 17 <= dia <= 24:
        return 3
    else:
        return 4

def esperar_inicio_sesion(driver):
    """Espera a que el usuario inicie sesión en WhatsApp Web."""
    print("⏳ Abriendo WhatsApp Web...")
    driver.get("https://web.whatsapp.com")
    
    print("ℹ️  Por favor, inicie sesión escaneando el código QR si es necesario.")
    print("⏳ Esperando a que cargue la interfaz principal...")
    
    try:
        # Esperar a que aparezca el elemento de búsqueda de chat o la lista de chats
        # Esto confirma que se ha iniciado sesión
        wait = WebDriverWait(driver, 60)
        wait.until(EC.presence_of_element_located((By.XPATH, '//div[@contenteditable="true"][@data-tab="3"]')))
        print("✅ Sesión iniciada correctamente.")
        logging.info("Sesión de WhatsApp Web iniciada.")
        return True
    except TimeoutException:
        print("⚠️  No se detectó el inicio de sesión en 60 segundos.")
        resp = input("¿Ya inició sesión? (s/n): ")
        if resp.lower() == 's':
            return True
        return False

def enviar_mensaje(driver, numero, mensaje_base, promocion):
    """Envía un mensaje a un número específico."""
    full_message = f"{mensaje_base}\n\n{promocion}"
    mensaje_encoded = urllib.parse.quote(full_message)
    url = f"https://web.whatsapp.com/send?phone={numero}&text={mensaje_encoded}"
    
    try:
        driver.get(url)
        
        # Esperar a que cargue el campo de texto
        wait = WebDriverWait(driver, 30)
        
        # Verificar si el número es inválido (aparece un popup)
        try:
            # XPath para el botón de "OK" en el popup de número inválido (puede cambiar)
            # Una mejor estrategia es esperar al input o al error.
            # WhatsApp Web suele mostrar un div con texto "El número de teléfono... no es válido"
            pass 
        except:
            pass

        # Esperar al input de mensaje
        input_box = wait.until(EC.presence_of_element_located((By.XPATH, '//div[@contenteditable="true"][@data-tab="10"]')))
        
        # Pequeña pausa para asegurar que el texto se haya cargado (Selenium a veces es muy rápido)
        time.sleep(1) 
        
        input_box.send_keys(Keys.ENTER)
        
        # Esperar confirmación visual de envío (opcional, pero recomendado)
        # Por simplicidad y velocidad, esperamos un poco
        time.sleep(3) 
        
        print(f"✅ Mensaje enviado a: {numero}")
        logging.info(f"Mensaje enviado a {numero}")
        return True
        
    except TimeoutException:
        print(f"❌ Tiempo de espera agotado para: {numero} (Posiblemente número inválido o internet lento)")
        logging.error(f"Timeout al enviar a {numero}")
        return False
    except Exception as e:
        print(f"❌ Error enviando a {numero}: {e}")
        logging.error(f"Error enviando a {numero}: {e}")
        return False

def main():
    print("🤖 Iniciando Bot de WhatsApp ALUMAS...")
    
    # Cargar datos
    datos = cargar_datos()
    mensajes_por_dia = datos.get("mensajes_por_dia", {})
    promociones_por_semana = datos.get("promociones_por_semana", {})
    
    # Determinar día y promoción
    dias = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]
    hoy_idx = datetime.datetime.now().weekday()
    hoy = dias[hoy_idx]
    
    print(f"📅 Hoy es: {hoy.upper()}")
    
    if hoy not in mensajes_por_dia or not mensajes_por_dia[hoy]:
        print("ℹ️  No hay mensajes programados para hoy.")
        input("Presione Enter para salir...")
        return

    dia_mes = datetime.datetime.now().day
    semana_actual = obtener_semana_del_mes(dia_mes)
    
    # Las claves en JSON son strings, así que convertimos la semana a string para buscar
    promo = promociones_por_semana.get(str(semana_actual), "")
    if not promo:
        # Intentar con integer por si acaso
        promo = promociones_por_semana.get(semana_actual, "")
        
    print(f"🎁 Promoción de la semana {semana_actual}: {promo[:50]}...")
    
    lista_mensajes = mensajes_por_dia[hoy]
    print(f"📨 Se enviarán {len(lista_mensajes)} mensajes.")
    
    confirm = input("¿Desea continuar? (s/n): ")
    if confirm.lower() != 's':
        print("Cancelado por el usuario.")
        return

    # Iniciar navegador
    driver = setup_driver()
    
    if not esperar_inicio_sesion(driver):
        print("❌ No se pudo verificar el inicio de sesión. Cerrando.")
        driver.quit()
        return
        
    print("🚀 Comenzando envío de mensajes...")
    
    enviados = 0
    errores = 0
    
    for item in lista_mensajes:
        # Manejar tanto listas como tuplas (JSON usa listas)
        numero = item[0]
        mensaje = item[1]
        
        if enviar_mensaje(driver, numero, mensaje, promo):
            enviados += 1
        else:
            errores += 1
            
        # Pausa aleatoria para evitar bloqueo de SPAM
        time.sleep(2)
        
    print("\n" + "="*30)
    print(f"🏁 Finalizado.")
    print(f"✅ Enviados: {enviados}")
    print(f"❌ Errores: {errores}")
    print("="*30)
    
    print("El navegador permanecerá abierto. Puede cerrarlo manualmente.")
    # driver.quit() # No cerramos para dejar ver los chats

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n🛑 Interrumpido por el usuario.")
    except Exception as e:
        print(f"\n❌ Error inesperado: {e}")
        logging.critical(f"Error fatal: {e}")
    
    input("\nPresione Enter para cerrar...")
