from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from webdriver_manager.chrome import ChromeDriverManager
import urllib.parse
import datetime
import time

# Configurar navegador
opciones = webdriver.ChromeOptions()
opciones.add_experimental_option("detach", True)
driver = webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=opciones)

# Obtener día actual en español
dias = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]
hoy = dias[datetime.datetime.now().weekday()]
print(f"Hoy es {hoy.upper()}")

# Diccionario de contactos por día
mensajes_por_dia = {
    "lunes": [
        ("573000000001", "¡Feliz lunes! ¿Necesitas algo hoy?")
    ],
    "martes": [
        ("573227329097", "Hola Cristian, ¿cómo estás? ¿Estás necesitando algo para el día de hoy?"),
        ("573132484404", "Hola, ¿cómo te va? ¿Tienes algún requerimiento para hoy?")
    ],
    "miércoles": [
        ("573000000002", "¡Mitad de semana! ¿Te ayudo en algo?")
    ],
    "jueves": [],
    "viernes": [],
    "sábado": [],
    "domingo": []
}

# Función para enviar mensaje
def enviar_mensaje(numero, mensaje):
    try:
        mensaje_encoded = urllib.parse.quote(mensaje)
        url = f"https://web.whatsapp.com/send?phone={numero}&text={mensaje_encoded}"
        driver.get(url)
        print(f"Abriendo WhatsApp Web para el número: {numero}...")

        input_xpath = '//div[@contenteditable="true"][@data-tab="10"]'
        input_box = WebDriverWait(driver, 60).until(
            EC.presence_of_element_located((By.XPATH, input_xpath))
        )

        time.sleep(2)
        input_box.send_keys(Keys.ENTER)
        print(f"✅ Mensaje enviado con éxito al número: {numero}.")

        time.sleep(10)  # Pausa para permitir que se envíe el mensaje antes de ir al siguiente

    except Exception as e:
        print(f"❌ Error al enviar mensaje al número {numero}: {e}")

# Enviar mensajes solo si hay programados para hoy
if mensajes_por_dia[hoy]:
    for numero, mensaje in mensajes_por_dia[hoy]:
        enviar_mensaje(numero, mensaje)
else:
    print("No hay mensajes programados para hoy.")
