import { useEffect, useRef, useState, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { readFile } from '@tauri-apps/plugin-fs';
import { esPDF, rutaAUrlTauri } from '../utils/formatoArchivos';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.js',
  import.meta.url
).toString();

const SCALE = 1.4;
const JPEG_QUALITY = 0.8;

export function useVisorDocumento({ archivo, indicePagina = 0 }) {
  const [paginaActual, setPaginaActual] = useState(null);
  const [totalPaginas, setTotalPaginas] = useState(0);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState(null);

  const pdfRef = useRef(null);
  const cacheRef = useRef({});

  // Renderizar una página específica y guardarla en caché
  const renderizarPaginaPDF = useCallback(async (pdfDoc, numPagina) => {
    // Si ya está renderizada en memoria, retornar la imagen directamente
    if (cacheRef.current[numPagina]) {
      return cacheRef.current[numPagina];
    }

    try {
      // PDF.js es 1-indexed (página 1 es el índice 0)
      const page = await pdfDoc.getPage(numPagina + 1);
      const viewport = page.getViewport({ scale: SCALE });

      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;

      const ctx = canvas.getContext('2d', { alpha: false });
      await page.render({ canvasContext: ctx, viewport }).promise;

      const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
      cacheRef.current[numPagina] = dataUrl;
      return dataUrl;
    } catch (err) {
      console.error(`Error renderizando página ${numPagina + 1}:`, err);
      return null;
    }
  }, []);

  // 1. Cargar archivo y establecer total real de páginas
  useEffect(() => {
    let cancelado = false;

    async function cargarDocumento() {
      if (!archivo?.ruta) {
        pdfRef.current = null;
        cacheRef.current = {};
        setPaginaActual(null);
        setTotalPaginas(0);
        setError(null);
        setCargando(false);
        return;
      }

      setCargando(true);
      setError(null);

      try {
        if (esPDF(archivo.ruta)) {
          const bytes = await readFile(archivo.ruta);
          if (cancelado) return;

          const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
          if (cancelado) return;

          pdfRef.current = pdf;
          cacheRef.current = {};
          
          // Cantidad exacta extraída del PDF
          const numPaginasReales = pdf.numPages;
          setTotalPaginas(numPaginasReales);

          // Renderizar primera página activa inmediatamente
          const primeraImagen = await renderizarPaginaPDF(pdf, indicePagina);
          if (!cancelado && primeraImagen) {
            setPaginaActual(primeraImagen);
          }
        } else {
          // Si es una imagen estática
          pdfRef.current = null;
          cacheRef.current = {};
          const url = rutaAUrlTauri(archivo.ruta);
          if (cancelado) return;

          setPaginaActual(url);
          setTotalPaginas(1);
        }
      } catch (err) {
        console.error('Error cargando el archivo:', err);
        if (!cancelado) setError(`Error: ${err.message || err}`);
      } finally {
        if (!cancelado) setCargando(false);
      }
    }

    cargarDocumento();
    return () => { cancelado = true; };
  }, [archivo, renderizarPaginaPDF]);

  // 2. Cambio de página con límite estricto + precarga adyacente (Anterior y Siguiente)
  useEffect(() => {
    const pdf = pdfRef.current;
    if (!pdf || totalPaginas === 0) return;

    // Validación estricta de límites (0 a totalPaginas - 1)
    const indiceValido = Math.max(0, Math.min(indicePagina, totalPaginas - 1));

    let cancelado = false;

    async function actualizarYPreecargar() {
      // A) Cambio instantáneo si ya está en caché
      if (cacheRef.current[indiceValido]) {
        setPaginaActual(cacheRef.current[indiceValido]);
        setCargando(false);
      } else {
        // B) Si no está en caché, renderizar la actual
        setCargando(true);
        const img = await renderizarPaginaPDF(pdf, indiceValido);
        if (!cancelado && img) setPaginaActual(img);
        if (!cancelado) setCargando(false);
      }

      // C) Precargar la página SIGUIENTE en segundo plano
      if (indiceValido + 1 < totalPaginas && !cacheRef.current[indiceValido + 1]) {
        renderizarPaginaPDF(pdf, indiceValido + 1);
      }

      // D) Precargar la página ANTERIOR en segundo plano
      if (indiceValido - 1 >= 0 && !cacheRef.current[indiceValido - 1]) {
        renderizarPaginaPDF(pdf, indiceValido - 1);
      }
    }

    actualizarYPreecargar();

    return () => { cancelado = true; };
  }, [indicePagina, totalPaginas, renderizarPaginaPDF]);

  return { paginaActual, totalPaginas, cargando, error };
}