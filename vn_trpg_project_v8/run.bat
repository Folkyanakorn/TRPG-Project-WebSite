@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==========================================
echo      VN TRPG SYSTEM V8 - MINIMAL UI
echo ==========================================
echo.
python -m pip install -r requirements.txt
echo.
rem รอเซิร์ฟเวอร์พร้อมก่อนค่อยเปิดเบราว์เซอร์
start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:8000"
echo.
python -m uvicorn main:app --host 0.0.0.0 --port 8000
pause
