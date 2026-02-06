@echo off
setlocal enabledelayedexpansion
cd /d %~dp0

echo 🧹 Limpiando compilaciones anteriores...
if exist build rmdir /s /q build
if exist dist rmdir /s /q dist

echo 📦 Compilando Bot (mensajesauto.py)...
pyinstaller --onefile --noconsole mensajesauto.py
if errorlevel 1 (
    echo ❌ Error compilando mensajesauto.py
    pause
    exit /b
)

echo 📦 Compilando Editor (editor_mensajes.py)...
pyinstaller --onefile --noconsole editor_mensajes.py
if errorlevel 1 (
    echo ❌ Error compilando editor_mensajes.py
    pause
    exit /b
)

echo ✅ Compilación completada.

REM --- Detectar Escritorio ---
set "DESKTOP_PATH=%USERPROFILE%\Desktop"
if exist "%USERPROFILE%\OneDrive\Escritorio" (
    set "DESKTOP_PATH=%USERPROFILE%\OneDrive\Escritorio"
) else if exist "%USERPROFILE%\OneDrive\Desktop" (
    set "DESKTOP_PATH=%USERPROFILE%\OneDrive\Desktop"
) else if exist "%USERPROFILE%\Escritorio" (
    set "DESKTOP_PATH=%USERPROFILE%\Escritorio"
)

echo 📂 Carpeta de Escritorio detectada: "!DESKTOP_PATH!"

echo 🔁 Copiando los ejecutables y datos al escritorio...

if not exist "%cd%\dist\mensajesauto.exe" (
    echo ❌ No se encontró dist\mensajesauto.exe
) else (
    copy /Y "%cd%\dist\mensajesauto.exe" "!DESKTOP_PATH!\mensajesauto.exe"
)

if not exist "%cd%\dist\editor_mensajes.exe" (
    echo ❌ No se encontró dist\editor_mensajes.exe
) else (
    copy /Y "%cd%\dist\editor_mensajes.exe" "!DESKTOP_PATH!\editor_mensajes.exe"
)

copy /Y "%cd%\contactos.json" "!DESKTOP_PATH!\contactos.json"

echo 🚀 Abriendo el Editor...
if exist "!DESKTOP_PATH!\editor_mensajes.exe" (
    start "" "!DESKTOP_PATH!\editor_mensajes.exe"
) else (
    echo ❌ No se puede iniciar el editor porque no se encontró en: "!DESKTOP_PATH!\editor_mensajes.exe"
)

echo 🧹 Limpiando archivos temporales...
if exist build rmdir /s /q build
if exist mensajesauto.spec del mensajesauto.spec
if exist editor_mensajes.spec del editor_mensajes.spec

echo ✅ Todo listo.
pause
