@echo off
REM Windows launcher
cd /d "%~dp0"
set "PY=.venv\Scripts\python.exe"
"%PY%" -c "import fastapi, uvicorn, httpx" >nul 2>&1
if not errorlevel 1 goto run
if not exist "%PY%" (
  echo Creating virtual environment .venv ...
  python -m venv .venv
  if errorlevel 1 goto novenv
)
echo Installing dependencies ...
"%PY%" -m pip install -r requirements.txt
if errorlevel 1 goto nodeps
:run
start "" http://127.0.0.1:8000
"%PY%" server.py %*
pause
exit /b
:novenv
echo Failed to create the virtual environment. Install Python 3.9+ from python.org and tick "Add python.exe to PATH".
pause
exit /b 1
:nodeps
echo Failed to install dependencies. Check your network connection.
pause
exit /b 1
