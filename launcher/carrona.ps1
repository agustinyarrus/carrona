# ─────────────────────────────────────────────────────────────────────────────
#  carrona.ps1 — Lanzador de CARRONA para Windows, sin dependencias.
#
#  Los módulos ES no cargan desde file://, así que hace falta un servidor. Este
#  script levanta uno mínimo con System.Net.HttpListener (.NET Framework, viene
#  con Windows) en http://localhost:8765/, sirve la carpeta del juego, abre Edge
#  o Chrome en modo app con un perfil propio y, cuando esa ventana se cierra,
#  apaga el servidor y termina.
#
#  Se invoca desde "Jugar CARRONA.bat" o desde el acceso directo del instalador:
#    powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File carrona.ps1
#
#  Está escrito para PowerShell 5.1 (el que trae Windows 10/11): nada de `??`,
#  ternarios ni -Parallel. Registra lo que hace en %LOCALAPPDATA%\CARRONA\launcher.log.
#  El archivo se guarda en UTF-8 con BOM: sin BOM, 5.1 lo lee como ANSI.
# ─────────────────────────────────────────────────────────────────────────────

$ProgressPreference = 'SilentlyContinue'
$BasePort = 8765
$MaxPort = 8775
$Root = Split-Path $PSScriptRoot -Parent            # la carpeta del juego = padre de launcher\
$RootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
$DataDir = Join-Path $env:LOCALAPPDATA 'CARRONA'
$ProfileDir = Join-Path $DataDir 'profile'          # perfil propio del navegador (ver Open-Game)
$LogFile = Join-Path $DataDir 'launcher.log'

# ── log ──────────────────────────────────────────────────────────────────────
try {
  if (-not (Test-Path -LiteralPath $DataDir)) { New-Item -ItemType Directory -Path $DataDir | Out-Null }
  # el log guarda sólo los últimos arranques: si pasa de 200 KB se recortan las líneas viejas
  if ((Test-Path -LiteralPath $LogFile) -and ((Get-Item -LiteralPath $LogFile).Length -gt 200KB)) {
    $tail = Get-Content -LiteralPath $LogFile -Tail 300
    Set-Content -LiteralPath $LogFile -Value $tail -Encoding UTF8
  }
} catch { }

function Write-Log([string]$msg) {
  try { Add-Content -LiteralPath $LogFile -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg) -Encoding UTF8 } catch { }
}

Write-Log "── arranque · carpeta del juego: $Root"
if (-not [System.Net.HttpListener]::IsSupported) { Write-Log 'este Windows no tiene HttpListener (http.sys) · fin'; exit 1 }

# ── versión (para /__carrona): la meta que inyecta el build, o package.json en el repo ──
$Version = 'dev'
try {
  $indexPath = Join-Path $Root 'index.html'
  if (Test-Path -LiteralPath $indexPath) {
    $m = [regex]::Match([IO.File]::ReadAllText($indexPath), 'name="carrona-build"\s+content="([^"]+)"')
    if ($m.Success) { $Version = $m.Groups[1].Value }
  }
  $pkgPath = Join-Path $Root 'package.json'
  if ($Version -eq 'dev' -and (Test-Path -LiteralPath $pkgPath)) {
    $m = [regex]::Match([IO.File]::ReadAllText($pkgPath), '"version"\s*:\s*"([^"]+)"')
    if ($m.Success) { $Version = $m.Groups[1].Value }
  }
} catch { }

# ── tipos MIME: .js tiene que ser text/javascript o el navegador bloquea los módulos ──
$Mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.js' = 'text/javascript'
  '.mjs' = 'text/javascript'
  '.css' = 'text/css; charset=utf-8'
  '.json' = 'application/json'
  '.webmanifest' = 'application/manifest+json'
  '.png' = 'image/png'
  '.ico' = 'image/x-icon'
  '.svg' = 'image/svg+xml'
  '.txt' = 'text/plain; charset=utf-8'
  '.md' = 'text/markdown; charset=utf-8'
}

# ── ¿ya hay un CARRONA sirviendo en este puerto? (doble clic dos veces, o serve.py de desarrollo) ──
function Test-CarronaServer([int]$port) {
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:$port/__carrona" -TimeoutSec 2 -UseBasicParsing
    return ($r.StatusCode -eq 200 -and $r.Content -match '"app"\s*:\s*"carrona"')
  } catch { return $false }
}

