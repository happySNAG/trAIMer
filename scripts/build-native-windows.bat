@echo off
rem Native build pipeline - Windows target (Pass 5).
rem Builds aldo_capture_helper.exe with MSVC (Developer Prompt) or MinGW.

setlocal
set C_SRC=native\windows\aldo_capture_helper.c
set EXE=native\windows\aldo_capture_helper.exe

if not exist "%C_SRC%" (
  echo missing %C_SRC%
  exit /b 1
)

where cl >nul 2>nul
if %errorlevel%==0 (
  echo -- MSVC build ^(W4 warnings-as-errors^) --
  rem /WX: release builds must compile warning-clean (Pass 6 requirement 1).
  cl /O2 /W4 /WX %C_SRC% /Fe:%EXE% ws2_32.lib user32.lib
  if errorlevel 1 exit /b 1
  echo built %EXE%
  exit /b 0
)

where gcc >nul 2>nul
if %errorlevel%==0 (
  echo -- MinGW build ^(Wall warnings-as-errors^) --
  gcc -O2 -Wall -Werror -o %EXE% %C_SRC% -lws2_32 -luser32
  if errorlevel 1 exit /b 1
  echo built %EXE%
  exit /b 0
)

echo No MSVC ^(cl^) or MinGW ^(gcc^) toolchain found.
echo Run from a Visual Studio Developer Command Prompt, or install MinGW-w64.
exit /b 1
