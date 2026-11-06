import { useEffect, useState } from 'react';

import { IconoDocumento, IconoImagen, IconoZoom } from './Iconos';

export default function VisorDiapositiva({
  paginaActual,
  cargando,
  error,
  zoomActivo,
  posicion,
  indicePagina,
  totalPaginas,
  nombreArchivo,
}) {
  // Guardamos la imagen previa para evitar el parpadeo de fondo
  const [imagenVista, setImagenVista] = useState(paginaActual);

  useEffect(() => {
    if (paginaActual) {
      setImagenVista(paginaActual);
    }
  }, [paginaActual]);

  // Asegurar que el número visible nunca supere el total de páginas
  const paginaMostrada = totalPaginas > 0
    ? Math.min(indicePagina + 1, totalPaginas)
    : 1;

  const esPDF = /\.pdf$/i.test(nombreArchivo || '');

  return (
    <main className="content">
      <header className="visor-header">
        <div className="visor-info">
          <span className={`visor-archivo-icono ${esPDF ? 'pdf' : 'imagen'}`}>
            {esPDF ? <IconoDocumento size={17} /> : <IconoImagen size={17} />}
          </span>
          <div className="visor-archivo">
            <span className="visor-nombre" title={nombreArchivo}>
              {nombreArchivo || 'Sin documento'}
            </span>
            <span className="visor-meta">
              Diapositiva {paginaMostrada} de {totalPaginas > 0 ? totalPaginas : '—'}
            </span>
          </div>
        </div>

        <div className="visor-acciones">
          {cargando && <span className="visor-cargando-pill">Cargando…</span>}
          {zoomActivo && (
            <span className="visor-zoom-tag">
              <IconoZoom size={14} />
              Zoom activo
            </span>
          )}
        </div>
      </header>

      <div className="visor-viewport">
        <div
          className="visor-slide"
          style={{
            transform: zoomActivo
              ? `scale(2.2) translate(${posicion.x}px, ${posicion.y}px)`
              : 'scale(1) translate(0, 0)',
            transition: zoomActivo
              ? 'transform 0.15s ease-out'
              : 'transform 0.3s ease',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          {/* Imagen principal congelada mientras llega la siguiente */}
          {imagenVista && (
            <img
              src={imagenVista}
              alt={`Diapositiva ${paginaMostrada}`}
              className="visor-imagen"
              draggable={false}
              decoding="async"
              style={{
                display: 'block',
                width: '100%',
                height: '100%',
                objectFit: 'contain',
                opacity: cargando ? 0.85 : 1,
                transition: 'opacity 0.15s linear',
              }}
            />
          )}

          {/* Mensajes de estado */}
          {cargando && !imagenVista && (
            <div className="visor-mensaje">Cargando documento…</div>
          )}

          {cargando && imagenVista && (
            <div className="visor-cargando-overlay">Cargando…</div>
          )}

          {error && <div className="visor-mensaje error">{error}</div>}

          {!cargando && !error && !imagenVista && (
            <div className="visor-mensaje">Sin contenido para mostrar.</div>
          )}
        </div>
      </div>
    </main>
  );
}
