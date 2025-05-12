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

("573112258058", "Señora Yolanda, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios la bendiga siempre."),
("573193874612", "Señor Cristian, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573124484576", "Señor William, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573115000789", "Señor Gilio, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573167959929", "Señora Adiela, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios la bendiga siempre."),
("573112592797", "Señor Rodolfo, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre...."),
("573114586322", "Señor William, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre...."),
("573115975461", "Señor Fausto, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre...."),
("573164980202", "Señora Martha, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios la bendiga siempre."),
("573212935835", "Señor Andres, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre...."),
("573132075661", "Señor Hugo, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre...."),
("573168351271", "Señora Yanira, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios la bendiga siempre."),
("573124780676", "Don Oscar, muy buenas tardes. como esta espero este muy bien estoy estoy a su dispocicion si necesita cualquier cosa Dios lo bendiga ."),
("573138063069", "Caballero, muy buenas tardes. espero que este bien tengo tuberia y accesorios de cortina economicos por si necesiya me avisa ."),
("573112638688", "Señor Rubén, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre...."),
("573112216225", "Señor Rafael, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573118887666", "Señor Julio, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573124528334", "Señor Edilberto, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573112184554", "Señora Andrea, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios la bendiga siempre."),
("573007690508", "Señor Andrés, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573142630122", "Señora Deysi, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios la bendiga siempre."),
("573002991190", "Señor Gabriel, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573113740708", "Señor Deimer, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573123851530", "Señor Plinio, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573203183782", "Señora Adriana, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios la bendiga siempre."),
("573112908255", "Señor Sergio, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573125824523", "Señor Ricardo, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573222556800", "Señora Crisanta, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios la bendiga siempre."),
("573114417748", "Señor José Alberto, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573112287852", "Señor Marcos, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573215278055", "Señor Fredy, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573132782185", "Como vamos costeño feliz Dia papi me avisas si necesitas algo cualquier cosa estoy para servirte , Dios te bendiga papi"),
("573136217536", "Señor José, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573115018363", "Señor Jorge, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573103585957", "Señora Martha, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios la bendiga siempre."),
("573115061675", "Señora Margarita, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios la bendiga siempre."),
("573024014412", "Señora Yenny, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios la bendiga siempre."),
("573134673063", "Que hace quinerito feliz inicio de semana , papi. me avisa si esta neceistando merca ! Dios lo bendiga siempre. saludes al niño"),
("573143070843", "Señor Cesar Barrera, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573177175944", "Señor Miguel Sepulveda, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573212687595", "Señora Yaneth, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios la bendiga siempre."),
("573123193647", "Señora Olga, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios la bendiga siempre."),
("573112803865", "Señora Maribel, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios la bendiga siempre."),
("573014371159", "Duro, muy buenas Dias.Duro por hay tengo tees y win tardcional ya lo extrañamos aca me avisa y le envio usted sabe Dios lo bendiga siempre."),
("573112908255", "Señor Sergio Hurtado, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573222641914", "Señor Edison, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573142150164", "Mi amigo Giovany, muy buenas Dias. Estoy pendiente cualquier mercancia que neceiste siempre para servire me avisa tengo niples de ducha si necesita o todo lo de tuberia , estoy pendiente Dios lo bendiga"),
("573168522927", "Señor Juan, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573203730845", "Señor Luis, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573142281013", "Señor Gilberto Pineda, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573163775079", "Señora Luz , muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios la bendiga siempre."),
("573112115951", "Señor Hugo, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573107548083", "Señora Patricia, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios la bendiga siempre."),
("573223043864", "Señor Olmedo Beltrán, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573186280648", "Don baudelino , muy buenas tardes. espero se encunetre muy bien , don baudelino queria saber si necesitaba algo para esta semana estoy para servirle Dios lo bendiga don baudelino ."),

        ],


    "martes": [
        ("573227329097", "Hola Cristian, ¿cómo estás? ¿Estás necesitando algo para el día de hoy?"),
        ("573132484404", "Hola, ¿cómo te va? ¿Tienes algún requerimiento para hoy?")
    ],
    "miércoles": [
        ("573000000002", "¡Mitad de semana! ¿Te ayudo en algo?")
    ],
