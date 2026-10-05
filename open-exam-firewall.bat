@echo off
REM ============================================================================
REM  Abasyn Exam Server — open the firewall so the phone SCANNER can reach the
REM  backend on ANY WiFi (not just at home).
REM
REM  Run this ONCE:  right-click this file  ->  "Run as administrator".
REM  After that the scanner works on every network you connect the laptop to.
REM ============================================================================

echo Opening TCP port 5000 for the exam scanner on all network profiles...

netsh advfirewall firewall delete rule name="Abasyn Exam Server 5000" >nul 2>&1
netsh advfirewall firewall add rule name="Abasyn Exam Server 5000" dir=in action=allow protocol=TCP localport=5000 profile=any

if %errorlevel%==0 (
  echo.
  echo  DONE. Port 5000 is now open for the scanner on Home, Work AND Public WiFi.
) else (
  echo.
  echo  FAILED. Please run this file as Administrator ^(right-click -^> Run as administrator^).
)
echo.
pause
