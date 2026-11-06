# GestorIA

Aplicación de escritorio para **presentar PDFs e imágenes controlando la navegación con gestos de la mano**. La app corre sobre Tauri v2 + React 19 y el motor de visión vive en un sidecar de Python (FastAPI + MediaPipe + OpenCV).

```
React (WebView)  --invoke-->  Rust/Tauri  --spawn-->  backend_server.exe
      |                                                 (FastAPI :8000)
      |------ WebSocket /ws_gestos, HTTP /health, MJPEG /video_feed ------|
```

No necesitas teclado ni control remoto: levantas la mano frente a la cámara y pasas diapositivas, activas el zoom y te desplazas por el documento.

---

## Características

- **Navegación por gestos** con una o dos manos, sin calibración.
- **Visor de PDF e imágenes** con zoom y paneo controlados con la mano.
- **Explorador de carpetas** estilo escritorio: migas de pan, buscador, rejilla con iconos por tipo y botón *Presentar documento*.
- **Selección de cámara en caliente**: detecta todas las cámaras conectadas (integrada, USB, capturadora, virtual), muestra su nombre real y recuerda la elección.
- **Memoria de la última carpeta**: al abrir la app se restaura la carpeta que estabas viendo.
- **Cámara en vivo** en la barra lateral con estado del motor, gestos, zoom y último gesto detectado.
- **Tema oscuro** con acento azul e iconos SVG propios.
- **Empaquetado portable**: un ZIP con todo (Python, OpenCV, MediaPipe) listo para otro PC.

### Formatos compatibles

| Tipo | Extensiones |
| ---- | ----------- |
| Documento | `.pdf` |
| Imágenes | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp` |

Los PDF se renderizan página a página con **pdf.js**; cada página se convierte a imagen para poder aplicarle zoom y paneo sin perder fluidez.

---

## Gestos

El motor lee la mano con MediaPipe y clasifica los dedos levantados. Para evitar disparos accidentales, un gesto debe **mantenerse 250 ms**.

| Gesto | Acción | Cuándo |
| ----- | ------ | ------ |
| ✌️ + ✌️ (ambas manos en V) | Activar / desactivar **zoom** | Siempre |
| 🤙 (meñique) | **Siguiente** diapositiva | Sin zoom |
| 👍 (pulgar) | **Anterior** diapositiva | Sin zoom |
| ✌️ + ☝️ | **Subir** (paneo) | Con zoom activo |
| ✌️ + ✌️ (otra mano en V) | **Bajar** (paneo) | Con zoom activo |
| ✌️ + 👍 | **Derecha** (paneo) | Con zoom activo |
| ✌️ + 🤙 | **Izquierda** (paneo) | Con zoom activo |

Con dos manos, la segunda mano indica la dirección mientras la primera se mantiene en V. Al llegar a la primera o última diapositiva, el visor se detiene en lugar de salirse del documento.

---

## Tecnologías

| Capa | Tecnología |
| ---- | ---------- |
| Escritorio | Tauri v2 (Rust) |
| Interfaz | React 19 + Vite 8 |
| Visor | pdf.js (`pdfjs-dist`) |
| Motor de gestos | Python + FastAPI + MediaPipe (`cvzone`) |
| Visión | OpenCV |
| Empaquetado del sidecar | PyInstaller (modo *onedir*) |
| Portabilidad | PowerShell (`scripts/empaquetar-portable.ps1`) |

---

## Requisitos

- Node.js 20+
- Rust (stable) + MSVC Build Tools
- Python 3.12–3.14 **solo para compilar el sidecar** (`python-backend/venv`)

---

## Desarrollo

```bash
npm install

# 1) Crear el entorno de Python (una sola vez)
python -m venv python-backend/venv
python-backend\venv\Scripts\pip install -r python-backend/requirements.txt

# 2) Compilar el sidecar (rápido si no cambió nada)
npm run build:backend

