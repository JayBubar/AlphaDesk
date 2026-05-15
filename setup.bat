@echo off
echo.
echo   AlphaDesk -- Local Setup (Windows)
echo   ====================================
echo.

echo [1/3] Checking Node.js...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo   ERROR: Node.js is not installed or not in PATH.
    echo   Download from: https://nodejs.org  (LTS version)
    echo   After installing, close and reopen Command Prompt, then run setup.bat again.
    echo.
    pause
    exit /b 1
)
node --version
echo   Node.js OK

echo.
echo [2/3] Checking Python...
where python >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo   ERROR: Python not found. Download from: https://www.python.org/downloads
    echo   During install, check the box: "Add Python to PATH"
    echo   After installing, close and reopen Command Prompt, then run setup.bat again.
    echo.
    pause
    exit /b 1
)
python --version
echo   Python OK

echo.
echo [3/3] Installing dependencies...
echo.
echo   Installing Node packages...
call npm install
if %errorlevel% neq 0 (
    echo.
    echo   ERROR: npm install failed. See error above.
    pause
    exit /b 1
)
echo   Node packages OK

echo.
echo   Installing Python packages...
python -m pip install -r backend\requirements.txt
if %errorlevel% neq 0 (
    echo.
    echo   ERROR: pip install failed. See error above.
    pause
    exit /b 1
)
echo   Python packages OK

echo.
echo ============================================
echo   Setup complete! Run this next:
echo.
echo     npm run dev
echo.
echo   Then open: http://localhost:3000
echo ============================================
echo.
pause
