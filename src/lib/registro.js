import { invoke } from '@tauri-apps/api/core';

/**
 * Envía líneas de diagnóstico del frontend al mismo backend.log que escribe
 * Rust (prefijo [ui]). Así, cuando la interfaz "se queda muerta", el registro
 * muestra exactamente qué cambió antes: navegación, WebSocket, /health, vídeo.
 *
 * Lleva un freno para no inundar el archivo si algo falla en bucle.
 */
const VENTANA_MS = 5000;
const MAX_EVENTOS_POR_VENTANA = 60;

let ventanaInicio = 0;
let eventosVentana = 0;

export function registrarEvento(mensaje) {
  const ahora = Date.now();
  if (ahora - ventanaInicio > VENTANA_MS) {
    ventanaInicio = ahora;
    eventosVentana = 0;
  }
  if (eventosVentana >= MAX_EVENTOS_POR_VENTANA) return;
  eventosVentana += 1;

  const texto = String(mensaje);
  console.log('[GestorIA]', texto);

  try {
    const promesa = invoke('registrar_evento', { mensaje: texto });
    if (promesa && typeof promesa.catch === 'function') {
      promesa.catch(() => {
        /* el comando aún no existe (build antiguo): se ignora */
      });
    }
  } catch {
    /* ejecutándose en un navegador normal, sin Tauri */
  }
}
