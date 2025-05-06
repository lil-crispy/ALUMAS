@echo off
cd /d %~dp0

echo 📦 Compilando mensajesauto.py...
pyinstaller --onefile --noconsole mensajesauto.py

echo ✅ Compilación completada.

echo 🔁 Copiando el ejecutable al escritorio...
copy /Y "%cd%\dist\mensajesauto.exe" "%USERPROFILE%\Desktop\mensajesauto.exe"

echo 🚀 Ejecutando mensajesauto.exe...
start "" "%cd%\dist\mensajesauto.exe"

echo 🧹 Limpiando archivos temporales...
rmdir /s /q build
del mensajesauto.spec

echo ✅ Todo listo.
pause
