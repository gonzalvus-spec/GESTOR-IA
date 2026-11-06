# ============================================================
#  GestorIA - Empaquetado portable
#  Genera dist-portable\GestorIA\ (y un ZIP) listo para copiar a
#  otro PC y ejecutar sin instalar nada.
# ============================================================
param([switch]$SinCompilar)

$ErrorActionPreference = 'Stop'

$raiz = Split-Path -Parent $PSScriptRoot
Set-Location $raiz

$release = Join-Path $raiz 'src-tauri\target\release'
$destino = Join-Path $raiz 'dist-portable\GestorIA'
$zip = Join-Path $raiz 'dist-portable\GestorIA-portable.zip'

# ---------- 1) Compilar backend + app ----------
if (-not $SinCompilar) {
    Write-Host "==> Compilando sidecar de Python..." -ForegroundColor Cyan
    $ErrorActionPreference = 'Continue'
    & npm.cmd run build:backend
    $codigoBackend = $LASTEXITCODE

    Write-Host "==> Compilando aplicación Tauri..." -ForegroundColor Cyan
    & npx.cmd tauri build --no-bundle
    $codigoApp = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'

    if ($codigoBackend -ne 0 -or $codigoApp -ne 0) {
        throw "La compilación falló (backend=$codigoBackend, app=$codigoApp)."
    }
}

# ---------- 2) Comprobar artefactos ----------
$exe = Join-Path $release 'gestoria.exe'
$modelo = Join-Path $release 'hand_landmarker.task'
$backend = Join-Path $release 'backend_server'

foreach ($ruta in @($exe, $modelo, $backend)) {
    if (-not (Test-Path $ruta)) {
        throw "Falta $ruta. Ejecuta sin -SinCompilar o compila antes con 'npx tauri build --no-bundle'."
    }
}

# ---------- 3) Preparar carpeta portable ----------
Write-Host "==> Preparando $destino" -ForegroundColor Cyan
if (Test-Path $destino) {
    Remove-Item $destino -Recurse -Force
}
New-Item -ItemType Directory -Path $destino -Force | Out-Null

Copy-Item $exe $destino
Copy-Item $modelo $destino
Copy-Item $backend (Join-Path $destino 'backend_server') -Recurse

$leeme = @'
GestorIA - Visor de presentaciones con gestos
=============================================

REQUISITOS
- Windows 10 u 11 de 64 bits.
- Microsoft Edge WebView2 Runtime. Viene preinstalado en Windows 10/11
  actualizados; si falta, se descarga gratis desde:
  https://developer.microsoft.com/microsoft-edge/webview2/

COMO USAR
1. Copia esta carpeta COMPLETA donde quieras (USB, escritorio, otro PC).
   No separes gestoria.exe de la carpeta backend_server ni del archivo
   hand_landmarker.task.
2. Ejecuta gestoria.exe.
3. La app recuerda la ultima carpeta abierta y la ultima camara elegida.

VARIAS CAMARAS
- En el desplegable "Camara" (pantalla de inicio, selector de carpetas y
  barra lateral de la presentacion) puedes elegir cualquier camara conectada:
  integrada, USB, capturadora, etc.
- "Automatica" usa la ultima camara que funciono.

SI LA CAMARA NO APARECE
- Cierra GestorIA antes de hacer el diagnostico.
- Desconecta y vuelve a conectar la camara, cierra Teams/Zoom y pulsa el
  boton de actualizar del desplegable "Camara".
- Diagnostico rapido: abre PowerShell en esta carpeta y ejecuta
    backend_server\backend_server.exe --diagnostico-camaras
  Muestra que camaras detecta Windows y cuales entregan imagen.
- La app tambien deja un informe automatico en:
    %LOCALAPPDATA%\GestorIA\diagnostico-camaras.txt
  Envialo junto con el registro si la camara sigue sin aparecer.
- Comprueba tambien Configuracion > Privacidad y seguridad > Camara.

DATOS Y REGISTROS
- Configuracion y cache: %LOCALAPPDATA%\GestorIA
- Registro de diagnostico: %LOCALAPPDATA%\GestorIA\logs\backend.log
- Informe de camaras: %LOCALAPPDATA%\GestorIA\diagnostico-camaras.txt

NOTAS
- La primera vez Windows puede avisar con SmartScreen ("Windows protegio tu
  PC"). Pulsa "Mas informacion" > "Ejecutar de todas formas": el ejecutable
  no esta firmado digitalmente.
- No requiere instalar Python, Node ni ninguna dependencia.
- Si una camara esta en uso por Teams, Zoom u otra app, la app mostrara
  "sin señal" hasta que se libere.
'@

$rutaLeeme = Join-Path $destino 'LEEME.txt'
[System.IO.File]::WriteAllText($rutaLeeme, $leeme, [System.Text.UTF8Encoding]::new($true))

# ---------- 4) ZIP ----------
if (Test-Path $zip) {
    Remove-Item $zip -Force
}
Write-Host "==> Comprimiendo en $zip (puede tardar)..." -ForegroundColor Cyan
Compress-Archive -Path $destino -DestinationPath $zip -CompressionLevel Optimal

$tamCarpeta = (Get-ChildItem $destino -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
$tamZip = (Get-Item $zip).Length / 1MB

Write-Host ""
Write-Host "Listo." -ForegroundColor Green
Write-Host ("  Carpeta: {0}  ({1:N0} MB)" -f $destino, $tamCarpeta)
Write-Host ("  ZIP:     {0}  ({1:N0} MB)" -f $zip, $tamZip)
Write-Host "Copia la carpeta o el ZIP a otro PC y ejecuta gestoria.exe."
