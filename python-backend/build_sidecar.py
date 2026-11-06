"""
Compila el backend de Python con PyInstaller y lo deja listo para Tauri.

Mejoras respecto a la versión anterior:
  * Cierra instancias residuales antes de escribir los binarios (evita
    "Access is denied" al reconstruir con la app abierta).
  * Es incremental: si el .exe ya está al día, no vuelve a compilar
    (un build de Tauri tarda segundos, no minutos).
  * Verifica que el modelo exista antes de empaquetar.
  * Copia con reintentos y muestra errores claros.
"""

import argparse
import os
import shutil
import subprocess
import sys
import time

DESTINO_TRIPLE = "backend_server-x86_64-pc-windows-msvc.exe"
NOMBRES_PROCESO = [
    "backend_server.exe",
    "backend_server-x86_64-pc-windows-msvc.exe",
]

def log(mensaje):
    print(f"[Build Sidecar] {mensaje}", flush=True)


def matar_instancias_previas():
    """Cierra el backend si quedó abierto; si no, la copia del .exe falla."""
    if os.name != "nt":
        subprocess.run(["pkill", "-9", "-f", "backend_server"], check=False)
        return

    for nombre in NOMBRES_PROCESO:
        resultado = subprocess.run(
            ["taskkill", "/F", "/T", "/IM", nombre],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if resultado.returncode == 0:
            log(f"Proceso {nombre} cerrado antes de compilar.")

    time.sleep(0.6)


def archivos_fuente(script_dir):
    fuentes = [
        os.path.join(script_dir, "backend_server.py"),
        os.path.join(script_dir, "backend_server.spec"),
    ]
    requisitos = os.path.join(script_dir, "requirements.txt")
    if os.path.exists(requisitos):
        fuentes.append(requisitos)
    modelo = os.path.join(script_dir, "hand_landmarker.task")
    if os.path.exists(modelo):
        fuentes.append(modelo)
    return [ruta for ruta in fuentes if os.path.exists(ruta)]


def esta_al_dia(ejecutable, fuentes):
    if not os.path.exists(ejecutable):
        return False
    fecha_exe = os.path.getmtime(ejecutable)
    return all(os.path.getmtime(fuente) <= fecha_exe for fuente in fuentes)


def copiar_con_reintentos(origen, destino, intentos=6):
    ultimo_error = None
    for intento in range(1, intentos + 1):
        try:
            os.makedirs(os.path.dirname(destino), exist_ok=True)
            shutil.copy2(origen, destino)
            return
        except (PermissionError, OSError) as error:
            ultimo_error = error
            log(f"Destino bloqueado ({intento}/{intentos}): {destino}")
            time.sleep(1.0)
    raise SystemExit(
        f"[Build Sidecar ERROR] No se pudo copiar a {destino}.\n"
        f"Detalle: {ultimo_error}\n"
        "Cierra GestorIA (y cualquier backend_server.exe) e inténtalo de nuevo."
    )


def copiar_carpeta(origen, destino, intentos=6):
    """Copia la carpeta completa del sidecar (onedir) con reintentos.

    PyInstaller en modo onedir genera `backend_server/` con el .exe y la
    carpeta `_internal/`. No hace falta comprimirlo en un solo archivo: así
    arranca en décimas de segundo en lugar de extraerse en cada inicio.
    """
    ultimo_error = None
    for intento in range(1, intentos + 1):
        try:
            if os.path.isdir(destino):
                shutil.rmtree(destino)
            os.makedirs(os.path.dirname(destino), exist_ok=True)
            shutil.copytree(origen, destino)
            return
        except (PermissionError, OSError) as error:
            ultimo_error = error
            log(f"Carpeta destino bloqueada ({intento}/{intentos}): {destino}")
            time.sleep(1.0)
    raise SystemExit(
        f"[Build Sidecar ERROR] No se pudo copiar a {destino}.\n"
        f"Detalle: {ultimo_error}\n"
        "Cierra GestorIA (y cualquier backend_server.exe) e inténtalo de nuevo."
    )


def carpeta_al_dia(origen_exe, destino_exe):
    if not os.path.exists(destino_exe):
        return False
    return (
        os.path.getsize(origen_exe) == os.path.getsize(destino_exe)
        and os.path.getmtime(destino_exe) + 1 >= os.path.getmtime(origen_exe)
    )


def main():
    parser = argparse.ArgumentParser(description="Compila el sidecar de GestorIA")
    parser.add_argument("--force", action="store_true", help="Recompilar siempre")
    args = parser.parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(script_dir)
    log(f"Directorio de trabajo: {script_dir}")

    # ---------- Modelo ----------
    modelo_raiz = os.path.abspath(os.path.join(script_dir, "..", "hand_landmarker.task"))
    modelo_local = os.path.join(script_dir, "hand_landmarker.task")
    if not os.path.exists(modelo_local):
        if not os.path.exists(modelo_raiz):
            raise SystemExit(
                "[Build Sidecar ERROR] Falta hand_landmarker.task. "
                "Colócalo en la raíz del proyecto o en python-backend/."
            )
        log("Copiando modelo desde la raíz del proyecto...")
        shutil.copy2(modelo_raiz, modelo_local)

    # ---------- Rutas ----------
    carpeta_dist = os.path.join(script_dir, "dist", "backend_server")
    ejecutable = os.path.join(carpeta_dist, "backend_server.exe")
    tauri_dir = os.path.abspath(os.path.join(script_dir, "..", "src-tauri"))
    destino_carpeta = os.path.join(tauri_dir, "bin", "backend_server")
    destino_bin = os.path.join(destino_carpeta, "backend_server.exe")

    fuentes = archivos_fuente(script_dir)

    if not args.force and esta_al_dia(ejecutable, fuentes):
        log("El sidecar ya está actualizado. Se omite la compilación.")
    else:
        matar_instancias_previas()

        pyinstaller = os.path.join(script_dir, "venv", "Scripts", "pyinstaller.exe")
        if not os.path.exists(pyinstaller):
            pyinstaller = "pyinstaller"

        comando = [pyinstaller, "--noconfirm", "--clean", "backend_server.spec"]
        log(f"Ejecutando: {' '.join(comando)}")
        resultado = subprocess.run(comando)
        if resultado.returncode != 0:
            raise SystemExit(
                f"[Build Sidecar ERROR] PyInstaller falló con código {resultado.returncode}."
            )

        if not os.path.exists(ejecutable):
            raise SystemExit(
                f"[Build Sidecar ERROR] No se generó el ejecutable en {ejecutable}"
            )

    # La copia se hace siempre que el destino falte o esté desactualizado.
    if not carpeta_al_dia(ejecutable, destino_bin):
        log("Copiando carpeta del sidecar a src-tauri/bin/backend_server...")
        copiar_carpeta(carpeta_dist, destino_carpeta)
    else:
        log("src-tauri/bin/backend_server ya contiene la versión actualizada.")

    # Binarios onefile de versiones anteriores: solo ocupaban espacio.
    for obsoleto in (
        os.path.join(tauri_dir, "bin", "backend_server.exe"),
        os.path.join(tauri_dir, "bin", DESTINO_TRIPLE),
    ):
        if os.path.exists(obsoleto):
            try:
                os.remove(obsoleto)
                log(f"Eliminado binario onefile obsoleto: {obsoleto}")
            except OSError as error:
                log(f"Aviso: no se pudo borrar {obsoleto} ({error}).")

    # ---------- Recursos compartidos con Tauri ----------
    copiar_con_reintentos(
        modelo_local, os.path.join(tauri_dir, "hand_landmarker.task")
    )
    copiar_con_reintentos(
        modelo_local, os.path.join(destino_carpeta, "hand_landmarker.task")
    )

    # Copia opcional para ejecutar directo desde target/release.
    target_release = os.path.join(tauri_dir, "target", "release")
    if os.path.isdir(target_release):
        try:
            shutil.copy2(modelo_local, os.path.join(target_release, "hand_landmarker.task"))
            carpeta_release = os.path.join(target_release, "backend_server")
            if not carpeta_al_dia(ejecutable, os.path.join(carpeta_release, "backend_server.exe")):
                copiar_carpeta(carpeta_dist, carpeta_release)
            obsoleto = os.path.join(target_release, "backend_server.exe")
            if os.path.exists(obsoleto):
                os.remove(obsoleto)
        except OSError as error:
            log(f"Aviso: no se pudo actualizar target/release ({error}).")

    log("============================================================")
    log("[OK] SIDECAR COMPILADO Y ACTUALIZADO PARA TAURI")
    log(f"Destino: {destino_carpeta}")
    log("============================================================")


if __name__ == "__main__":
    main()
