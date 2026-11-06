import { Fragment, useState } from 'react';
import { useExploradorArchivos } from '../hooks/useExploradorArchivos';
import SelectorCamara from './SelectorCamara';
import {
  IconoAlerta,
  IconoArchivo,
  IconoAtras,
  IconoBuscar,
  IconoCarpeta,
  IconoChevron,
  IconoDocumento,
  IconoImagen,
  IconoInicio,
  IconoLogo,
  IconoPlay,
  IconoRefrescar,
  IconoRegistro,
} from './Iconos';

export default function PantallaSeleccion({
  onPresentar,
  estadoPython = 'iniciando',
  camaraLista = false,
  backendBase = '',
  cameraError = null,
  errorPython = null,
  onReintentarPython,
  onAbrirLog,
}) {
  const {
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
  } = useExploradorArchivos();

  const [busqueda, setBusqueda] = useState('');

  const itemsFiltrados = contenidoCarpeta.filter((item) =>
    item.nombre.toLowerCase().includes(busqueda.toLowerCase())
  );

  // Iniciar la presentación con el archivo activo
  const handlePresentar = (archivo = archivoSeleccionado) => {
    if (!archivo) return;
    setBusqueda(''); // Limpiar la búsqueda al presentar
    onPresentar?.(archivo);
  };

  // Manejador para cuando el usuario hace clic o doble clic
  const handleItemClick = (item) => {
    const esCarpeta = item.tipo === 'carpeta';
    const deshabilitado = !esCarpeta && !item.valido;

    if (esCarpeta) {
      setBusqueda(''); // Limpiar filtro al cambiar de subcarpeta
      abrirSubcarpeta(item);
    } else if (!deshabilitado) {
      seleccionarArchivo(item);
    }
  };

  const handleItemDoubleClick = (item) => {
    const esCarpeta = item.tipo === 'carpeta';
    const deshabilitado = !esCarpeta && !item.valido;

    if (!esCarpeta && !deshabilitado) {
      handlePresentar(item);
    }
  };

  // ---------- Restaurando la última carpeta ----------
  if (restaurando) {
    return (
      <div className="pantalla-inicio">
        <div className="inicio-card inicio-card--cargando">
          <span className="marca-logo marca-logo--grande">
            <IconoLogo size={26} />
          </span>
          <p className="inicio-cargando">Abriendo tu última carpeta…</p>
          <span className="barra-carga" />
        </div>
      </div>
    );
  }

  // ---------- Pantalla inicial: sin carpeta abierta ----------
  if (!rutaActual.length) {
    return (
      <div className="pantalla-inicio">
        <div className="inicio-card">
          <div className="marca marca--centrada">
            <span className="marca-logo marca-logo--grande">
              <IconoLogo size={26} />
            </span>
            <span className="marca-texto">
              <strong>GestorIA</strong>
              <small>Visor de presentaciones con gestos</small>
            </span>
          </div>

          <h1 className="inicio-titulo">Presenta sin tocar el teclado</h1>
          <p className="inicio-texto">
            Abre una carpeta con tus PDF o imágenes y controla la presentación
            con la mano: pasar diapositiva, avanzar y hacer zoom.
          </p>

          <button className="btn btn--primary btn--lg" onClick={abrirCarpetaRaiz}>
            <IconoCarpeta size={18} />
            Abrir carpeta
          </button>

          {error && (
            <p className="inicio-error">
              <IconoAlerta size={15} /> {error}
            </p>
          )}
        </div>

        <EstadoMotor
          estadoPython={estadoPython}
          camaraLista={camaraLista}
          errorPython={errorPython}
          onReintentarPython={onReintentarPython}
          onAbrirLog={onAbrirLog}
        />

        <SelectorCamara
          backendBase={backendBase}
          activo={estadoPython === 'listo'}
          camaraLista={camaraLista}
          cameraError={cameraError}
          compacto
        />
      </div>
    );
  }

  // ---------- Explorador de carpetas ----------
  const totalCarpetas = contenidoCarpeta.filter((i) => i.tipo === 'carpeta').length;
  const totalArchivos = contenidoCarpeta.length - totalCarpetas;

  return (
    <div className="drive-container">
      <header className="drive-header">
        <div className="marca">
          <span className="marca-logo">
            <IconoLogo size={20} />
          </span>
          <span className="marca-texto">
            <strong>GestorIA</strong>
            <small>Selector de presentaciones</small>
          </span>
        </div>

        <div className="drive-header-acciones">
          <SelectorCamara
            backendBase={backendBase}
            activo={estadoPython === 'listo'}
            camaraLista={camaraLista}
            cameraError={cameraError}
            compacto
            etiqueta={false}
          />
          <EstadoMotor
            estadoPython={estadoPython}
            camaraLista={camaraLista}
            errorPython={errorPython}
            onReintentarPython={onReintentarPython}
            onAbrirLog={onAbrirLog}
          />
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={abrirCarpetaRaiz}
            title="Elegir otra carpeta"
          >
            <IconoCarpeta size={16} />
            Cambiar carpeta
          </button>
        </div>
      </header>

      <div className="drive-toolbar">
        <button
          type="button"
          className="btn btn--icon"
          onClick={volverAtras}
          disabled={!puedeVolverAtras}
          title="Carpeta anterior"
          aria-label="Carpeta anterior"
        >
          <IconoAtras />
        </button>

        <button
          type="button"
          className="btn btn--icon"
          onClick={abrirCarpetaRaiz}
          title="Elegir carpeta raíz"
          aria-label="Elegir carpeta raíz"
        >
          <IconoInicio />
        </button>

        <nav className="breadcrumb" aria-label="Ruta de carpetas">
          {rutaActual.map((parte, idx) => {
            const esActual = idx === rutaActual.length - 1;
            return (
              <Fragment key={`${parte}-${idx}`}>
                {idx > 0 && <IconoChevron size={12} className="breadcrumb-sep" />}
                <button
                  type="button"
                  className={`breadcrumb-item ${esActual ? 'activo' : ''}`}
                  onClick={() => !esActual && irANivel(idx)}
                  disabled={esActual}
                  title={parte}
                >
                  {parte}
                </button>
              </Fragment>
            );
          })}
        </nav>

        <label className="buscador">
          <IconoBuscar size={15} className="buscador-icono" />
          <input
            type="text"
            className="drive-busqueda"
            placeholder="Buscar en esta carpeta…"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
          />
        </label>
      </div>

      <div className="drive-contenido">
        {cargando && <p className="drive-vacio">Cargando carpeta…</p>}

        {!cargando && itemsFiltrados.length === 0 && (
          <div className="drive-vacio">
            <IconoCarpeta size={26} />
            <p>
              {busqueda
                ? `Sin resultados para “${busqueda}”.`
                : 'Esta carpeta está vacía.'}
            </p>
          </div>
        )}

        {!cargando && itemsFiltrados.length > 0 && (
          <div className="drive-grid">
            {itemsFiltrados.map((item) => {
              const esSeleccionado = archivoSeleccionado?.id === item.id;
              const esCarpeta = item.tipo === 'carpeta';
              const esPDF = /\.pdf$/i.test(item.nombre);
              const esImagen = /\.(png|jpg|jpeg|gif|webp)$/i.test(item.nombre);
              const deshabilitado = !esCarpeta && !item.valido;

              return (
                <button
                  type="button"
                  key={item.id || item.ruta}
                  className={[
                    'drive-item',
                    esCarpeta ? 'carpeta' : 'archivo',
                    esSeleccionado ? 'seleccionado' : '',
                    deshabilitado ? 'deshabilitado' : '',
                  ].filter(Boolean).join(' ')}
                  onClick={() => handleItemClick(item)}
                  onDoubleClick={() => handleItemDoubleClick(item)}
                  title={item.nombre}
                >
                  <span
                    className={`drive-icono ${
                      esCarpeta ? 'carpeta' : esPDF ? 'pdf' : esImagen ? 'imagen' : 'otro'
                    }`}
                  >
                    {esCarpeta ? (
                      <IconoCarpeta size={30} />
                    ) : esPDF ? (
                      <IconoDocumento size={30} />
                    ) : esImagen ? (
                      <IconoImagen size={30} />
                    ) : (
                      <IconoArchivo size={30} />
                    )}
                  </span>
                  <span className="drive-nombre">{item.nombre}</span>
                  {esSeleccionado && (
                    <span className="check" aria-hidden="true">
                      ✓
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <footer className="drive-footer">
        <div className="drive-info-seleccion">
          {archivoSeleccionado ? (
            <>
              <span className="info-icono">
                <IconoDocumento size={16} />
              </span>
              <strong>{archivoSeleccionado.nombre}</strong>
              <span className="pista">Doble clic para presentar</span>
            </>
          ) : (
            <span className="pista">
              {totalCarpetas} carpeta{totalCarpetas === 1 ? '' : 's'} · {totalArchivos} archivo
              {totalArchivos === 1 ? '' : 's'} · selecciona un PDF o imagen
            </span>
          )}
        </div>
        <button
          type="button"
          className="btn btn--primary btn--lg"
          disabled={!archivoSeleccionado}
          onClick={() => handlePresentar()}
        >
          <IconoPlay size={16} />
          Presentar documento
        </button>
      </footer>
    </div>
  );
}

/**
 * Indicador compacto del estado del motor de IA.
 * Permite detectar el problema antes de iniciar la presentación.
 */
function EstadoMotor({
  estadoPython,
  camaraLista,
  errorPython,
  onReintentarPython,
  onAbrirLog,
}) {
  const listo = estadoPython === 'listo';
  const esError = estadoPython === 'error';

  const texto = listo
    ? camaraLista
      ? 'IA lista · cámara activa'
      : 'IA lista · cámara sin señal'
    : esError
      ? 'IA detenida'
      : 'Iniciando motor de IA…';

  const clase = listo ? (camaraLista ? 'online' : 'pendiente') : esError ? 'error' : 'pendiente';

  return (
    <div className="estado-motor" title={errorPython || ''}>
      <span className={`status-badge ${clase}`}>
        <span className="dot" />
        {texto}
      </span>

      {esError && (
        <div className="estado-motor-acciones">
          {onReintentarPython && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={onReintentarPython}>
              <IconoRefrescar size={14} />
              Reintentar
            </button>
          )}
          {onAbrirLog && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={onAbrirLog}>
              <IconoRegistro size={14} />
              Registro
            </button>
          )}
        </div>
      )}
    </div>
  );
}
