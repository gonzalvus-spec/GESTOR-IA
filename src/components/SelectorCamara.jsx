import { useEffect } from 'react';

import { useCamaras } from '../hooks/useCamaras';
import { IconoAlerta, IconoCamara, IconoChevron, IconoRefrescar } from './Iconos';

/**
 * Selector de cámara. Sirve para elegir cualquier webcam conectada al equipo
 * (integrada, USB, capturadora...) y recuerda la elección entre sesiones.
 */
export default function SelectorCamara({
  backendBase,
  activo = true,
  camaraLista = false,
  cameraError = null,
  compacto = false,
  etiqueta = true,
}) {
  const {
    camaras,
    seleccionada,
    actual,
    actualNombre,
    cargando,
    cambiando,
    error,
    cargar,
    seleccionar,
  } = useCamaras({ backendBase, activo });

  // Cuando la cámara termina de abrirse hay que refrescar: antes de eso el
  // backend todavía no conoce el índice real y parecería que la elegida falla.
  useEffect(() => {
    if (camaraLista) cargar(false, true);
  }, [camaraLista, cargar]);

  const sinCamaras = !cargando && camaras.length === 0;
  const desincronizada =
    !cambiando &&
    seleccionada !== null &&
    actual !== null &&
    seleccionada !== actual;

  let aviso = null;
  let avisoCorto = null;
  let tipoAviso = '';
  if (cambiando) {
    aviso = 'Cambiando de cámara…';
    avisoCorto = 'Cambiando…';
    tipoAviso = 'pendiente';
  } else if (error) {
    aviso = error;
    avisoCorto = 'Error';
    tipoAviso = 'error';
  } else if (sinCamaras) {
    aviso =
      cameraError || 'No se detectaron cámaras. Conecta una y pulsa actualizar.';
    avisoCorto = cameraError ? 'Sin señal de cámara' : 'Sin cámaras';
    tipoAviso = cameraError ? 'error' : '';
  } else if (desincronizada) {
    aviso = `La cámara elegida no responde; se está usando ${
      actualNombre || 'otra cámara'
    }.`;
    avisoCorto = `Usando ${actualNombre || 'otra cámara'}`;
    tipoAviso = 'pendiente';
  } else if (cameraError) {
    aviso = cameraError;
    avisoCorto = 'Sin señal de cámara';
    tipoAviso = 'error';
  }

  const avisoVisible = compacto ? avisoCorto : aviso;

  const nombreActual = actualNombre || (actual !== null ? `Cámara ${actual + 1}` : '');

  const alCambiar = (evento) => {
    const valor = evento.target.value;
    seleccionar(valor === 'auto' ? null : Number(valor));
  };

  return (
    <div className={`selector-camara ${compacto ? 'selector-camara--compacto' : ''}`}>
      {etiqueta && (
        <span className="selector-camara-etiqueta">
          <IconoCamara size={14} />
          Cámara
        </span>
      )}

      <div className="selector-camara-fila">
        <label className="select-envoltorio">
          <select
            value={seleccionada === null ? 'auto' : String(seleccionada)}
            onChange={alCambiar}
            disabled={cambiando || (sinCamaras && !cargando)}
            aria-label="Elegir cámara"
            title={
              nombreActual ? `En uso: ${nombreActual}` : 'Elige la cámara a utilizar'
            }
          >
            <option value="auto">Automática</option>
            {camaras.map((camara) => (
              <option key={camara.indice} value={String(camara.indice)}>
                {camara.nombre}
              </option>
            ))}
          </select>
          <IconoChevron size={13} className="select-flecha" />
        </label>

        <button
          type="button"
          className="btn btn--icon btn--sm"
          onClick={() => cargar(true)}
          disabled={cargando || cambiando}
          title="Buscar cámaras conectadas"
          aria-label="Buscar cámaras conectadas"
        >
          <IconoRefrescar size={14} className={cargando ? 'girando' : ''} />
        </button>
      </div>

      {avisoVisible && (
        <p
          className={`selector-camara-aviso ${tipoAviso}`}
          title={compacto ? aviso || '' : undefined}
        >
          {tipoAviso === 'error' && <IconoAlerta size={13} />}
          {avisoVisible}
        </p>
      )}
    </div>
  );
}
