import SidebarCamara from './SidebarCamara';
import VisorDiapositiva from './VisorDiapositiva';

export default function PantallaPresentacion({
  archivoSeleccionado,
  indiceDiapositiva,
  zoomActivo,
  posicion,
  ultimoGesto,
  wsConectado,
  gestosBloqueados,
  paginaActual,
  cargando,
  error,
  totalPaginas,
  onCambiarDocumento,
  backendBase,
  pythonListo,
  camaraLista,
  estadoPython,
  errorPython,
  cameraError,
  onReintentarPython,
  onAbrirLog,
}) {
  return (
    <div className="container">
      <SidebarCamara
        wsConectado={wsConectado}
        zoomActivo={zoomActivo}
        gestosBloqueados={gestosBloqueados}
        ultimoGesto={ultimoGesto}
        onCambiarDocumento={onCambiarDocumento}
        backendBase={backendBase}
        pythonListo={pythonListo}
        camaraLista={camaraLista}
        estadoPython={estadoPython}
        errorPython={errorPython}
        cameraError={cameraError}
        onReintentarPython={onReintentarPython}
        onAbrirLog={onAbrirLog}
      />

      <VisorDiapositiva
        paginaActual={paginaActual}
        cargando={cargando}
        error={error}
        zoomActivo={zoomActivo}
        posicion={posicion}
        indicePagina={indiceDiapositiva}
        totalPaginas={totalPaginas}
        nombreArchivo={archivoSeleccionado?.nombre || ''}
      />
    </div>
  );
}
