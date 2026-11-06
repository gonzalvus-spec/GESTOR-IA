"""
GestorIA - Servidor local de visión artificial.

Este proceso se ejecuta como sidecar de la app Tauri. Expone:
  - GET  /health       -> telemetría y estado del motor (JSON)
  - GET  /camaras      -> cámaras conectadas y cámara activa (JSON)
  - POST /camara/seleccionar?indice=N -> cambia de cámara (sin índice = auto)
  - GET  /video_feed   -> stream MJPEG de la webcam anotada
  - WS   /ws_gestos    -> eventos de gestos / zoom / estado

Notas de robustez:
  * CORS habilitado: el WebView de Tauri corre en otro origen
    (http://tauri.localhost) y sin CORS el frontend no puede leer /health.
  * El puerto es configurable (--port / GESTORIA_PORT) para evitar
    conflictos con un proceso huérfano o con otro programa.
  * La cámara se reabre automáticamente con backoff si se desconecta.
"""

import argparse
import asyncio
import json
import os
import platform
import socket
import sys
import threading
import time
from contextlib import asynccontextmanager

import cv2
import numpy as np
from cvzone.HandTrackingModule import HandDetector
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
import uvicorn

APP_VERSION = "1.1.0"
DEFAULT_PORT = 8000
MAX_FPS = 50
JPEG_QUALITY = 80

# ============================================================
# LOG / CODIFICACIÓN SEGURA
# ============================================================
T_INICIO = time.time()

# En Windows, cuando stdout es una tubería (sidecar lanzado por Tauri),
# Python usa la codificación regional. Si un print contiene caracteres
# que no existen en esa tabla, el hilo puede morir con UnicodeEncodeError.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def log(*args):
    # Marca de tiempo relativa: imprescindible para medir cuánto tarda la
    # cámara en abrirse y detectar cuellos de botella en los logs.
    print(f"[{time.time() - T_INICIO:6.2f}s]", *args, flush=True)


# ============================================================
# RESOLUCIÓN ROBUSTA DE LA RUTA DEL MODELO DE IA
# ============================================================
def resolve_model_path():
    """Busca hand_landmarker.task en todos los lugares posibles."""
    candidate_dirs = []

    # 0. Ruta explícita entregada por el host (Tauri resource dir)
    env_dir = os.environ.get("GESTORIA_RESOURCE_DIR")
    if env_dir:
        candidate_dirs.append(env_dir)

    # 1. Directorio temporal de PyInstaller (ejecutable empaquetado)
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        candidate_dirs.append(meipass)

    # 2. Directorio donde reside el ejecutable
    candidate_dirs.append(os.path.dirname(os.path.abspath(sys.executable)))

    # 3. Directorio del archivo .py actual
    current_dir = os.path.dirname(os.path.abspath(__file__))
    candidate_dirs.append(current_dir)

    # 4. Raíz del proyecto y carpeta src-tauri
    candidate_dirs.append(os.path.abspath(os.path.join(current_dir, "..")))
    candidate_dirs.append(os.path.abspath(os.path.join(current_dir, "..", "src-tauri")))

    # 5. Directorio de trabajo actual
    candidate_dirs.append(os.getcwd())

    for directory in candidate_dirs:
        path = os.path.join(directory, "hand_landmarker.task")
        if os.path.isfile(path):
            log(f"[Python] Modelo hand_landmarker.task localizado en: {path}")
            return path

    log("[Python ADVERTENCIA] No se encontró hand_landmarker.task localmente.")
    return "hand_landmarker.task"


MODEL_PATH = resolve_model_path()
# cvzone usa este atributo de clase para crear BaseOptions(model_asset_path=...)
HandDetector.MODEL_NAME = MODEL_PATH


# ============================================================
# ESTADO GLOBAL
# ============================================================
class Estado:
    # frame / cámara
    frame_lock = threading.Lock()
    latest_frame: bytes | None = None
    frame_count = 0
    fps = 0.0

    camera_ready = False
    camera_error = None
    camera_index = -1
    camera_backend = ""
    # starting | connecting | ready | error
    camera_state = "starting"
    # Cámara elegida por el usuario (None = automática) y nombre legible de la
    # que está emitiendo ahora mismo.
    camera_selected: int | None = None
    camera_name = ""
    camera_selected_name = ""
    # El hilo de cámara suelta y reabre el dispositivo cuando cambia a True.
    reiniciar_camara = False

    # motor
    model_loaded = False
    model_error = None
    zoom_activo = False

    # ciclo de vida
    running = True
    shutting_down = False
    inicio = time.time()
    main_loop: asyncio.AbstractEventLoop | None = None
    puerto = DEFAULT_PORT


estado = Estado()

# Generación del último stream MJPEG pedido por el navegador. Solo el más
# reciente envía datos: así una recarga del <img> no deja hilos/streams viejos
# enviando frames en paralelo.
_stream_generacion = 0


def set_frame(frame_bytes: bytes):
    with estado.frame_lock:
        estado.latest_frame = frame_bytes


def get_frame() -> bytes | None:
    with estado.frame_lock:
        return estado.latest_frame


def telemetria() -> dict:
    return {
        "status": "ok",
        "version": APP_VERSION,
        "pid": os.getpid(),
        "port": estado.puerto,
        "camera_ready": estado.camera_ready,
        "camera_state": estado.camera_state,
        "camera_index": estado.camera_index,
        "camera_name": estado.camera_name,
        "camera_selected": estado.camera_selected,
        "camera_selected_name": estado.camera_selected_name,
        "camera_backend": estado.camera_backend,
        "camera_error": estado.camera_error,
        "model_loaded": estado.model_loaded,
        "model_error": estado.model_error,
        "model_path": MODEL_PATH,
        "frame_count": estado.frame_count,
        "fps": round(estado.fps, 1),
        "video_stream": _stream_generacion,
        "zoom_activo": estado.zoom_activo,
        "uptime": round(time.time() - estado.inicio, 1),
    }


