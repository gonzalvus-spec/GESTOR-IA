import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

import PantallaSeleccion from './components/PantallaSeleccion';
import PantallaPresentacion from './components/PantallaPresentacion';

import { useSidecarPython } from './hooks/useSidecarPython';
import { useWebSocketGestos } from './hooks/useWebSocketGestos';
import { useVisorDocumento } from './hooks/useVisorDocumento';
import { registrarEvento } from './lib/registro';

import './App.css';

export default function App() {
  const [pantalla, setPantalla] = useState('seleccion');
  const [archivoSeleccionado, setArchivoSeleccionado] = useState(null);

  const [indiceDiapositiva, setIndiceDiapositiva] = useState(0);
  const [zoomActivo, setZoomActivo] = useState(false);
  const [gestosBloqueados, setGestosBloqueados] = useState(false);
  const [posicion, setPosicion] = useState({ x: 0, y: 0 });

  // 1. Visor de documento (Obtenemos totalPaginas)
  const { paginaActual, totalPaginas, cargando, error } = useVisorDocumento({
    archivo: archivoSeleccionado,
    indicePagina: indiceDiapositiva,
  });

  // Guardar referencias para no rehacer los callbacks en cada render
  const zoomActivoRef = useRef(zoomActivo);
  const gestosBloqueadosRef = useRef(gestosBloqueados);
  const totalPaginasRef = useRef(totalPaginas);

  useEffect(() => { zoomActivoRef.current = zoomActivo; }, [zoomActivo]);
  useEffect(() => { gestosBloqueadosRef.current = gestosBloqueados; }, [gestosBloqueados]);
  useEffect(() => { totalPaginasRef.current = totalPaginas; }, [totalPaginas]);

  // Diagnóstico: cada cambio de pantalla queda en backend.log ([ui]).
  useEffect(() => {
    registrarEvento(
      `pantalla=${pantalla}${archivoSeleccionado ? ` archivo=${archivoSeleccionado}` : ''}`
    );
  }, [pantalla, archivoSeleccionado]);

  // Latido: si la ventana se cuelga, Rust lo detecta y la recarga.
  useEffect(() => {
    const enviar = () => {
      invoke('latido_ui').catch(() => {});
    };
    enviar();
    const id = setInterval(enviar, 5000);
    return () => clearInterval(id);
  }, []);

  // 2. Sidecar Python
  const {
    pythonListo,
    camaraLista,
    estado: estadoPython,
    detalle,
    errorSidecar,
    baseUrl,
    wsUrl,
    reintentar: reintentarPython,
    abrirLog,
  } = useSidecarPython();

  // 3. Manejar acciones de gestos CON FRENO DE MANO
  const manejarAccion = useCallback((accion) => {
    registrarEvento(
      `gesto=${accion} bloqueados=${gestosBloqueadosRef.current} zoom=${zoomActivoRef.current}`
    );

    if (gestosBloqueadosRef.current) {
      console.log('[App] Gesto ignorado (bloqueado):', accion);
      return;
    }

    const PASO = 40;

    if (zoomActivoRef.current) {
      setPosicion((prev) => {
        switch (accion) {
          case 'move_derecha':   return { ...prev, x: prev.x - PASO };
          case 'move_izquierda': return { ...prev, x: prev.x + PASO };
          case 'move_arriba':    return { ...prev, y: prev.y + PASO };
          case 'move_abajo':     return { ...prev, y: prev.y - PASO };
          default: return prev;
        }
      });
    } else {
      if (accion === 'siguiente') {
        setIndiceDiapositiva((prev) => {
          const maxPaginas = totalPaginasRef.current;
          // 🛑 FRENO: Si totalPaginas es 10, los índices van de 0 a 9.
          // No permitir que 'prev' supere (maxPaginas - 1)
          if (maxPaginas > 0 && prev >= maxPaginas - 1) {
            return maxPaginas - 1;
          }
          return prev + 1;
        });
      } else if (accion === 'atras') {
        setIndiceDiapositiva((prev) => (prev > 0 ? prev - 1 : 0));
      }
    }
  }, []);

  const manejarZoomChange = useCallback((activo) => {
    setZoomActivo(activo);
    if (!activo) setPosicion({ x: 0, y: 0 });
  }, []);

  const manejarLockChange = useCallback((locked) => {
    setGestosBloqueados(locked);
    if (locked) setPosicion({ x: 0, y: 0 });
  }, []);

  // Sincroniza el zoom real del motor (por ejemplo tras reconectar el WebSocket).
  const manejarStatusMotor = useCallback((data) => {
    if (!data || typeof data.zoom_activo !== 'boolean') return;
    setZoomActivo(data.zoom_activo);
    if (!data.zoom_activo) setPosicion({ x: 0, y: 0 });
  }, []);

  // 4. WebSocket de gestos
  const { wsConectado, ultimoGesto } = useWebSocketGestos({
    activo: pantalla === 'presentacion' && pythonListo,
    url: wsUrl,
    onGesto: manejarAccion,
    onZoomChange: manejarZoomChange,
    onLockChange: manejarLockChange,
    onStatus: manejarStatusMotor,
  });

  // 5. Callback que RECIBE el archivo desde PantallaSeleccion
  const iniciarPresentacion = useCallback((archivo) => {
    console.log('📥 [APP] iniciarPresentacion con archivo:', archivo);
    if (!archivo) {
      console.warn('⚠️ [APP] No se recibió archivo');
      return;
    }
    setArchivoSeleccionado(archivo);
    setIndiceDiapositiva(0);
    setPosicion({ x: 0, y: 0 });
    setZoomActivo(false);
    setGestosBloqueados(false);
    setPantalla('presentacion');
  }, []);

  // 6. Volver al selector
  const volverASeleccion = useCallback(() => {
    setPantalla('seleccion');
    setArchivoSeleccionado(null);
    setIndiceDiapositiva(0);
    setPosicion({ x: 0, y: 0 });
    setZoomActivo(false);
  }, []);

  // ================== RENDER ==================
  if (pantalla === 'seleccion') {
    return (
      <PantallaSeleccion
        onPresentar={iniciarPresentacion}
        estadoPython={estadoPython}
        camaraLista={camaraLista}
        backendBase={baseUrl}
        cameraError={detalle?.camera_error}
        errorPython={errorSidecar}
        onReintentarPython={reintentarPython}
        onAbrirLog={abrirLog}
      />
    );
  }

  return (
    <PantallaPresentacion
      archivoSeleccionado={archivoSeleccionado}
      indiceDiapositiva={indiceDiapositiva}
      zoomActivo={zoomActivo}
      posicion={posicion}
      ultimoGesto={ultimoGesto}
      wsConectado={wsConectado}
      gestosBloqueados={gestosBloqueados}
      paginaActual={paginaActual}
      cargando={cargando}
      error={error}
      totalPaginas={totalPaginas}
      onCambiarDocumento={volverASeleccion}
      backendBase={baseUrl}
      pythonListo={pythonListo}
      camaraLista={camaraLista}
      estadoPython={estadoPython}
      errorPython={errorSidecar}
      cameraError={detalle?.camera_error}
      onReintentarPython={reintentarPython}
      onAbrirLog={abrirLog}
    />
  );
}