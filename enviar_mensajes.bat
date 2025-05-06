@echo off
cd /d C:\Users\CRISHOST\Documents\DEVS\ALUMAS
echo Compilando mensajesauto.py a EXE...
pyinstaller --onefile --noconsole mensajesauto.py

echo.
echo Ejecutando el EXE generado...
start dist\mensajesauto.exe

echo.
echo Listo. Puedes cerrar esta ventana o editar el script para recompilarlo nuevamente.
pause
