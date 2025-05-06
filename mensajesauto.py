from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
import urllib.parse
import time

# Ruta del chromedriver
ruta_driver = r"C:\Users\CRISHOST\Documents\DEVS\ALUMAS\chromedriver-win64\chromedriver-win64\chromedriver.exe"
opciones = webdriver.ChromeOptions()
opciones.add_experimental_option("detach", True)  # Mantener la ventana abierta

driver = webdriver.Chrome(service=Service(ruta_driver), options=opciones)

# Lista de números y mensajes
contactos = [
    ("573227329097", "Hola Cristian, ¿cómo estás? ¿Estás necesitando algo para el día de hoy?"),
    ("573132484404", "Hola, ¿cómo te va? ¿Tienes algún requerimiento para hoy?"),
    ("573118203930", "¡hola pa")
]

# Función para enviar mensaje a cada contacto
def enviar_mensaje(numero, mensaje):
    try:
        mensaje_encoded = urllib.parse.quote(mensaje)
        url = f"https://web.whatsapp.com/send?phone={numero}&text={mensaje_encoded}"
        driver.get(url)

        print(f"Abriendo WhatsApp Web para el número: {numero}...")

        # Esperar hasta que el campo de texto esté disponible
        input_xpath = '//div[@contenteditable="true"][@data-tab="10"]'
        input_box = WebDriverWait(driver, 60).until(
            EC.presence_of_element_located((By.XPATH, input_xpath))
        )

        time.sleep(2)  # Espera adicional por seguridad
        input_box.send_keys(Keys.ENTER)

        print(f"✅ Mensaje enviado con éxito al número: {numero}.")
    except Exception as e:
        print(f"❌ Error al enviar mensaje al número {numero}: {e}")

# Enviar mensaje a cada contacto
for numero, mensaje in contactos:
    enviar_mensaje(numero, mensaje)