# ============================================================
# FASTAPI + CORS
# ============================================================
@asynccontextmanager
async def lifespan(app: FastAPI):
    estado.main_loop = asyncio.get_running_loop()
    estado.running = True

    threading.Thread(target=camera_worker_thread, name="camera-worker", daemon=True).start()
    log("[Python] Servidor iniciado. Motor de cámara lanzado en hilo de fondo.")

    try:
        yield
    finally:
        estado.running = False
        estado.main_loop = None
        log("[Python] Servidor deteniéndose...")


app = FastAPI(title="GestorIA Backend Server", version=APP_VERSION, lifespan=lifespan)

# Sin esto el frontend (origen http://tauri.localhost) no puede leer /health.
# No se usan cookies ni credenciales: solo tráfico en 127.0.0.1.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
    max_age=86400,
)


# ============================================================
# GESTOR DE CONEXIONES WEBSOCKET
# ============================================================
class ConnectionManager:
    def __init__(self):
        self.active_connections: list[WebSocket] = []
        self.lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        async with self.lock:
            self.active_connections.append(websocket)

    async def disconnect(self, websocket: WebSocket):
        async with self.lock:
            if websocket in self.active_connections:
                self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        payload = json.dumps(message)
        async with self.lock:
            connections = list(self.active_connections)

        to_remove = []
        for connection in connections:
            try:
                await connection.send_text(payload)
            except Exception:
                to_remove.append(connection)

        if to_remove:
            async with self.lock:
                for conn in to_remove:
                    if conn in self.active_connections:
                        self.active_connections.remove(conn)


manager = ConnectionManager()

HAND_CONNECTIONS = [
    (0, 1), (1, 2), (2, 3), (3, 4),
    (0, 5), (5, 6), (6, 7), (7, 8),
    (5, 9), (9, 10), (10, 11), (11, 12),
    (9, 13), (13, 14), (14, 15), (15, 16),
    (13, 17), (0, 17), (17, 18), (18, 19), (19, 20),
]

finger_colors = {
    0: (0, 255, 0),    # Pulgar
    1: (0, 255, 255),  # Índice
    2: (255, 0, 0),    # Medio
    3: (255, 0, 255),  # Anular
    4: (0, 0, 255),    # Meñique
}


def emit_event_safe(data: dict):
    """Emite un evento desde un hilo de trabajo hacia el event loop de FastAPI."""
    loop = estado.main_loop
    if loop and loop.is_running():
        try:
            asyncio.run_coroutine_threadsafe(manager.broadcast(data), loop)
        except Exception as exc:
            log(f"[Python Error emit_event_safe]: {exc}")


def emit_status_safe():
    emit_event_safe({"event": "status", **telemetria()})


