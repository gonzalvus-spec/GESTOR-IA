import { useEffect, useRef, useState } from 'react';

import { registrarEvento } from '../lib/registro';

const INTERVALO_PING_MS = 15000;
const TIMEOUT_PONG_MS = 6000;
const RECONEXION_BASE_MS = 800;
const RECONEXION_MAX_MS = 8000;

/**
 * Canal WebSocket con el motor de gestos.
 *
 * Incluye reconexión con backoff exponencial y heartbeat ("ping"/"pong"),
 * de modo que si el sidecar se reinicia la app se reconecta sola en segundos.
 */
export function useWebSocketGestos({
  activo,
  onGesto,
  onZoomChange,
  onLockChange,
  onStatus,
  url = 'ws://127.0.0.1:8000/ws_gestos',
}) {
  const [wsConectado, setWsConectado] = useState(false);
  const [ultimoGesto, setUltimoGesto] = useState('Ninguno');

  // Callbacks siempre frescos sin reabrir el socket en cada render.
  const onGestoRef = useRef(onGesto);
  const onZoomRef = useRef(onZoomChange);
  const onLockRef = useRef(onLockChange);
  const onStatusRef = useRef(onStatus);

  useEffect(() => {
    onGestoRef.current = onGesto;
  }, [onGesto]);
  useEffect(() => {
    onZoomRef.current = onZoomChange;
  }, [onZoomChange]);
  useEffect(() => {
    onLockRef.current = onLockChange;
  }, [onLockChange]);
  useEffect(() => {
    onStatusRef.current = onStatus;
  }, [onStatus]);

  useEffect(() => {
    if (!activo) {
      setWsConectado(false);
      return undefined;
    }

    let ws = null;
    let cancelado = false;
    let intentos = 0;
    let timerReconexion = null;
    let timerPing = null;
    let timerPong = null;

    const limpiarTimers = () => {
      if (timerReconexion) clearTimeout(timerReconexion);
      if (timerPing) clearInterval(timerPing);
      if (timerPong) clearTimeout(timerPong);
      timerReconexion = null;
      timerPing = null;
      timerPong = null;
    };

    const cerrarSocket = () => {
      if (!ws) return;
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* ignorado */
      }
      ws = null;
    };

    const programarReconexion = () => {
      if (cancelado) return;
      const espera = Math.min(RECONEXION_MAX_MS, RECONEXION_BASE_MS * 2 ** intentos);
      registrarEvento(`ws reintentando en ${espera} ms (intento ${intentos + 1})`);
      intentos += 1;
      timerReconexion = setTimeout(conectar, espera);
    };

    const programarPing = () => {
      timerPing = setInterval(() => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        try {
          ws.send('ping');
        } catch {
          /* el onclose se encargará */
        }

        // Si el servidor no contesta, asumimos enlace muerto.
        if (timerPong) clearTimeout(timerPong);
        timerPong = setTimeout(() => {
          if (cancelado || !ws || ws.readyState !== WebSocket.OPEN) return;
          console.warn('[WS] Sin respuesta al heartbeat. Reconectando...');
          try {
            ws.close();
          } catch {
            /* ignorado */
          }
        }, TIMEOUT_PONG_MS);
      }, INTERVALO_PING_MS);
    };

    function conectar() {
      if (cancelado) return;
      cerrarSocket();

      try {
        ws = new WebSocket(url);

        ws.onopen = () => {
          if (cancelado) return;
          intentos = 0;
          setWsConectado(true);
          registrarEvento(`ws abierto (${url})`);
          console.log('[WS] Conectado al motor de gestos:', url);
          programarPing();
        };

        ws.onmessage = (event) => {
          if (cancelado) return;

          if (timerPong) {
            clearTimeout(timerPong);
            timerPong = null;
          }

          if (event.data === 'pong') return;

          try {
            const data = JSON.parse(event.data);

            switch (data.event) {
              case 'gesture':
                setUltimoGesto(data.action);
                onGestoRef.current?.(data.action);
                break;
              case 'zoom_change':
                onZoomRef.current?.(data.active);
                break;
              case 'lock_change':
                onLockRef.current?.(data.locked);
                break;
              case 'status':
                onStatusRef.current?.(data);
                break;
              default:
                break;
            }
          } catch (error) {
            console.error('[WS] Mensaje no válido:', event.data, error);
          }
        };

        ws.onclose = (event) => {
          if (cancelado) return;
          registrarEvento(
            `ws cerrado code=${event.code} motivo=${event.reason || '-'} limpio=${event.wasClean}`
          );
          setWsConectado(false);
          limpiarTimers();
          programarReconexion();
        };

        ws.onerror = (event) => {
          registrarEvento(`ws error (${event?.message || 'sin detalle'})`);
          // Forzamos el cierre para pasar por onclose y programar reconexión.
          try {
            ws?.close();
          } catch {
            /* ignorado */
          }
        };
      } catch (error) {
        console.error('[WS] No se pudo crear el socket:', error);
        programarReconexion();
      }
    }

    conectar();

    return () => {
      cancelado = true;
      registrarEvento('ws desactivado (cambio de pantalla o motor)');
      setWsConectado(false);
      limpiarTimers();
      cerrarSocket();
    };
  }, [activo, url]);

  return { wsConectado, ultimoGesto };
}