"jueves": [

    ("573124932864", "Señor Emeterio, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
    ("573108088152", "Señor Jose, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
    ("573172426430", "Señor Eduardo, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
    ("573204608746", "Señor Arturo, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
    ("573043841119", "Señora Gloria, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios la bendiga siempre."),
    ("573004032319", "Señor Fernando, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
    ("573177484404", "Señora Nubia, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios la bendiga siempre."),
    ("573132781462", "Señor Pedronel, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
    ("573213747704", "Muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
    ("573057707673", "Señor Rodolfo, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
    ("573125153393", "Muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
    ("573112428907", "Señor Camilo, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
    ("573108115957", "Señora Martha, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios la bendiga siempre."),
    ("573202345541", "Señor Diego, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
    ("573114750223", "Señor Diego, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
    ("573209259312", "Hola Buenos Dias señora carolina espero se encuentre muy bien de parte de Alumas queria saber si necesitaba reforzar tee para lavadero tengo precio economico estoy pendiente cualquier cosa , Dios la bendiga,Feliz Dia "),
    ("573125660379", "Señor Alonso, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
    ("573142044388", "Muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573102219717", "Señor Luis, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573168433968", "Señora Laura, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios la bendiga siempre."),
("573123143365", "Señora Maria, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios la bendiga siempre."),
("573132868358", "Señor Jose, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573196758011", "Señor Gregorio, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573143246824", "Señor Ernesto, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573002388825", "Señor Cristian, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573112472789", "Señor Yecid, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573052452957", "Señora Adriana, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios la bendiga siempre."),
("573057632439", "Señor Andres, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573203106473", "Señor Pedronel, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573227072052", "Señor Daniel, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573164499734", "Señora Victoria, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios la bendiga siempre."),
("573172162137", "Señor Pablo, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573123002442", "Muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573173143056", "Señor Edwin, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573105832999", "Señor Henry, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573108786274", "Señora Martha, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios la bendiga siempre."),
("573017196581", "Señora Liana, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios la bendiga siempre."),
("573124823696", "Señor Jhon, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573114688653", "Muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573142002388", "Señora Sandra, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios la bendiga siempre."),
("573202771711", "Señor Javier, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573195173722", "Señor José, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573132924402", "Muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573134266617", "Señor Ovidio, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573223047675", "Muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573138352174", "Muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573204401823", "Muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573168714018", "Señor Jorge, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. queria saber si necesiba algo de Tee para lavadero esta semana entrega inmediata , no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573132562501", "Muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573223648486", "Señora Tatiana, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios la bendiga siempre."),
("573103524823", "Muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573223708997", "Muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573122541198", "Muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573193111176", "Muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573012900733", "Muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
("573219158649", "Señor Julian, muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. Solo queríamos recordarle que estamos a su disposición para lo que necesite. Si requiere algún producto o mercancía, no dude en escribirnos. ¡Con mucho gusto le atendemos! Dios lo bendiga siempre..."),
       
    ],
    "viernes": [],
     "sábado": [],
    "domingo": []
}

def enviar_mensaje(numero, mensaje):
    try:
        mensaje_encoded = urllib.parse.quote(mensaje)
        url = f"https://web.whatsapp.com/send?phone={numero}&text={mensaje_encoded}"
        driver.get(url)
        print(f"Abriendo WhatsApp Web para el número: {numero}...")

        # Esperar hasta que la caja de texto esté disponible
        input_xpath = '//div[@contenteditable="true"][@data-tab="10"]'
        wait = WebDriverWait(driver, 60)
        input_element = wait.until(EC.presence_of_element_located((By.XPATH, input_xpath)))

        # Asegurarse de que la caja de texto esté disponible y lista para recibir el mensaje
        input_element.send_keys(Keys.ENTER)

        print(f"✅ Mensaje enviado con éxito al número: {numero}.")
        time.sleep(5)  # Pausa para permitir que se envíe el mensaje antes de ir al siguiente

    except Exception as e:
        print(f"❌ Error al enviar mensaje al número {numero}: {e}")

# Enviar mensajes solo si hay programados para hoy
if hoy in mensajes_por_dia and mensajes_por_dia[hoy]:
    for item in mensajes_por_dia[hoy]:
        numero, mensaje = item  # Desempaquetar la tupla
        enviar_mensaje(numero, mensaje)
else:
    print("No hay mensajes programados para hoy.")

# Cerrar el navegador al terminar (opcional)
driver.quit()