# ============================================================
# PLACEHOLDER / DIBUJO
# ============================================================
def create_placeholder_frame(message="Iniciando camara GestorIA..."):
    """Frame de contingencia cuando la cámara aún no está disponible."""
    img = np.zeros((480, 640, 3), dtype=np.uint8)
    img[:] = (24, 24, 28)
    # banda superior
    cv2.rectangle(img, (0, 0), (640, 64), (36, 36, 44), cv2.FILLED)
    cv2.putText(img, "GestorIA", (20, 42), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 200, 255), 2)
    cv2.putText(img, "Motor de vision", (400, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (180, 180, 180), 1)

    (text_w, _), _ = cv2.getTextSize(message, cv2.FONT_HERSHEY_SIMPLEX, 0.65, 2)
    cv2.putText(
        img,
        message,
        ((640 - text_w) // 2, 250),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.65,
        (255, 255, 255),
        2,
    )
    cv2.putText(
        img,
        "127.0.0.1:%d" % estado.puerto,
        (20, 460),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.45,
        (140, 140, 140),
        1,
    )
    ok, buffer = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
    if not ok:
        return b""
    return buffer.tobytes()


def draw_custom_landmarks(img, hand):
    lms = hand["lmList"]
    for start_idx, end_idx in HAND_CONNECTIONS:
        if start_idx < len(lms) and end_idx < len(lms):
            color = finger_colors.get(start_idx // 4, (255, 255, 255))
            cv2.line(
                img,
                (lms[start_idx][0], lms[start_idx][1]),
                (lms[end_idx][0], lms[end_idx][1]),
                color,
                2,
            )

    for idx, lm in enumerate(lms):
        color = finger_colors.get(idx // 4, (255, 255, 255))
        if idx % 4 == 0:
            color = (155, 155, 155)
        cv2.circle(img, (lm[0], lm[1]), 5, color, cv2.FILLED)


# Frame inicial para que /video_feed nunca arranque vacío.
set_frame(create_placeholder_frame("Iniciando motor de video..."))


# ============================================================
# APERTURA RESILIENTE DE CÁMARA
# ============================================================
def _backends():
    """Backends a probar, en orden de preferencia según el SO.

    En Windows NO se incluye CAP_ANY cuando hay backends explícitos: OpenCV
    resuelve CAP_ANY a MediaFoundation y, si el dispositivo está ocupado o
    acaba de liberarse, el `open()` puede bloquearse ~10 s antes de fallar.
    Eso era la causa de que la cámara tardara 10-20 s en detectarse.
    """
    if os.name == "nt":
        backends = []
        if hasattr(cv2, "CAP_DSHOW"):
            backends.append(("DirectShow", cv2.CAP_DSHOW))
        if hasattr(cv2, "CAP_MSMF"):
            backends.append(("MediaFoundation", cv2.CAP_MSMF))
        if backends:
            return backends
    return [("Auto", cv2.CAP_ANY)]


# Última combinación válida (índice + backend). Se guarda en disco para que
# el siguiente arranque abra la cámara directamente, sin barridos ni esperas.
_perfil_lock = threading.Lock()
_preferred_camera = None

# Se activa cuando el hilo de cámara ha soltado el dispositivo al cerrar.
cierre_listo = threading.Event()


def _ruta_perfil_camara():
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    return os.path.join(base, "GestorIA", "camera.json")


def _leer_perfil_camara() -> dict:
    try:
        with open(_ruta_perfil_camara(), "r", encoding="utf-8") as fh:
            datos = json.load(fh)
        return datos if isinstance(datos, dict) else {}
    except Exception:
        return {}


def _escribir_perfil_camara(datos: dict):
    try:
        ruta = _ruta_perfil_camara()
        os.makedirs(os.path.dirname(ruta), exist_ok=True)
        # Escritura atómica: si el proceso se corta a mitad no deja un JSON roto.
        temporal = ruta + ".tmp"
        with open(temporal, "w", encoding="utf-8") as fh:
            json.dump(datos, fh, ensure_ascii=False, indent=2)
        os.replace(temporal, ruta)
    except Exception as exc:
        log(f"[Python] No se pudo guardar el perfil de cámara: {exc}")


def _cargar_perfil_camara():
    datos = _leer_perfil_camara()
    try:
        index = int(datos.get("index", -1))
        label = str(datos.get("backend") or "")
        if index < 0 or not label:
            return None
        for nombre, backend in _backends():
            if nombre == label:
                return (index, nombre, backend)
    except Exception:
        pass
    return None


def _cargar_seleccion_camara() -> int | None:
    """Cámara elegida por el usuario (se conserva entre sesiones)."""
    datos = _leer_perfil_camara()
    if "seleccion" not in datos:
        return None
    try:
        valor = datos.get("seleccion")
        if valor is None:
            return None
        indice = int(valor)
        return indice if indice >= 0 else None
    except Exception:
        return None


def _guardar_perfil_camara(index, label):
    datos = _leer_perfil_camara()
    datos["index"] = index
    datos["backend"] = label
    _escribir_perfil_camara(datos)


# ============================================================
# CÁMARAS DISPONIBLES (selección del usuario)
# ============================================================
_nombres_lock = threading.Lock()
_nombres_cache: list[str] = []
_nombres_cache_ts = 0.0
_NOMBRES_TTL = 15.0


def _nombres_camaras(forzar=False) -> list[str]:
    """Nombres de las cámaras DirectShow, en el mismo orden que los índices.

    pygrabber consulta DirectShow sin abrir el dispositivo, así que se puede
    llamar mientras la cámara está emitiendo. Si no está disponible (otro SO
    o instalación mínima) se devuelve una lista vacía y la interfaz muestra
    entradas numeradas ("Cámara 1", "Cámara 2", ...).

    El lock se toma sin bloquear: si un controlador deja colgada una
    enumeración, el resto de peticiones devuelve la caché al instante en vez
    de acumular hilos esperando.
    """
    global _nombres_cache, _nombres_cache_ts

    if os.name != "nt":
        return []

    ahora = time.time()
    if not forzar and _nombres_cache and (ahora - _nombres_cache_ts) < _NOMBRES_TTL:
        return list(_nombres_cache)

    if not _nombres_lock.acquire(blocking=False):
        return list(_nombres_cache)

    try:
        ahora = time.time()
        if not forzar and _nombres_cache and (ahora - _nombres_cache_ts) < _NOMBRES_TTL:
            return list(_nombres_cache)
        try:
            import comtypes

            try:
                comtypes.CoInitialize()
            except Exception:
                pass

            from pygrabber.dshow_graph import FilterGraph

            nombres = [str(n).strip() for n in FilterGraph().get_input_devices()]
        except Exception as exc:
            log(f"[Python] No se pudieron enumerar las cámaras: {exc}")
            nombres = []

        if nombres:
            log("[Python] Cámaras enumeradas: " + ", ".join(nombres))

        _nombres_cache = nombres
        _nombres_cache_ts = ahora
        return list(nombres)
    finally:
        _nombres_lock.release()


def _nombre_camara(index: int) -> str:
    nombres = _nombres_camaras()
    if 0 <= index < len(nombres):
        return nombres[index]
    return f"Cámara {index + 1}"


def _armar_lista_camaras(nombres: list[str]) -> list[dict]:
    """Construye la lista que consume la interfaz a partir de los nombres."""
    total = len(nombres) or 4

    # Nunca ocultar la cámara activa ni la elegida aunque el SO no las liste.
    for idx in (estado.camera_index, estado.camera_selected):
        if isinstance(idx, int) and idx >= total:
            total = idx + 1

    camaras = []
    for i in range(total):
        camaras.append(
            {
                "indice": i,
                "nombre": nombres[i] if i < len(nombres) else f"Cámara {i + 1}",
                "actual": i == estado.camera_index,
                "seleccionada": i == estado.camera_selected,
            }
        )

    # Mantener la telemetría con nombres legibles.
    if 0 <= estado.camera_index < len(nombres):
        estado.camera_name = nombres[estado.camera_index]
    if estado.camera_selected is None:
        estado.camera_selected_name = ""
    elif 0 <= estado.camera_selected < len(nombres):
        estado.camera_selected_name = nombres[estado.camera_selected]
    else:
        estado.camera_selected_name = f"Cámara {estado.camera_selected + 1}"

    return camaras


def listar_camaras(forzar=False) -> list[dict]:
    """Cámaras que se pueden elegir en la interfaz."""
    return _armar_lista_camaras(_nombres_camaras(forzar))


# Selección persistida (None = automática).
estado.camera_selected = _cargar_seleccion_camara()


def _try_open(
    index,
    backend_label,
    backend_id,
    timeout=6.0,
    usar_mjpg=True,
    resolucion=None,
):
    """Abre UNA combinación y espera al primer frame válido.

    Devuelve `(cap, frame, motivo)`:
      * `(cap, frame, None)`       -> cámara lista.
      * `(None, None, "no_abre")`  -> el índice no existe o está ocupado.
      * `(None, None, "sin_frame")`-> abrió pero no entregó imagen a tiempo.

    Lecciones medidas en esta máquina:
      * No fijar resolución/FPS/BUFFERSIZE: esas llamadas rompen el stream de
        este driver y el `read()` devuelve False al instante.
      * Sin MJPG la cámara entrega ~1 fps (YUY2 satura el bus USB): con MJPG
        va a ~16 fps.
      * El primer frame puede tardar 1-5 s; hay que esperarlo en vez de
        cerrar y reabrir, porque cada reapertura deja el dispositivo en mal
        estado varios segundos.

    `usar_mjpg` y `resolucion` existen para los reintentos: hay controladores
    de otros equipos que se atascan al forzar MJPG o que necesitan 640x480
    explícito. En la primera pasada se usan los valores seguros de esta
    máquina (MJPG, resolución nativa) y solo se prueban variantes si falla.
    """
    cap = None
    try:
        cap = cv2.VideoCapture(index, backend_id)
        if not cap or not cap.isOpened():
            if cap:
                cap.release()
            return None, None, "no_abre"

        if usar_mjpg:
            try:
                cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
            except Exception:
                pass

        if resolucion:
            try:
                cap.set(cv2.CAP_PROP_FRAME_WIDTH, int(resolucion[0]))
                cap.set(cv2.CAP_PROP_FRAME_HEIGHT, int(resolucion[1]))
            except Exception:
                pass

        limite = time.time() + timeout
        while time.time() < limite:
            ok, frame = cap.read()
            if ok and frame is not None and getattr(frame, "size", 0) > 0:
                return cap, frame, None
            # Evita un bucle cerrado golpeando el driver mientras arranca.
            time.sleep(0.05)

        cap.release()
        return None, None, "sin_frame"
    except Exception as exc:
        log(f"[Python] Error abriendo cámara idx={index} backend={backend_label}: {exc}")
        if cap:
            try:
                cap.release()
            except Exception:
                pass
        return None, None, "no_abre"


def _indices_a_probar() -> list[int]:
    """Índices que merece la pena probar.

    Si DirectShow conoce N cámaras se prueban como mucho N+1 (el +1 cubre
    índices que OpenCV se salta). Sin nombres se barre 0..3, que cubre
    integrada + USB + capturadora + cámara virtual.
    """
    total = len(_nombres_cache) + 1 if _nombres_cache else 4
    total = max(2, min(total, 6))

    orden: list[int] = []
    if isinstance(estado.camera_selected, int):
        orden.append(estado.camera_selected)
    if _preferred_camera:
        orden.append(_preferred_camera[0])
    orden += [i for i in range(total) if i not in orden]
    return orden


def _candidatos_camara():
    """Combinaciones a probar, en orden.

    Primero **todos** los índices con DirectShow y después con Media
    Foundation: hay equipos donde DirectShow falla con una cámara concreta y
    Media Foundation sí funciona (y al contrario). Antes Media Foundation solo
    se probaba en el primer índice, así que una cámara virtual que abría sin
    imagen en el índice 0 agotaba el tiempo y nunca se llegaba a la cámara
    real del índice 1.
    """
    indices = _indices_a_probar()
    candidatos = []
    for label, backend in _backends():
        for idx in indices:
            candidatos.append((idx, label, backend))
    return candidatos


def _escribir_diagnostico_camaras(lineas, resultado):
    """Deja un informe legible en %LOCALAPPDATA%\\GestorIA.

    Sirve para diagnosticar equipos a los que no tenemos acceso: el usuario
    solo tiene que enviar `diagnostico-camaras.txt`.
    """
    try:
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
        carpeta = os.path.join(base, "GestorIA")
        os.makedirs(carpeta, exist_ok=True)
        ruta = os.path.join(carpeta, "diagnostico-camaras.txt")
        with open(ruta, "w", encoding="utf-8") as fh:
            fh.write("GestorIA - Diagnóstico de cámara\n")
            fh.write(f"Fecha: {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
            fh.write(f"Sistema: {platform.platform()}\n")
            fh.write(
                f"Python: {sys.version.split()[0]} "
                f"(congelado={bool(getattr(sys, 'frozen', False))})\n"
            )
            fh.write(f"Resultado: {resultado}\n\n")
            fh.write("\n".join(lineas))
            fh.write("\n")
        log(f"[Python] Diagnóstico de cámara guardado en: {ruta}")
    except Exception as exc:
        log(f"[Python] No se pudo escribir el diagnóstico de cámara: {exc}")


def find_and_open_camera():
    """Busca cámara de forma justa: barrido corto y reintento de las lentas.

    El presupuesto es limitado para no bloquear el hilo; el worker vuelve a
    llamar con backoff si no aparece ninguna cámara.

    Aquí NO se enumera con pygrabber: si un controlador dejara colgada la
    enumeración, el hilo de cámara nunca llegaría a abrir el dispositivo. Se
    usan los nombres que ya cacheó `/camaras` (si los hay).
    """
    global _preferred_camera

    with _perfil_lock:
        if _preferred_camera is None:
            _preferred_camera = _cargar_perfil_camara()

    nombres = list(_nombres_cache)
    if nombres:
        log("[Python] Cámaras detectadas: " + ", ".join(nombres))

    lineas_diag = [
        f"Cámaras DirectShow: {nombres if nombres else '(sin enumerar todavía)'}",
        f"Backends: {[label for label, _ in _backends()]}",
    ]

    def _finalizar(resultado):
        _escribir_diagnostico_camaras(lineas_diag, resultado)

    def _registrar_exito(index, label):
        global _preferred_camera
        guardar = _preferred_camera != (index, label)
        _preferred_camera = (index, label)
        estado.camera_index = index
        estado.camera_backend = label
        estado.camera_error = None
        # Si ya se enumeraron los nombres, se usa el real; si no, uno numerado.
        if 0 <= index < len(_nombres_cache):
            estado.camera_name = _nombres_cache[index]
        else:
            estado.camera_name = f"Cámara {index + 1}"
        log(
            f"[Python] Cámara abierta correctamente (idx={index}, backend={label}) "
            f"tras {time.time() - estado.inicio:.1f}s de proceso."
        )
        if guardar:
            _guardar_perfil_camara(index, label)
        _finalizar(f"OK: idx={index} ({label})")

    candidatos = _candidatos_camara()
    limite_total = time.time() + 35.0
    abrieron_sin_frame: list[tuple[int, str, int]] = []

    def _intentar(combo, timeout, usar_mjpg=True, resolucion=None):
        index, label, backend = combo
        restante = limite_total - time.time()
        if restante <= 0.5:
            return None, None
        log(
            f"[Python] Probando cámara idx={index} backend={label} "
            f"({time.time() - estado.inicio:.1f}s)..."
        )
        cap, warm, motivo = _try_open(
            index,
            label,
            backend,
            timeout=min(timeout, restante),
            usar_mjpg=usar_mjpg,
            resolucion=resolucion,
        )
        variante = ""
        if not usar_mjpg:
            variante += " sin MJPG"
        if resolucion:
            variante += f" {resolucion[0]}x{resolucion[1]}"
        lineas_diag.append(f"  idx={index} {label}{variante} -> {motivo or 'OK'}")
        if cap is not None:
            return cap, warm
        if motivo == "sin_frame":
            log(
                f"[Python] idx={index} ({label}) abrió pero no entregó "
                f"imagen{variante}."
            )
            if combo not in abrieron_sin_frame:
                abrieron_sin_frame.append(combo)
        time.sleep(0.15)
        return None, None

    # Ronda 1: barrido completo con poco margen. Así una cámara virtual que
    # abre sin imagen en el índice 0 no impide llegar a la cámara real.
    for combo in candidatos:
        if time.time() >= limite_total:
            break
        cap, warm = _intentar(combo, 2.0)
        if cap is not None:
            _registrar_exito(combo[0], combo[1])
            return cap, warm

    # Ronda 2: solo las que abrieron pero tardaban en entregar el primer frame
    # (cámaras USB que despiertan lento). Se copia la lista porque _intentar
    # puede añadir más entradas.
    for combo in list(abrieron_sin_frame):
        if time.time() >= limite_total:
            break
        cap, warm = _intentar(combo, 4.0)
        if cap is not None:
            _registrar_exito(combo[0], combo[1])
            return cap, warm

    # Ronda 3: algunos controladores se atascan con MJPG o necesitan una
    # resolución concreta. Es el último recurso antes de darse por vencido.
    for combo in list(abrieron_sin_frame):
        if time.time() >= limite_total:
            break
        cap, warm = _intentar(
            combo, 4.0, usar_mjpg=False, resolucion=(640, 480)
        )
        if cap is not None:
            _registrar_exito(combo[0], combo[1])
            return cap, warm

    estado.camera_index = -1
    estado.camera_backend = ""
    estado.camera_error = (
        "No se detecta ninguna cámara disponible. Comprueba que esté conectada, "
        "que no la esté usando otra aplicación (Teams, Zoom, navegador) y que "
        "Windows permita el acceso (Configuración > Privacidad y seguridad > "
        "Cámara). Se guardó un diagnóstico en "
        "%LOCALAPPDATA%\\GestorIA\\diagnostico-camaras.txt."
    )
    log("[Python] " + estado.camera_error)
    _finalizar("SIN CÁMARA: ninguna combinación entregó imagen")
    return None, None


def liberar_camara(cap):
    """Suelta el dispositivo de forma ordenada.

    Windows tarda varios segundos en liberar una webcam si el proceso muere a
    la fuerza; soltándola antes de salir, el siguiente arranque la abre al
    instante en vez de esperar 10-20 s.
    """
    if cap is None:
        return
    try:
        cap.release()
        log("[Python] Cámara liberada correctamente.")
    except Exception as exc:
        log(f"[Python] Error liberando la cámara: {exc}")



def _set_camera_state(ready: bool, state: str | None = None):
    """Publica el cambio de estado de la cámara a los clientes conectados."""
    nuevo = state or ("ready" if ready else "connecting")
    if estado.camera_ready != ready or estado.camera_state != nuevo:
        estado.camera_ready = ready
        estado.camera_state = nuevo
        emit_status_safe()


# ============================================================
# HILO DE CAPTURA E INFERENCIA
# ============================================================
def camera_worker_thread():
    """Bucle de captura + MediaPipe, aislado del event loop asíncrono."""
    log("=== MÓDULO DE GESTOS Y WEBCAM INICIADO ===")

    detector = None
    detector_retry_at = 0.0

    tiempo_inicio_gesto = 0.0
    gesto_ejecutado = False
    ultimo_zoom_time = 0.0
    TIEMPO_ESPERA_MS = 250

    cap = None
    frame_warm = None
    fallos_consecutivos = 0
    fallos_lectura = 0
    reintento_camara_en = 0.0
    t0 = time.time()
    ultimo_ts_detector = 0
    fps_contador = 0
    fps_ventana = time.time()

    while estado.running:
        ahora = time.time()

        # ---------- 0) Cambio de cámara pedido desde la interfaz ----------
        if estado.reiniciar_camara:
            estado.reiniciar_camara = False
            if cap is not None:
                log("[Python] Cambiando de cámara: liberando la actual...")
                liberar_camara(cap)
                cap = None
            frame_warm = None
            fallos_consecutivos = 0
            fallos_lectura = 0
            reintento_camara_en = 0.0
            estado.camera_error = None
            estado.camera_ready = False
            estado.camera_state = "connecting"
            set_frame(create_placeholder_frame("Cambiando de camara..."))
            emit_status_safe()

        # ---------- A) Asegurar detector ----------
        if detector is None and ahora >= detector_retry_at:
            try:
                detector = HandDetector(
                    staticMode=False,
                    maxHands=2,
                    modelComplexity=1,
                    detectionCon=0.7,
                    minTrackCon=0.7,
                )
                estado.model_loaded = True
                estado.model_error = None
                log("[Python] Modelo HandDetector inicializado correctamente.")
                emit_status_safe()
            except Exception as exc:
                estado.model_loaded = False
                estado.model_error = str(exc)
                detector = None
                detector_retry_at = ahora + 5.0
                log(f"[Python ERROR] No se pudo inicializar HandDetector: {exc}")
                set_frame(create_placeholder_frame("Error cargando modelo de IA"))
                emit_status_safe()

        # ---------- B) Asegurar cámara ----------
        if cap is None:
            if ahora < reintento_camara_en:
                _set_camera_state(False, "error" if estado.camera_error else "connecting")
                if get_frame() is None:
                    set_frame(create_placeholder_frame("Reintentando camara..."))
                time.sleep(0.2)
                continue

            _set_camera_state(False, "connecting")
            set_frame(create_placeholder_frame("Conectando camara web..."))
            cap, frame_warm = find_and_open_camera()

            if cap is None:
                fallos_consecutivos += 1
                # Backoff: 1s, 2s, 4s, 8s máximo. El primer reintento es
                # rápido porque el driver suele necesitar <1 s para soltar
                # el dispositivo tras un cierre forzado.
                espera = min(8.0, 1.0 * (2 ** min(fallos_consecutivos - 1, 3)))
                reintento_camara_en = time.time() + espera
                set_frame(create_placeholder_frame("Sin camara. Reintentando..."))
                emit_status_safe()
                log(f"[Python] Cámara no disponible. Reintento en {espera:.0f}s.")
                time.sleep(0.2)
                continue

            fallos_consecutivos = 0
            fallos_lectura = 0
            _set_camera_state(True)
            # Reiniciar la ventana de medición de FPS: el arranque de cámara
            # puede tardar varios segundos y falsearía la primera métrica.
            fps_contador = 0
            fps_ventana = time.time()

        # ---------- C) Leer frame ----------
        try:
            if frame_warm is not None:
                img = frame_warm
                frame_warm = None
                success = True
            else:
                success, img = cap.read()
        except Exception as exc:
            log(f"[Python] Error leyendo frame: {exc}")
            success, img = False, None

        if not success or img is None or getattr(img, "size", 0) == 0:
            fallos_lectura += 1
            # No cerrar el dispositivo al primer fallo: cerrar y reabrir lo
            # deja inutilizable varios segundos y era otra fuente de esperas.
            if fallos_lectura < 15:
                time.sleep(0.05)
                continue
            log("[Python] Lectura de cámara fallida de forma persistente. Reiniciando dispositivo...")
            _set_camera_state(False)
            liberar_camara(cap)
            cap = None
            frame_warm = None
            fallos_lectura = 0
            time.sleep(0.5)
            continue

        fallos_lectura = 0
        estado.camera_ready = True
        accion_detectada = None

        # ---------- D) Detección de manos ----------
        if detector is not None:
            try:
                # Timestamps reales (ms). cvzone incrementa de 1 en 1, lo que
                # hace que el tracker de MediaPipe corra "más rápido" que la
                # realidad y pierda el seguimiento con movimientos normales.
                ts = max(int((time.time() - t0) * 1000), ultimo_ts_detector + 1)
                detector.timestamp = ts
                ultimo_ts_detector = ts

                hands, img = detector.findHands(img, draw=False, flipType=False)

                if hands:
                    for hand in hands:
                        x, y, w, h = hand["bbox"]
                        cv2.rectangle(img, (x - 20, y - 20), (x + w + 20, y + h + 20), (128, 128, 128), 2)
                        draw_custom_landmarks(img, hand)

                    hand1 = hands[0]
                    fingers1 = detector.fingersUp(hand1)
                    tiempo_actual = time.time()

                    # 1. Ambas manos en V -> activar / desactivar zoom
                    if len(hands) == 2:
                        hand2 = hands[1]
                        fingers2 = detector.fingersUp(hand2)
                        es_v_mano1 = fingers1[1] == 1 and fingers1[2] == 1 and fingers1[3] == 0
                        es_v_mano2 = fingers2[1] == 1 and fingers2[2] == 1 and fingers2[3] == 0

                        if es_v_mano1 and es_v_mano2 and (tiempo_actual - ultimo_zoom_time) > 1.0:
                            accion_detectada = "toggle_zoom"

                    # 2. Zoom activo -> paneo
                    if estado.zoom_activo and not accion_detectada and len(hands) == 2:
                        hand2 = hands[1]
                        fingers2 = detector.fingersUp(hand2)
                        es_v_mano1 = fingers1[1] == 1 and fingers1[2] == 1
                        es_v_mano2 = fingers2[1] == 1 and fingers2[2] == 1

                        if es_v_mano1 or es_v_mano2:
                            f_mov = fingers2 if es_v_mano1 else fingers1
                            if f_mov == [1, 0, 0, 0, 0]:
                                accion_detectada = "move_derecha"
                            elif f_mov == [0, 0, 0, 0, 1]:
                                accion_detectada = "move_izquierda"
                            elif f_mov == [0, 1, 0, 0, 0]:
                                accion_detectada = "move_arriba"
                            elif f_mov == [0, 1, 1, 0, 0]:
                                accion_detectada = "move_abajo"

                    # 3. Sin zoom -> cambiar diapositiva
                    elif not estado.zoom_activo and not accion_detectada:
                        if len(hands) == 1:
                            if fingers1 == [0, 0, 0, 0, 1]:
                                accion_detectada = "siguiente"
                            elif fingers1 == [1, 0, 0, 0, 0]:
                                accion_detectada = "atras"
                        elif len(hands) == 2:
                            fingers2 = detector.fingersUp(hands[1])
                            if [1, 0, 0, 0, 0] in (fingers2, fingers1):
                                accion_detectada = "atras"
                            elif [0, 0, 0, 0, 1] in (fingers2, fingers1):
                                accion_detectada = "siguiente"

                    # Debounce (mantener el gesto 250 ms)
                    if accion_detectada:
                        if tiempo_inicio_gesto == 0:
                            tiempo_inicio_gesto = time.time()
                        transcurrido_ms = (time.time() - tiempo_inicio_gesto) * 1000

                        if transcurrido_ms > TIEMPO_ESPERA_MS and not gesto_ejecutado:
                            if accion_detectada == "toggle_zoom":
                                ultimo_zoom_time = time.time()
                                estado.zoom_activo = not estado.zoom_activo
                                log(f"[Python] Zoom {'ACTIVADO' if estado.zoom_activo else 'DESACTIVADO'}")
                                emit_event_safe({"event": "zoom_change", "active": estado.zoom_activo})
                                emit_status_safe()
                            else:
                                emit_event_safe({"event": "gesture", "action": accion_detectada})
                            gesto_ejecutado = True
                    else:
                        tiempo_inicio_gesto = 0
                        gesto_ejecutado = False
                else:
                    tiempo_inicio_gesto = 0
                    gesto_ejecutado = False

            except Exception as exc:
                log(f"[Python Error procesando manos]: {exc}")
                tiempo_inicio_gesto = 0
                gesto_ejecutado = False

        # ---------- E) Codificar y publicar frame ----------
        try:
            ok, buffer = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
            if ok:
                set_frame(buffer.tobytes())
                estado.frame_count += 1
                fps_contador += 1
        except Exception as exc:
            log(f"[Python Error codificando JPEG]: {exc}")

        # ---------- F) Métrica FPS ----------
        if ahora - fps_ventana >= 1.0:
            estado.fps = fps_contador / (ahora - fps_ventana)
            fps_contador = 0
            fps_ventana = ahora

        # Limitar a ~50 FPS
        time.sleep(max(0.0, 1.0 / MAX_FPS - 0.001))

    liberar_camara(cap)
    estado.camera_ready = False
    estado.camera_state = "starting"
    cierre_listo.set()
    log("[Python] Hilo de cámara finalizado.")


# ============================================================
# ENDPOINTS
# ============================================================
@app.get("/")
def root():
    return {"app": "GestorIA", "version": APP_VERSION, "docs": "/health"}


@app.get("/health")
async def health_check():
    # `async` a propósito: si fuera síncrona, cada sondeo ocuparía un hilo del
    # pool compartido con el streaming y, si ese pool se satura, la UI cree que
    # el motor se cayó aunque siga vivo.
    return telemetria()


@app.get("/camaras")
async def camaras_disponibles(recargar: bool = False):
    """Cámaras conectadas al equipo.

    La enumeración usa DirectShow (pygrabber) sin abrir los dispositivos, así
    que se puede pedir mientras la cámara está emitiendo y no corta el vídeo.

    Se limita a 5 s: si un controlador deja colgada la enumeración, la
    interfaz recibe igualmente la lista cacheada (o entradas numeradas) en vez
    de quedarse esperando para siempre.
    """
    try:
        camaras = await asyncio.wait_for(
            asyncio.to_thread(listar_camaras, recargar), timeout=5.0
        )
    except asyncio.TimeoutError:
        log("[Python] La enumeración de cámaras tardó más de 5 s; se usa la caché.")
        camaras = _armar_lista_camaras(list(_nombres_cache))
    return {
        "camaras": camaras,
        "seleccionada": estado.camera_selected,
        "seleccionada_nombre": estado.camera_selected_name,
        "actual": estado.camera_index,
        "actual_nombre": estado.camera_name,
    }


@app.post("/camara/seleccionar")
async def seleccionar_camara(indice: int | None = None):
    """Cambia la cámara activa (sin `indice` = automática).

    El hilo de captura suelta el dispositivo y reabre el elegido; la
    preferencia queda guardada para el próximo arranque.
    """
    if indice is not None and indice < 0:
        indice = None

    anterior = estado.camera_selected
    estado.camera_selected = indice

    nombres = await asyncio.to_thread(_nombres_camaras)
    if indice is None:
        estado.camera_selected_name = ""
        nombre = "automática"
    else:
        estado.camera_selected_name = (
            nombres[indice] if 0 <= indice < len(nombres) else f"Cámara {indice + 1}"
        )
        nombre = estado.camera_selected_name

    datos = _leer_perfil_camara()
    datos["seleccion"] = indice
    datos["seleccion_nombre"] = estado.camera_selected_name
    _escribir_perfil_camara(datos)

    # Si ya está emitiendo esa misma cámara no se reinicia nada.
    sin_cambios = anterior == indice and estado.camera_ready
    if not sin_cambios:
        estado.reiniciar_camara = True

    log(
        f"[Python] Cámara seleccionada: {nombre}"
        + ("" if indice is None else f" (idx={indice})")
    )
    return {
        "ok": True,
        "seleccionada": indice,
        "nombre": estado.camera_selected_name,
        "sin_cambios": sin_cambios,
    }


@app.post("/shutdown")
def shutdown():
    """Cierre ordenado solicitado por la app Tauri.

    Suelta la webcam ANTES de terminar. Si el proceso muere a la fuerza,
    Windows mantiene el dispositivo ocupado varios segundos y el siguiente
    arranque tarda 10-20 s en poder abrirlo.
    """
    if estado.shutting_down:
        return {"ok": True}
    estado.shutting_down = True
    estado.running = False
    log("[Python] Petición de cierre ordenado recibida.")

    def _salir():
        # Espera a que el hilo de cámara suelte el dispositivo.
        cierre_listo.wait(timeout=2.0)
        time.sleep(0.05)
        log("[Python] Cierre ordenado completado.")
        os._exit(0)

    threading.Thread(target=_salir, name="shutdown", daemon=True).start()
    return {"ok": True}


@app.websocket("/ws_gestos")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    log("Cliente WebSocket conectado")
    try:
        await websocket.send_text(json.dumps({"event": "status", **telemetria()}))
        while True:
            mensaje = await websocket.receive_text()
            # Heartbeat del frontend: confirma que el enlace sigue vivo.
            if mensaje == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        await manager.disconnect(websocket)
        log("Cliente WebSocket desconectado")
    except Exception as exc:
        await manager.disconnect(websocket)
        log(f"[Python] Error en WebSocket: {exc}")


@app.get("/video_feed")
async def video_feed():
    return StreamingResponse(
        generar_frames(),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Connection": "keep-alive",
        },
    )


async def generar_frames():
    """Stream MJPEG asíncrono con política "gana el último".

    Antes era un generador síncrono: Starlette lo iteraba en un hilo del pool
    compartido con el resto de endpoints. Cada recarga del <img> del frontend
    abría un stream nuevo y, si alguno se quedaba colgado, el pool se agotaba:
    /health dejaba de responder, la UI mostraba "motor detenido" y el vídeo
    desaparecía (justo el síntoma "la cámara se cierra sola").

    Ahora no consume hilos, cierra los streams anteriores y solo reenvía un
    frame cuando cambia (o cada segundo, para mantener viva la conexión).
    """
    global _stream_generacion
    _stream_generacion += 1
    generacion = _stream_generacion
    log(f"[Python] Stream de vídeo abierto (nº {generacion}).")

    ultimo_frame = -1
    ultimo_envio = 0.0
    try:
        while estado.running and generacion == _stream_generacion:
            with estado.frame_lock:
                frame = estado.latest_frame
                cuenta = estado.frame_count

            ahora = time.time()
            if frame and (cuenta != ultimo_frame or ahora - ultimo_envio > 1.0):
                cabecera = (
                    b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                    + str(len(frame)).encode("ascii")
                    + b"\r\n\r\n"
                )
                yield cabecera + frame + b"\r\n"
                ultimo_frame = cuenta
                ultimo_envio = ahora

            # Sin frame todavía: no enviamos partes inválidas al navegador.
            await asyncio.sleep(0.03)
    finally:
        log(f"[Python] Stream de vídeo cerrado (nº {generacion}).")


def diagnostico_camaras():
    """Imprime qué cámaras ve Windows y cuáles entregan imagen.

    Se usa desde la consola (`backend_server.exe --diagnostico-camaras`) para
    diagnosticar equipos donde la cámara no aparece, sin abrir la aplicación.
    """
    print("GestorIA - Diagnóstico de cámaras")
    nombres = _nombres_camaras(forzar=True)
    print("Cámaras DirectShow:", nombres if nombres else "(ninguna / no disponible)")
    print("Backends:", [label for label, _ in _backends()])
    total = len(nombres) + 1 if nombres else 4
    total = max(2, min(total, 6))
    for idx in range(total):
        for label, backend in _backends():
            cap, _frame, motivo = _try_open(idx, label, backend, timeout=1.5)
            if cap is not None:
                print(f"  idx={idx:<2} {label:<15} OK (entrega imagen)")
                cap.release()
            else:
                print(f"  idx={idx:<2} {label:<15} {motivo or 'error'}")
    print("Fin del diagnóstico.")


# ============================================================
# MAIN
# ============================================================
def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="GestorIA backend (sidecar)")
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("GESTORIA_PORT", DEFAULT_PORT)),
        help="Puerto HTTP local (por defecto 8000)",
    )
    parser.add_argument(
        "--host",
        default=os.environ.get("GESTORIA_HOST", "127.0.0.1"),
        help="Interfaz de escucha (por defecto 127.0.0.1)",
    )
    parser.add_argument(
        "--diagnostico-camaras",
        action="store_true",
        help="Prueba las cámaras disponibles y sale (soporte técnico)",
    )
    return parser.parse_args(argv)


def puerto_disponible(host: str, port: int) -> bool:
    """Comprueba si podemos escuchar en host:port."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind((host, port))
        return True
    except OSError:
        return False
    finally:
        sock.close()


def main():
    args = parse_args()
    if args.diagnostico_camaras:
        diagnostico_camaras()
        # Salida inmediata: con el ejecutable congelado, la descarga de
        # módulos (COM/MediaPipe) podía devolver código 1 aunque el
        # diagnóstico hubiera ido bien.
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(0)

    estado.puerto = args.port

    # El host (Rust) libera el puerto antes de lanzarnos; esperamos un poco
    # por si el proceso anterior todavía está cerrando.
    limite = time.time() + 10.0
    while not puerto_disponible(args.host, args.port):
        if time.time() > limite:
            log(
                f"[Python ERROR] El puerto {args.port} está ocupado por otro proceso. "
                "Cierra la otra instancia de GestorIA o el programa que lo esté usando."
            )
            sys.exit(3)
        log(f"[Python] Puerto {args.port} ocupado. Esperando liberación...")
        time.sleep(0.5)

    log(f"[Python] Iniciando servidor en http://{args.host}:{args.port} (pid={os.getpid()})")

    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        log_level="info",
        access_log=False,
        loop="asyncio",
    )


if __name__ == "__main__":
    main()
