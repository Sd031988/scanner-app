@echo off
setlocal
set PORT=8123
where python >nul 2>nul
if errorlevel 1 (
  echo Python nicht gefunden. Alternative: npx serve -l %PORT%
  exit /b 1
)
cd /d "%~dp0"
start "" "http://localhost:%PORT%"
python -m http.server %PORT%
