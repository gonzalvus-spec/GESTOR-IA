import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Lista de cámaras conectadas y selección de la activa.
 *
 * El backend enumera DirectShow sin abrir los dispositivos, así que consultar
 * esta lista no corta el vídeo. La selección se guarda en el propio backend
 * (`camera.json`), por lo que se conserva entre sesiones.
 */
export function useCamaras({ backendBase, activo = true, intervaloMs = 20000 }) {
  const [camaras, setCamaras] = useState([]);
  const [seleccionada, setSeleccionada] = useState(null);
  const [actual, setActual] = useState(null);
  const [actualNombre, setActualNombre] = useState('');
  const [cargando, setCargando] = useState(false);
  const [cambiando, setCambiando] = useState(false);
  const [error, setError] = useState(null);
  const vivo = useRef(true);

  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
    };
  }, []);

  const cargar = useCallback(
    async (recargar = false, silencioso = false) => {
      if (!backendBase) return null;
      if (!silencioso) setCargando(true);
      // El backend ya limita la enumeración a 5 s; este margen evita que la
      // interfaz se quede esperando si la conexión local se atasca.
      const control = new AbortController();
      const temporizador = setTimeout(() => control.abort(), 6000);
      try {
        const url = `${backendBase}/camaras${recargar ? '?recargar=true' : ''}`;
        const res = await fetch(url, {
          cache: 'no-store',
          signal: control.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const datos = await res.json();
        if (!vivo.current) return null;

        setCamaras(datos.camaras || []);
        setSeleccionada(datos.seleccionada ?? null);
        // -1 significa "todavía sin cámara abierta": no es un índice válido.
        const indiceActual =
          Number.isInteger(datos.actual) && datos.actual >= 0 ? datos.actual : null;
        setActual(indiceActual);
        setActualNombre(datos.actual_nombre || '');
        setError(null);
        return datos;
      } catch {
        if (vivo.current) setError('No se pudieron leer las cámaras.');
        return null;
      } finally {
        clearTimeout(temporizador);
        if (vivo.current && !silencioso) setCargando(false);
      }
    },
    [backendBase]
  );

  // Carga inicial + refresco periódico mientras la pantalla está visible.
  useEffect(() => {
    if (!activo || !backendBase) return;
    cargar();
    const id = setInterval(() => cargar(false, true), intervaloMs);
    return () => clearInterval(id);
  }, [activo, backendBase, cargar, intervaloMs]);

  const seleccionar = useCallback(
    async (indice) => {
      if (!backendBase) return;
      const anterior = seleccionada;
      setSeleccionada(indice);
      setCambiando(true);
      const control = new AbortController();
      const temporizador = setTimeout(() => control.abort(), 8000);
      try {
        const url =
          indice === null
            ? `${backendBase}/camara/seleccionar`
            : `${backendBase}/camara/seleccionar?indice=${indice}`;
        const res = await fetch(url, { method: 'POST', signal: control.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setError(null);

        // El backend tarda unos segundos en soltar y reabrir el dispositivo.
        // Se sondea hasta que la cámara activa coincide (o se agota el tiempo).
        for (let intento = 0; intento < 10; intento += 1) {
          await new Promise((listo) => setTimeout(listo, 1000));
          const datos = await cargar(false, true);
          if (!vivo.current) return;
          if (datos) {
            const coincide =
              indice === null ? datos.actual !== null : datos.actual === indice;
            if (coincide) break;
          }
        }
      } catch {
        if (vivo.current) {
          setSeleccionada(anterior);
          setError('No se pudo cambiar de cámara.');
        }
      } finally {
        clearTimeout(temporizador);
        if (vivo.current) setCambiando(false);
      }
    },
    [backendBase, seleccionada, cargar]
  );

  return {
    camaras,
    seleccionada,
    actual,
    actualNombre,
    cargando,
    cambiando,
    error,
    cargar,
    seleccionar,
  };
}