# ── navegador: Edge o Chrome por App Paths del registro (HKLM, HKCU, WOW6432Node) o rutas típicas ──
function Find-Browser {
  $keys = @(
    'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\',
    'Registry::HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\',
    'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\'
  )
  foreach ($exe in @('msedge.exe', 'chrome.exe')) {
    foreach ($k in $keys) {
      try {
        $exePath = (Get-ItemProperty -LiteralPath ($k + $exe) -ErrorAction SilentlyContinue).'(default)'
        if ($exePath) {
          $exePath = $exePath.Trim('"')
          if (Test-Path -LiteralPath $exePath) { return $exePath }
        }
      } catch { }
    }
  }
  # sin entrada en el registro: las carpetas donde suelen estar
  $bases = @()
  foreach ($b in @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA)) { if ($b) { $bases += $b } }
  foreach ($rel in @('Microsoft\Edge\Application\msedge.exe', 'Google\Chrome\Application\chrome.exe')) {
    foreach ($b in $bases) {
      $c = Join-Path $b $rel
      if (Test-Path -LiteralPath $c) { return $c }
    }
  }
  return $null
}

# Abre el juego. Con Edge/Chrome usa modo app y un perfil propio: sin --user-data-dir el
# navegador delega en el proceso ya abierto y no hay manera de saber cuándo se cierra la
# ventana. Devuelve el proceso, o $null si se abrió el navegador predeterminado (una pestaña).
function Open-Game([string]$url) {
  $exe = Find-Browser
  if ($exe) {
    if (-not (Test-Path -LiteralPath $ProfileDir)) { New-Item -ItemType Directory -Path $ProfileDir | Out-Null }
    $argv = @(
      "--app=$url",
      "--user-data-dir=`"$ProfileDir`"",
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=msEdgeFirstRunExperience',
      '--window-size=1600,900'
    )
    Write-Log "navegador: $exe"
    return (Start-Process -FilePath $exe -ArgumentList $argv -PassThru)
  }
  Write-Log 'sin Edge ni Chrome: se abre el navegador predeterminado en una pestaña'
  Start-Process $url | Out-Null
  return $null
}

# ── elegir puerto y levantar el listener ─────────────────────────────────────
# Sin permisos de administrador HttpListener sólo acepta el prefijo http://localhost:PUERTO/
# (127.0.0.1, + o * dan "Acceso denegado"), por eso el origen del juego es siempre localhost.
$listener = $null
$Port = 0
for ($p = $BasePort; $p -le $MaxPort; $p++) {
  if (Test-CarronaServer $p) {
    Write-Log "ya hay un CARRONA en el puerto $p · sólo se abre el navegador"
    Open-Game "http://localhost:$p/" | Out-Null
    exit 0
  }
  $l = New-Object System.Net.HttpListener
  $l.Prefixes.Add("http://localhost:$p/")
  try {
    $l.Start()
    $listener = $l
    $Port = $p
    break
  } catch {
    Write-Log "puerto $p ocupado o sin permiso ($($_.Exception.Message)) · se prueba el siguiente"
    try { $l.Close() } catch { }
  }
}
if (-not $listener) {
  Write-Log "no se pudo escuchar en ningún puerto entre $BasePort y $MaxPort · fin"
  exit 1
}
if ($Port -ne $BasePort) {
  # localStorage es por origen: en otro puerto los récords y ajustes guardados no se ven
  Write-Log "AVISO: se usa el puerto $Port en vez de $BasePort (los datos guardados son por puerto)"
}
$Url = "http://localhost:$Port/"
Write-Log "sirviendo $Root en $Url (versión $Version)"

# ── respuestas ───────────────────────────────────────────────────────────────
function Send-Bytes($ctx, [int]$status, [string]$type, [byte[]]$bytes, [string]$cache) {
  $res = $ctx.Response
  try {
    $res.StatusCode = $status
    $res.ContentType = $type
    $res.AddHeader('Cache-Control', $cache)
    $res.AddHeader('X-Content-Type-Options', 'nosniff')
    $res.ContentLength64 = $bytes.Length
    if ($ctx.Request.HttpMethod -ne 'HEAD' -and $bytes.Length -gt 0) { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
  } catch {
    # el navegador cortó la conexión: no pasa nada
  }
  try { $res.Close() } catch { }
}

function Send-Text($ctx, [int]$status, [string]$type, [string]$text) {
  Send-Bytes $ctx $status $type ([Text.Encoding]::UTF8.GetBytes($text)) 'no-store'
}

# Atiende una petición. Devuelve 'bye' si fue el aviso de cierre del juego, 'file' si sirvió
# un archivo, 'ping' o 'other'.
function Handle-Request($ctx) {
  $req = $ctx.Request
  $path = ''
  try { $path = [Uri]::UnescapeDataString($req.Url.AbsolutePath) } catch { $path = '' }

  if ($path -eq '/__carrona') {
    Send-Text $ctx 200 'application/json' ('{"app":"carrona","version":"' + $Version + '","port":' + $Port + '}')
    return 'ping'
  }
  if ($path -eq '/__bye') {
    # navigator.sendBeacon('/__bye') desde el juego al cerrarse la ventana
    Send-Text $ctx 200 'application/json' '{"bye":true}'
    return 'bye'
  }
  if ($req.HttpMethod -ne 'GET' -and $req.HttpMethod -ne 'HEAD') {
    Send-Text $ctx 405 'text/plain; charset=utf-8' 'solo GET'
    return 'other'
  }
  if ($path -eq '/') { $path = '/index.html' }
  # nada de subir de carpeta ni de rutas raras: todo lo que no esté adentro del juego es 404
  if ($path.Length -lt 2 -or $path.Contains('..') -or $path.Contains(':') -or $path.Contains('\') -or -not $path.StartsWith('/')) {
    Send-Text $ctx 404 'text/plain; charset=utf-8' 'no esta'
    return 'other'
  }
  $file = $null
  try { $file = [IO.Path]::GetFullPath((Join-Path $Root ($path.Substring(1).Replace('/', '\')))) } catch { $file = $null }
  if (-not $file -or -not $file.StartsWith($RootFull, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $file -PathType Leaf)) {
    Send-Text $ctx 404 'text/plain; charset=utf-8' 'no esta'
    return 'other'
  }
  $ext = [IO.Path]::GetExtension($file).ToLowerInvariant()
  $type = $Mime[$ext]
  if (-not $type) { $type = 'application/octet-stream' }
  # index.html y sw.js siempre frescos (son los que cambian de versión); el resto se puede cachear un rato
  $cache = 'max-age=3600'
  if ($ext -eq '.html' -or $path -eq '/sw.js') { $cache = 'no-store' }
  $bytes = [IO.File]::ReadAllBytes($file)
  Send-Bytes $ctx 200 $type $bytes $cache
  return 'file'
}

# ── abrir el juego y atender hasta que se cierre ─────────────────────────────
$proc = Open-Game $Url
$lastRequest = Get-Date
$byeAt = $null
$task = $listener.GetContextAsync()

# GetContext() bloqueante no se puede interrumpir en 5.1, así que se espera de a 250 ms con
# GetContextAsync() y entre medio se mira si el navegador terminó. Las respuestas se dan de a
# una: los archivos son chicos y en localhost cada una tarda milisegundos.
while ($true) {
  $got = $false
  try { $got = $task.Wait(250) } catch { Write-Log "listener caído ($($_.Exception.Message))"; break }
  if ($got) {
    $ctx = $task.Result
    $task = $listener.GetContextAsync()
    $kind = 'other'
    try {
      $kind = Handle-Request $ctx
    } catch {
      Write-Log "error atendiendo $($ctx.Request.RawUrl): $($_.Exception.Message)"
      try { $ctx.Response.Close() } catch { }
    }
    $lastRequest = Get-Date
    if ($kind -eq 'bye') { $byeAt = Get-Date } else { $byeAt = $null }   # un pedido después del aviso: fue una recarga (F5), no un cierre
    continue
  }
  if ($proc) {
    # con ventana app manda el proceso: cuando se cierra la última ventana, el navegador termina
    if ($proc.HasExited) { Write-Log 'se cerró la ventana del juego'; break }
  } else {
    # sin proceso hijo (navegador predeterminado, en una pestaña): vale el aviso /__bye del juego,
    # confirmado si en 3 s no llegó ninguna recarga, y si no, 90 s sin pedidos
    if ($byeAt -and (((Get-Date) - $byeAt).TotalSeconds -gt 3)) { Write-Log 'el juego avisó que se cerró'; break }
    if (((Get-Date) - $lastRequest).TotalSeconds -gt 90) { Write-Log '90 s sin pedidos: se apaga el servidor'; break }
  }
}

try { $listener.Stop() } catch { }
try { $listener.Close() } catch { }
Write-Log 'servidor apagado · fin'
exit 0