# 3) Levantar la app (Tauri compila el sidecar automáticamente si falta)
npm run tauri dev
```

El backend también se puede ejecutar suelto para depurarlo:

```bash
npm run backend
# o, en otro puerto:
python-backend\venv\Scripts\python.exe python-backend\backend_server.py --port 8010
```

### Scripts disponibles

| Comando | Qué hace |
| ------- | -------- |
| `npm run dev` | Solo el frontend (Vite) |
| `npm run backend` | Sidecar Python en primer plano |
| `npm run build:backend` | Compila el sidecar con PyInstaller (incremental) |
| `npm run backend:force` | Fuerza la recompilación del sidecar |
| `npm run tauri dev` | App completa en modo desarrollo |
| `npm run build:all` | Backend + frontend + instalador |
| `npm run portable` | Genera la carpeta y el ZIP portable |

---

## Compilar el instalador

```bash
npm run build:all     # backend + frontend + bundle
# o simplemente
npm run tauri build
```

`tauri.conf.json` ejecuta `build:backend` antes de cada build, así el `.exe` de Python y la app nunca quedan desincronizados. El script es incremental: si no cambió `backend_server.py` ni el modelo, no vuelve a pasar por PyInstaller.

El sidecar se empaqueta en modo **onedir**: `src-tauri/bin/backend_server/` contiene `backend_server.exe` y `_internal/`. No es un único archivo a propósito: el formato *onefile* se autodescomprimía en cada arranque (~2 s extra). La app localiza esa carpeta sola (recursos del bundle, junto a `gestoria.exe` o en `src-tauri/bin/` durante el desarrollo).

Para una build portable sin instalador:

```bash
npx tauri build --no-bundle
```

El resultado queda en `src-tauri/target/release/` y **hay que distribuir la carpeta `backend_server/` y `hand_landmarker.task` junto a `gestoria.exe`**.

---

## Versión portable

Genera una carpeta autocontenida y un ZIP listos para copiar a otro PC:

```bash
npm run portable                    # compila backend + app y empaqueta
npm run portable -- -SinCompilar    # reempaqueta sin volver a compilar
```

Resultado:

- `dist-portable\GestorIA\` — `gestoria.exe`, `hand_landmarker.task`, `backend_server\` y `LEEME.txt`.
- `dist-portable\GestorIA-portable.zip` — lo mismo comprimido (~130 MB).

Copia la carpeta completa (o descomprime el ZIP) en el otro equipo y ejecuta `gestoria.exe`. **No requiere instalar Python, Node ni OpenCV**: el runtime de Python, las DLL de Visual C++, OpenCV, MediaPipe y las dependencias de la cámara van dentro de `backend_server\_internal\`.

Requisitos en el equipo de destino:

- Windows 10 u 11 de 64 bits.
- **Microsoft Edge WebView2 Runtime**. Viene preinstalado en Windows 10/11 actualizados; si falta, se descarga gratis desde Microsoft.
- La primera vez, SmartScreen puede avisar porque el `.exe` no está firmado: *Más información* → *Ejecutar de todas formas*.

La configuración (`%LOCALAPPDATA%\GestorIA`) se crea sola en cada equipo; el paquete no contiene rutas absolutas. Si quieres llevarte también la última carpeta abierta o la cámara elegida, copia esa carpeta de `%LOCALAPPDATA%`.

---

## Estructura del proyecto

```
Presentaciones-IA/
├── src/                        # Interfaz React
│   ├── App.jsx                 # Estado global, gestos y navegación
│   ├── components/             # Pantallas, visor, sidebar y selector de cámara
│   ├── hooks/                  # Sidecar, WebSocket, PDF, explorador y cámaras
│   ├── lib/registro.js         # Log del frontend ([ui])
│   ├── styles/                 # CSS por pantalla
│   └── utils/                  # Rutas y tipos de archivo
├── src-tauri/                  # Host Tauri (Rust)
│   ├── src/                    # Arranque y ciclo de vida del sidecar
│   ├── tauri.conf.json         # Ventana, bundle y recursos
│   └── bin/backend_server/     # Sidecar compilado (generado)
├── python-backend/
│   ├── backend_server.py       # FastAPI + MediaPipe + OpenCV
│   ├── build_sidecar.py        # PyInstaller incremental
│   ├── backend_server.spec
│   ├── requirements.txt
│   └── hand_landmarker.task    # Modelo de MediaPipe
├── scripts/
│   └── empaquetar-portable.ps1 # Carpeta + ZIP portable
├── public/                     # Recursos estáticos
├── dist/                       # Build del frontend (generado)
└── dist-portable/              # Paquete portable (generado)
```

---

## API del sidecar

El backend escucha en `127.0.0.1` y elige el primer puerto libre entre **8000 y 8010**; el frontend se adapta al puerto real.

| Método | Ruta | Descripción |
| ------ | ---- | ----------- |
| `GET` | `/health` | Telemetría y estado del motor (JSON) |
| `GET` | `/camaras` | Cámaras conectadas y cámara activa |
| `POST` | `/camara/seleccionar?indice=N` | Cambia de cámara (sin índice = automática) |
| `GET` | `/video_feed` | Stream MJPEG de la webcam anotada |
| `POST` | `/shutdown` | Cierre ordenado: suelta la cámara y termina |
| `WS` | `/ws_gestos` | Eventos de gestos, zoom, bloqueo y estado |

Eventos del WebSocket:

| Evento | Contenido |
| ------ | --------- |
| `gesture` | `action`: `siguiente`, `atras`, `move_arriba`, `move_abajo`, `move_derecha`, `move_izquierda` |
| `zoom_change` | `active`: `true` / `false` |
| `status` | Estado completo del motor (FPS, cámara, zoom, etc.) |

El canal incluye **heartbeat** (`ping`/`pong`) y **reconexión con backoff exponencial** (800 ms → 8 s), de modo que si el sidecar se reinicia la app se reconecta sola.

---

## Diagnóstico

- El host escribe un registro con todo lo que imprimen Rust y Python en:
  `%LOCALAPPDATA%\GestorIA\logs\backend.log`
- Las líneas `[ui]` las escribe el frontend (pantalla activa, estado del motor, apertura/cierre del WebSocket, errores del vídeo). Sirven para saber si el fallo fue de la interfaz y no del backend.
- Desde la interfaz: botón **Ver registro** cuando el motor de IA falla.
- Comprobar el backend manualmente: <http://127.0.0.1:8000/health>
- Procesos del motor: `backend_server.exe` (un solo proceso con onedir).
- Si el WebView se cuelga (ventana en blanco) el host lo detecta por falta de latidos y registra `La interfaz lleva N s sin responder; recargando...` seguido de una recarga automática de la ventana.

### La cámara o el servidor no arrancan

1. Cierra GestorIA y comprueba que no queden procesos:
   `tasklist | findstr backend_server`
2. Comprueba el puerto: `netstat -ano | findstr :8000`
3. Si otro programa usa el puerto 8000, GestorIA elegirá automáticamente el siguiente libre (8001–8010) y el frontend usará ese puerto.
4. Si la cámara está ocupada por Teams/Zoom/navegador, el panel muestra el error y reintenta con backoff. El motor ya no deja procesos huérfanos.
5. Diagnóstico de cámaras sin abrir la app (sirve también en el paquete portable). Cierra GestorIA antes de ejecutarlo:

   ```powershell
   backend_server\backend_server.exe --diagnostico-camaras
   ```

   Muestra los nombres que ve DirectShow y si cada índice/backend entrega imagen. Es la forma más rápida de saber si el problema es de la cámara, del controlador o de los permisos de Windows.

6. Cada búsqueda deja un informe en `%LOCALAPPDATA%\GestorIA\diagnostico-camaras.txt` con el sistema, los nombres detectados y el resultado de cada combinación (índice, backend, MJPG/resolución). Enviar ese archivo y `logs\backend.log` es suficiente para diagnosticar un equipo remoto.

### La cámara tarda en arrancar

- `%LOCALAPPDATA%\GestorIA\camera.json` guarda la última combinación que funcionó (`index`/`backend`) y la cámara elegida (`seleccion`). El desplegable de la interfaz permite cambiarla sin borrar nada; el botón de actualizar del selector vuelve a enumerar los dispositivos conectados.
- En este equipo la primera imagen tarda ~1–4 s y se entrega en MJPG. Fijar resolución/FPS con OpenCV rompe el stream de este driver, así que **no** se tocan esas propiedades; el escalado se hace después en memoria.
- El backend espera al primer frame dentro de la misma captura en lugar de cerrar y reabrir el dispositivo: cada reapertura lo deja ocupado varios segundos y era la causa de los arranques de 15–25 s.
- La búsqueda prueba **todos los índices** con DirectShow y después con Media Foundation, en dos rondas (barrido corto + reintento de cámaras lentas). Así una cámara virtual que abre sin imagen en el índice 0 no impide llegar a la cámara real del índice 1, que es el caso típico al cambiar de PC.

---

## Notas técnicas

- El sidecar usa PyInstaller **onedir**: un solo proceso, sin autodescompresión en cada arranque. Rust guarda el PID y, como red de seguridad, sigue cerrando el árbol completo (`taskkill /F /T /PID`) si el cierre ordenado falla.
- Al cerrar, Rust pide un **cierre ordenado** (`POST /shutdown`): Python suelta la cámara y termina solo (~0,7 s). Solo si no responde en 2,5 s se fuerza el árbol de procesos. Así el siguiente arranque encuentra la cámara libre.
- `/video_feed` es un **generador asíncrono** con política "gana el último stream": no consume hilos del pool de FastAPI y cierra los streams viejos que deja el `<img>` al recargarse. Antes, varios streams colgados podían agotar el pool: `/health` dejaba de responder, la interfaz mostraba "motor detenido" y el vídeo desaparecía (el síntoma "la cámara se cierra sola").
- `backend_server` habilita CORS porque el WebView de Tauri (`http://tauri.localhost`) es un origen distinto al del servidor local; sin ese permiso el frontend no puede leer `/health`.
- Las cámaras se enumeran por **DirectShow** (`pygrabber` + `comtypes`), que devuelve los nombres reales **sin abrir** los dispositivos: consultar `GET /camaras` no corta el vídeo. Al elegir otra cámara (`POST /camara/seleccionar?indice=N`, sin índice = automática), el hilo de captura suelta el dispositivo y lo reabre; si la elegida no responde, se usa la última que funcionó y la interfaz lo avisa.
- El detector usa **timestamps reales** en milisegundos para MediaPipe. Con los timestamps sintéticos de `cvzone` el tracker corre más rápido que la realidad y pierde el seguimiento con movimientos normales.
- La captura y la detección corren en un **hilo propio** (`camera-worker`), separado del servidor FastAPI: los frames se publican bajo un lock y los eventos salen por WebSocket sin bloquear las peticiones HTTP.

---

## Limitaciones

- Solo **Windows** (la enumeración y captura de cámara dependen de DirectShow/Media Foundation).
- Se controla **una cámara a la vez**.
- El `.exe` no está firmado: SmartScreen avisará la primera vez.
- El reconocimiento de gestos funciona mejor con **buena iluminación** y la mano completa dentro del encuadre.
