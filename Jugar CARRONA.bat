@echo off
rem Lanzador de CARRONA: levanta un servidor local y abre el juego en modo app.
rem No hace falta Python ni nada: usa PowerShell 5.1, que viene con Windows 10/11
rem (ver launcher\carrona.ps1). La ventana negra se cierra sola al instante.
cd /d "%~dp0"
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0launcher\carrona.ps1"
