@echo off
rem Launch Nostalgia TV (development launcher - runs straight from source).
rem
rem The bare electron.exe is only a runtime: it needs this project folder as an
rem argument, or it opens an empty shell. This wrapper supplies it so the app
rem can be started by double-clicking instead of from a terminal.
rem
rem This file MUST keep CRLF line endings. With LF only, cmd.exe misparses it
rem and reports errors like "m is not recognized" even though it still runs.

cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo Electron is not installed. Run this first, then try again:
  echo     node node_modules\electron\install.js
  pause
  exit /b 1
)

rem start "" hands off so this console closes instead of sitting behind the app.
start "" "node_modules\electron\dist\electron.exe" "."
