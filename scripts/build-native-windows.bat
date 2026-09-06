@echo off
rem Native build pipeline - Windows target.
rem
rem Builds aldo_capture_helper.exe. Locates the MSVC toolset itself via
rem vswhere when `cl` is not already on PATH, so this works from a plain
rem command prompt and from CI without hardcoding a Visual Studio edition
rem path (the previous hardcoded ...\2022\Enterprise\... path did not exist on
rem the GitHub windows-latest image, so the compile step never ran).
rem
rem Note on style: no errorlevel test appears inside a parenthesised block.
rem Batch expands %errorlevel% when it PARSES the block, not when it runs it,
rem which would silently read a stale value.

setlocal
set C_SRC=native\windows\aldo_capture_helper.c
set EXE=native\windows\aldo_capture_helper.exe

if not exist "%C_SRC%" (
  echo missing %C_SRC%
  exit /b 1
)

rem 1. Already inside a Developer Command Prompt?
where cl >nul 2>nul
if not errorlevel 1 goto :msvc

rem 2. Otherwise ask vswhere for any install carrying the x64 C++ toolset.
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" set "VSWHERE=%ProgramFiles%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" goto :try_gcc

for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSPATH=%%i"
if not defined VSPATH goto :try_gcc

echo -- using Visual Studio at "%VSPATH%" --
call "%VSPATH%\VC\Auxiliary\Build\vcvars64.bat" >nul
where cl >nul 2>nul
if not errorlevel 1 goto :msvc

:try_gcc
where gcc >nul 2>nul
if not errorlevel 1 goto :mingw

echo No MSVC ^(cl^) or MinGW ^(gcc^) toolchain found.
echo Install the "Desktop development with C++" workload, run from a Visual
echo Studio Developer Command Prompt, or install MinGW-w64.
exit /b 1

:msvc
echo -- MSVC build ^(W4 warnings-as-errors, x64^) --
rem /WX: release builds must compile warning-clean.
cl /nologo /O2 /W4 /WX %C_SRC% /Fe:%EXE% ws2_32.lib user32.lib
if errorlevel 1 exit /b 1
echo built %EXE%
exit /b 0

:mingw
echo -- MinGW build ^(Wall warnings-as-errors^) --
gcc -O2 -Wall -Werror -o %EXE% %C_SRC% -lws2_32 -luser32
if errorlevel 1 exit /b 1
echo built %EXE%
exit /b 0
