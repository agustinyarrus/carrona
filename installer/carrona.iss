; ─────────────────────────────────────────────────────────────────────────────
;  carrona.iss — Instalador de CARRONA para Windows (Inno Setup 6).
;  Primero `node tools/build.mjs` (arma dist\ y genera version.iss), después:
;    ISCC.exe installer\carrona.iss
;  Sale dist\CARRONA-Setup-x.y.z.exe. Instala por usuario (sin UAC) en
;  %LOCALAPPDATA%\Programs\CARRONA y crea accesos directos que ejecutan el
;  lanzador con el PowerShell 5.1 que viene con Windows. Sin dependencias.
; ─────────────────────────────────────────────────────────────────────────────

#include "version.iss"

#define PS "{sys}\WindowsPowerShell\v1.0\powershell.exe"
#define PSArgs "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\launcher\carrona.ps1"""

[Setup]
AppId={{7D1C9C2E-3B4F-4A5E-9F6B-2C8E1A0D5F37}
AppName=CARRONA
AppVersion={#AppVersion}
AppVerName=CARRONA {#AppVersion}
AppPublisher=CARRONA
DefaultDirName={localappdata}\Programs\CARRONA
DefaultGroupName=CARRONA
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
MinVersion=10.0
OutputDir=..\dist
OutputBaseFilename=CARRONA-Setup-{#AppVersion}
SetupIconFile=..\icons\carrona.ico
UninstallDisplayIcon={app}\icons\carrona.ico
UninstallDisplayName=CARRONA
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ShowLanguageDialog=no

[Languages]
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "..\dist\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion; Excludes: "*.zip"

[Icons]
Name: "{group}\CARRONA"; Filename: "{#PS}"; Parameters: "{#PSArgs}"; WorkingDir: "{app}"; IconFilename: "{app}\icons\carrona.ico"; Comment: "Jugar CARRONA"
Name: "{group}\Desinstalar CARRONA"; Filename: "{uninstallexe}"
Name: "{autodesktop}\CARRONA"; Filename: "{#PS}"; Parameters: "{#PSArgs}"; WorkingDir: "{app}"; IconFilename: "{app}\icons\carrona.ico"; Comment: "Jugar CARRONA"; Tasks: desktopicon

[Run]
Filename: "{#PS}"; Parameters: "{#PSArgs}"; WorkingDir: "{app}"; Description: "Jugar ahora"; Flags: postinstall nowait skipifsilent

[UninstallDelete]
; perfil del navegador, log del lanzador y datos guardados del juego
Type: filesandordirs; Name: "{localappdata}\CARRONA"
