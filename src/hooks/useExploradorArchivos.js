import { useCallback, useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { readDir } from '@tauri-apps/plugin-fs';

const EXTENSIONES_VALIDAS = /\.(pdf|png|jpg|jpeg|gif|webp)$/i;

// Ruta de la última carpeta abierta: al reabrir la app se restaura sola.
const CLAVE_RUTA = 'gestoria.ultimaCarpeta';

function leerRutaGuardada() {
  try {
    return window.localStorage.getItem(CLAVE_RUTA) || null;
  } catch {
    return null;
  }
}

function guardarRuta(ruta) {
  try {
    if (ruta) window.localStorage.setItem(CLAVE_RUTA, ruta);
    else window.localStorage.removeItem(CLAVE_RUTA);
  } catch {
    /* almacenamiento no disponible: se ignora */
  }
}

export function useExploradorArchivos() {
  const [rutaCompleta, setRutaCompleta] = useState(null); // "C:\\Users\\..."
  const [rutaActual, setRutaActual] = useState([]);       // ["C:", "Users", ...]
  const [contenidoCarpeta, setContenidoCarpeta] = useState([]);
  const [archivoSeleccionado, setArchivoSeleccionado] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState(null);
  // true mientras se intenta recuperar la última carpeta guardada.
  const [restaurando, setRestaurando] = useState(() => Boolean(leerRutaGuardada()));

  // Parsear una ruta en partes para el breadcrumb (soporta Windows y Unix)
  const parsearRuta = (ruta) => {
    const separador = ruta.includes('\\') ? '\\' : '/';
    return ruta.split(separador).filter(Boolean);
  };

  // Cargar el contenido de una ruta
  const cargarCarpeta = useCallback(async (ruta, { silencioso = false } = {}) => {
    try {
      setCargando(true);
      setError(null);

      const entries = await readDir(ruta);

      const items = entries.map((entry, idx) => {
        // Construir la ruta completa del hijo
        const separador = ruta.includes('\\') ? '\\' : '/';
        const rutaHijo = `${ruta.replace(/[\\/]$/, '')}${separador}${entry.name}`;

        const esCarpeta = entry.isDirectory;
        const esArchivoValido = !esCarpeta && EXTENSIONES_VALIDAS.test(entry.name);

        return {
          id: `${rutaHijo}-${idx}`,
          nombre: entry.name,
          tipo: esCarpeta ? 'carpeta' : 'archivo',
          ruta: rutaHijo,
          valido: esCarpeta || esArchivoValido, // solo PDFs/imágenes se pueden presentar
        };
      });

      // Ordenar: carpetas primero, luego archivos, ambos alfabéticamente
      items.sort((a, b) => {
        if (a.tipo !== b.tipo) return a.tipo === 'carpeta' ? -1 : 1;
        return a.nombre.localeCompare(b.nombre);
      });

      setContenidoCarpeta(items);
      setRutaCompleta(ruta);
      setRutaActual(parsearRuta(ruta));
      setArchivoSeleccionado(null);
      guardarRuta(ruta);
      return true;
    } catch (err) {
      console.error('Error al leer carpeta:', err);
      if (silencioso) {
        // La carpeta guardada ya no existe: se olvida y se muestra el inicio.
        guardarRuta(null);
      } else {
        setError('No se pudo leer la carpeta.');
      }
      return false;
    } finally {
      setCargando(false);
    }
  }, []);

  // Al arrancar: restaurar la última carpeta usada.
  useEffect(() => {
    const guardada = leerRutaGuardada();
    if (!guardada) {
      setRestaurando(false);
      return;
    }
    let vigente = true;
    cargarCarpeta(guardada, { silencioso: true }).finally(() => {
      if (vigente) setRestaurando(false);
    });
    return () => {
      vigente = false;
    };
  }, [cargarCarpeta]);

  // Abrir el diálogo nativo para elegir carpeta raíz
  const abrirCarpetaRaiz = useCallback(async () => {
    try {
      const ruta = await open({
        directory: true,
        multiple: false,
        title: 'Selecciona una carpeta',
      });
      if (ruta) await cargarCarpeta(ruta);
    } catch (err) {
      console.error('Error al abrir diálogo:', err);
      setError('No se pudo abrir el explorador.');
    }
  }, [cargarCarpeta]);

  // Entrar a una subcarpeta
  const abrirSubcarpeta = useCallback(
    async (carpeta) => {
      if (carpeta?.tipo === 'carpeta') await cargarCarpeta(carpeta.ruta);
    },
    [cargarCarpeta]
  );

  // Seleccionar un archivo (solo válidos)
  const seleccionarArchivo = useCallback((archivo) => {
    if (archivo?.tipo !== 'archivo') return;
    if (!archivo.valido) return; // ignorar .txt, .docx, etc.
    setArchivoSeleccionado(archivo);
  }, []);

  // Volver a la carpeta padre
  const volverAtras = useCallback(async () => {
    if (!rutaCompleta) return;

    const separador = rutaCompleta.includes('\\') ? '\\' : '/';
    const partes = rutaActual.slice();

    // Si estamos en raíz de disco (ej: ["C:"]), no hay padre
    if (partes.length <= 1) return;

    partes.pop();
    // Reconstruir ruta padre
    let rutaPadre;
    if (separador === '\\') {
      rutaPadre = partes.join('\\');
      // En Windows asegurar que "C:" quede como "C:\\"
      if (/^[A-Za-z]:$/.test(rutaPadre)) rutaPadre += '\\';
    } else {
      rutaPadre = '/' + partes.slice(1).join('/');
    }

    await cargarCarpeta(rutaPadre);
  }, [rutaCompleta, rutaActual, cargarCarpeta]);

  // Saltar a un nivel concreto desde el breadcrumb
  const irANivel = useCallback(
    async (indice) => {
      if (!rutaCompleta) return;
      const separador = rutaCompleta.includes('\\') ? '\\' : '/';
      const partes = rutaActual.slice(0, indice + 1);
      if (!partes.length) return;

      let ruta;
      if (separador === '\\') {
        ruta = partes.join('\\');
        if (/^[A-Za-z]:$/.test(ruta)) ruta += '\\';
      } else {
        ruta = '/' + partes.slice(1).join('/');
      }
      await cargarCarpeta(ruta);
    },
    [rutaCompleta, rutaActual, cargarCarpeta]
  );

  const olvidarRuta = useCallback(() => {
    guardarRuta(null);
    setRutaCompleta(null);
    setRutaActual([]);
    setContenidoCarpeta([]);
    setArchivoSeleccionado(null);
    setError(null);
  }, []);

  const puedeVolverAtras = rutaActual.length > 1;

  return {
    rutaCompleta,
    rutaActual,
    contenidoCarpeta,
    archivoSeleccionado,
    cargando,
    error,
    restaurando,
    puedeVolverAtras,
    abrirCarpetaRaiz,
    abrirSubcarpeta,
    seleccionarArchivo,
    volverAtras,
    irANivel,
    olvidarRuta,
    limpiarSeleccion: () => setArchivoSeleccionado(null),
  };
}
