import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

import { registrarEvento } from '../lib/registro';

const HOST = '127.0.0.1';
const TIMEOUT_SALUD_MS = 2500;

function dormir(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchSalud(puerto) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_SALUD_MS);

  try {
    const res = await fetch(`http://${HOST}:${puerto}/health`, {
      cache: 'no-store',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Orquesta el ciclo de vida del sidecar de Python.
 *
 * - Arranca el backend una vez al montar.
 * - Sondea /health hasta que responde (el .exe onefile tarda en extraerse).
 * - Vigila el backend mientras la app está abierta y lo relanza si se cae.
 * - Expone el puerto real (8000, o uno alternativo si estaba ocupado).
 */
export function useSidecarPython({ timeoutMs = 45000 } = {}) {
  const [estado, setEstado] = useState('iniciando'); // iniciando | listo | error
  const [puerto, setPuerto] = useState(8000);
  const [detalle, setDetalle] = useState(null);
  const [errorSidecar, setErrorSidecar] = useState(null);
  const [logPath, setLogPath] = useState('');

  const generacionRef = useRef(0);
  const montadoRef = useRef(true);
  const estadoRef = useRef(estado);
  const puertoRef = useRef(puerto);
  const reiniciandoRef = useRef(false);
  const ultimoReinicioRef = useRef(0);
  const autoReintentosRef = useRef(0);
  const camaraListaRef = useRef(false);

  useEffect(() => {
    estadoRef.current = estado;
  }, [estado]);

  useEffect(() => {
    puertoRef.current = puerto;
  }, [puerto]);

  useEffect(() => {
    camaraListaRef.current = Boolean(detalle?.camera_ready);
  }, [detalle?.camera_ready]);

  // Diagnóstico: estado del motor y de la cámara en backend.log ([ui]).
  useEffect(() => {
    registrarEvento(
      `sidecar estado=${estado} camara=${detalle?.camera_ready ? 'lista' : 'no'} ${
        detalle?.camera_state ?? ''
      }${errorSidecar ? ` error=${errorSidecar}` : ''}`
    );
  }, [estado, detalle?.camera_ready, detalle?.camera_state, errorSidecar]);

  useEffect(() => {
    montadoRef.current = true;
    return () => {
      montadoRef.current = false;
      generacionRef.current += 1;
    };
  }, []);

  const actualizarDesdeSalud = useCallback((salud) => {
    if (!salud) return;
    setDetalle(salud);
    if (typeof salud.port === 'number' && salud.port !== puertoRef.current) {
      setPuerto(salud.port);
    }
  }, []);

  const iniciar = useCallback(
    async ({ reiniciar = false } = {}) => {
      const generacion = ++generacionRef.current;

      setEstado('iniciando');
      setErrorSidecar(null);

      if (reiniciar) {
        reiniciandoRef.current = true;
        ultimoReinicioRef.current = Date.now();
        try {
          await invoke('stop_python_sidecar');
        } catch (error) {
          console.warn('[Sidecar] No se pudo detener el backend previo:', error);
        }
      }

      let puertoAsignado = puertoRef.current;

      try {
        const resultado = await invoke('start_python_sidecar');
        if (resultado?.puerto) {
          puertoAsignado = resultado.puerto;
          setPuerto(resultado.puerto);
          puertoRef.current = resultado.puerto;
        }
        if (resultado?.log) setLogPath(resultado.log);
        if (resultado?.ultimoError) setErrorSidecar(resultado.ultimoError);
      } catch (error) {
        // El proceso pudo arrancar igualmente; seguimos sondeando /health.
        console.warn('[Sidecar] start_python_sidecar falló:', error);
        setErrorSidecar(String(error));
        try {
          const info = await invoke('estado_sidecar');
          if (info?.log) setLogPath(info.log);
          if (info?.puerto) {
            puertoAsignado = info.puerto;
            setPuerto(info.puerto);
            puertoRef.current = info.puerto;
          }
        } catch {
          /* diagnóstico opcional */
        }
      }

      const tInicio = Date.now();

      while (montadoRef.current && generacionRef.current === generacion) {
        const salud = await fetchSalud(puertoAsignado);

        if (salud) {
          actualizarDesdeSalud(salud);
          setEstado('listo');
          setErrorSidecar(null);
          reiniciandoRef.current = false;
          autoReintentosRef.current = 0;
          console.log('[Sidecar] Backend de Python en línea:', salud);
          return;
        }

        if (Date.now() - tInicio > timeoutMs) {
          if (generacionRef.current === generacion) {
            setEstado('error');
            setErrorSidecar(
              (previo) =>
                previo ||
                'El servidor de IA no respondió a tiempo. Revisa el registro para más detalles.'
            );
            reiniciandoRef.current = false;
          }
          return;
        }

        await dormir(500);
      }
    },
    [actualizarDesdeSalud, timeoutMs]
  );

  // Arranque inicial
  useEffect(() => {
    iniciar();
  }, [iniciar]);

  // Vigilancia: si el backend muere, lo relanzamos automáticamente.
  // Mientras la cámara aún no está lista se sondea cada 800 ms: si no, el
  // badge podía seguir diciendo "conectando…" hasta 6 s después de que la
  // cámara ya estaba funcionando.
  useEffect(() => {
    let timer = null;
    let cancelado = false;

    const programar = () => {
      if (cancelado) return;
      const rapido = estadoRef.current === 'listo' && !camaraListaRef.current;
      timer = setTimeout(ciclo, rapido ? 800 : 6000);
    };

    const ciclo = async () => {
      if (cancelado) return;
      try {
        if (reiniciandoRef.current) return;
        if (!montadoRef.current) return;
        if (Date.now() - ultimoReinicioRef.current < 20000) return;

        if (estadoRef.current === 'listo') {
          const salud = await fetchSalud(puertoRef.current);
          if (cancelado) return;
          if (salud) {
            actualizarDesdeSalud(salud);
            return;
          }
          console.warn('[Sidecar] /health no responde. Reiniciando backend...');
          registrarEvento('/health no respondió en el sondeo; reiniciando backend');
          iniciar({ reiniciar: true });
          return;
        }

        // Recuperación acotada cuando el arranque falló (máx. 3 intentos).
        if (estadoRef.current === 'error' && autoReintentosRef.current < 3) {
          autoReintentosRef.current += 1;
          console.warn(
            `[Sidecar] Reintento automático ${autoReintentosRef.current}/3 del backend...`
          );
          iniciar({ reiniciar: true });
        }
      } finally {
        programar();
      }
    };

    programar();
    return () => {
      cancelado = true;
      if (timer) clearTimeout(timer);
    };
  }, [actualizarDesdeSalud, iniciar]);

  const reintentar = useCallback(() => {
    autoReintentosRef.current = 0;
    return iniciar({ reiniciar: true });
  }, [iniciar]);

  const abrirLog = useCallback(async () => {
    try {
      await invoke('abrir_log_sidecar');
    } catch (error) {
      console.warn('[Sidecar] No se pudo abrir el registro:', error);
    }
  }, []);

  const pythonListo = estado === 'listo';

  return {
    estado,
    pythonListo,
    camaraLista: Boolean(detalle?.camera_ready),
    detalle,
    errorSidecar,
    puerto,
    baseUrl: `http://${HOST}:${puerto}`,
    wsUrl: `ws://${HOST}:${puerto}/ws_gestos`,
    logPath,
    iniciando: estado === 'iniciando',
    reintentar,
    abrirLog,
  };
}
