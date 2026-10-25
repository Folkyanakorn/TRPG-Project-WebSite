@echo off
chcp 65001 >nul
echo ==========================================
echo      VN TRPG SYSTEM V8 - UNIFIED UI
echo ==========================================
echo.
python -m pip install -r requirements.txt
echo.
start http://localhost:8000
echo.
python -m uvicorn main:app --host 0.0.0.0 --port 8000
pause
