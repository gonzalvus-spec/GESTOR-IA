# -*- mode: python ; coding: utf-8 -*-
import os
from PyInstaller.utils.hooks import collect_all

datas = []
binaries = []
hiddenimports = [
    'mediapipe.tasks.c',
    'uvicorn.logging',
    'uvicorn.loops',
    'uvicorn.loops.auto',
    'uvicorn.protocols',
    'uvicorn.protocols.http',
    'uvicorn.protocols.http.auto',
    'uvicorn.protocols.websockets',
    'uvicorn.protocols.websockets.auto',
    'uvicorn.lifespan',
    'uvicorn.lifespan.on',
]

# Incluir modelo si existe
for model_candidate in ['hand_landmarker.task', '../hand_landmarker.task']:
    if os.path.exists(model_candidate):
        datas.append((model_candidate, '.'))

tmp_ret = collect_all('mediapipe')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('cvzone')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]

# Enumeración de cámaras por DirectShow (nombres reales de cada dispositivo).
# comtypes genera módulos en tiempo de ejecución, por eso se recoge entero.
tmp_ret = collect_all('comtypes')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('pygrabber')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]


a = Analysis(
    ['backend_server.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # MediaPipe importa matplotlib al cargarse (aunque GestorIA no lo use),
    # así que NO se puede excluir. El resto son dependencias opcionales que
    # solo engordarían el bundle si algún día se instalan en el entorno.
    excludes=[
        'IPython',
        'notebook',
        'pytest',
        'scipy',
        'pandas',
        'tensorflow',
        'torch',
        'sounddevice',
        'PyQt5',
        'PyQt6',
        'PySide2',
        'PySide6',
    ],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='backend_server',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    # ONEDIR: sin extracción en cada arranque (el onefile perdía ~3,5 s).
    # UPX queda desactivado porque comprimir las DLL de MediaPipe/OpenCV
    # puede romper la carga de modelos.
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='backend_server',
)
