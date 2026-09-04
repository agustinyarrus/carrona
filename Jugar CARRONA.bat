@echo off
rem Lanzador de CARRONA: levanta un servidor local y abre el juego en el navegador.
cd /d "%~dp0"
start "CARRONA" /min python serve.py 8765
