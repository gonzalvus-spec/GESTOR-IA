import { useCallback, useEffect, useRef, useState } from 'react';

import { registrarEvento } from '../lib/registro';
import SelectorCamara from './SelectorCamara';
import {
  IconoAlerta,
  IconoAtras,
  IconoCamara,
  IconoMano,
  IconoRefrescar,
  IconoRegistro,
  IconoZoom,
} from './Iconos';

const ESTADOS_MOTOR = {
  iniciando: { texto: 'Iniciando…', clase: 'pendiente' },
  listo: { texto: 'Listo', clase: 'online' },
  error: { texto: 'Detenido', clase: 'error' },
};

const GESTOS = [
  { simbolo: '✌️✌️', texto: 'Activar / desactivar zoom' },
  { simbolo: '✌️ + 👍', texto: 'Mover a la derecha' },
  { simbolo: '✌️ + 🤙', texto: 'Mover a la izquierda' },
  { simbolo: '✌️ + ☝️', texto: 'Subir' },
  { simbolo: '✌️ + ✌️✌️', texto: 'Bajar' },
  { simbolo: '🤙', texto: 'Siguiente diapositiva' },
  { simbolo: '👍', texto: 'Diapositiva anterior' },
];

export default function SidebarCamara({
  wsConectado,
  zoomActivo,
  ultimoGesto,
  gestosBloqueados,
  onCambiarDocumento,
  backendBase = 'http://127.0.0.1:8000',
  pythonListo = false,
  camaraLista = false,
  estadoPython = 'iniciando',
  errorPython = null,
  cameraError = null,
  onReintentarPython,
  onAbrirLog,
}) {
  const [timestampFeed, setTimestampFeed] = useState(Date.now());
  const [errorVideo, setErrorVideo] = useState(false);
  const [camaraVista, setCamaraVista] = useState(false);
  const timerReintentoRef = useRef(null);
  const intentosRef = useRef(0);

  const reintentarFeed = useCallback(() => {
    if (timerReintentoRef.current) {
      clearTimeout(timerReintentoRef.current);
      timerReintentoRef.current = null;
    }
    setErrorVideo(false);
    setTimestampFeed(Date.now());
  }, []);

  // Si la cámara vuelve a estar lista, recargar el stream automáticamente.
  useEffect(() => {
    if (pythonListo && camaraLista) {
      intentosRef.current = 0;
      reintentarFeed();
    }
  }, [pythonListo, camaraLista, reintentarFeed]);

  // Limpieza del temporizador al desmontar la pantalla.
  useEffect(
    () => () => {
      if (timerReintentoRef.current) clearTimeout(timerReintentoRef.current);
    },
    []
  );

  // No ocultamos el vídeo al primer error: solo pedimos un stream nuevo con
  // espera creciente. Antes el recuadro se vaciaba 2 s en cada fallo y parecía
  // que "la cámara se cerraba sola".
  const handleImageError = useCallback(() => {
    setErrorVideo(true);
    registrarEvento(`video: error de /video_feed (intento ${intentosRef.current})`);
    if (timerReintentoRef.current) return;

    const espera = Math.min(8000, 1000 * 2 ** Math.min(intentosRef.current, 3));
    intentosRef.current += 1;
    timerReintentoRef.current = setTimeout(() => {
      timerReintentoRef.current = null;
      setTimestampFeed(Date.now());
    }, espera);
  }, []);

  const handleImageLoad = useCallback(() => {
    if (errorVideo) {
      registrarEvento('video: stream recuperado');
    }
    setErrorVideo(false);
    intentosRef.current = 0;
  }, [errorVideo]);

  // Una vez que la cámara ha dado imagen, mantenemos el <img> montado: así un
  // parpadeo de /health no vacía el recuadro (parecía que la cámara se cerraba).
  useEffect(() => {
    if (camaraLista) setCamaraVista(true);
  }, [camaraLista]);

  useEffect(() => {
    if (!pythonListo) setCamaraVista(false);
  }, [pythonListo]);

  const mostrarVideo = pythonListo && (camaraLista || camaraVista);
  const estadoMotor = ESTADOS_MOTOR[estadoPython] ?? ESTADOS_MOTOR.iniciando;
  const mensajeAyuda = errorPython || cameraError;

  const textoCamara = camaraLista
    ? 'Activa'
    : estadoPython === 'listo'
      ? 'Conectando…'
      : 'Sin señal';
  const claseCamara = camaraLista ? 'online' : estadoPython === 'listo' ? 'pendiente' : 'offline';

  const textoGestos = wsConectado ? 'Conectados' : pythonListo ? 'Reconectando…' : 'En espera';
  const claseGestos = wsConectado ? 'online' : pythonListo ? 'pendiente' : 'offline';

  return (
    <aside className="sidebar">
      <button type="button" className="btn btn--ghost btn-cambiar" onClick={onCambiarDocumento}>
        <IconoAtras size={16} />
        Cambiar documento
      </button>

      <section className="sidebar-seccion">
        <h3 className="sidebar-titulo">
          <IconoCamara size={15} className="sidebar-titulo-icono" />
          Cámara IA
        </h3>

        <div className="video-card">
          {mostrarVideo ? (
            <>
              <img
                key={timestampFeed}
                src={`${backendBase}/video_feed?t=${timestampFeed}`}
                alt="Vista de la cámara"
                onError={handleImageError}
                onLoad={handleImageLoad}
              />
              {errorVideo && <div className="video-overlay">Reconectando vídeo…</div>}
            </>
          ) : (
            <div className="video-placeholder" onClick={reintentarFeed}>
              <span className="video-placeholder-icono">
                <IconoCamara size={26} />
              </span>
              {estadoPython === 'error'
                ? 'Motor de IA detenido'
                : camaraLista
                  ? 'Conectando flujo de vídeo…'
                  : 'Iniciando cámara e IA…'}
            </div>
          )}
        </div>

        <SelectorCamara
          backendBase={backendBase}
          activo={pythonListo}
          camaraLista={camaraLista}
          cameraError={cameraError}
          etiqueta={false}
        />
      </section>

      <section className="sidebar-seccion">
        <h3 className="sidebar-titulo">Estado de la sesión</h3>

        <ul className="lista-estado">
          <li className={`fila-estado ${estadoMotor.clase}`}>
            <span className="dot" />
            <span className="fila-etiqueta">Motor de IA</span>
            <span className="fila-valor">{estadoMotor.texto}</span>
          </li>
          <li className={`fila-estado ${claseCamara}`}>
            <span className="dot" />
            <span className="fila-etiqueta">
              <IconoCamara size={14} /> Cámara
            </span>
            <span className="fila-valor">{textoCamara}</span>
          </li>
          <li className={`fila-estado ${claseGestos}`}>
            <span className="dot" />
            <span className="fila-etiqueta">
              <IconoMano size={14} /> Gestos
            </span>
            <span className="fila-valor">{textoGestos}</span>
          </li>
          <li className={`fila-estado ${zoomActivo ? 'zoom' : 'apagado'}`}>
            <span className="dot" />
            <span className="fila-etiqueta">
              <IconoZoom size={14} /> Zoom
            </span>
            <span className="fila-valor">{zoomActivo ? 'Activo' : 'Inactivo'}</span>
          </li>
        </ul>

        {gestosBloqueados && (
          <div className="aviso-bloqueo">
            <IconoAlerta size={15} />
            Gestos bloqueados temporalmente
          </div>
        )}
      </section>

      <section className="sidebar-seccion">
        <div className="gesto-actual">
          <span className="gesto-actual-etiqueta">Último gesto</span>
          <strong className="gesto-actual-valor">{ultimoGesto}</strong>
        </div>
      </section>

      {mensajeAyuda && (
        <div className="diagnostico">
          <p>
            <IconoAlerta size={15} />
            <span>{mensajeAyuda}</span>
          </p>
          <div className="diagnostico-acciones">
            {onReintentarPython && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={onReintentarPython}>
                <IconoRefrescar size={14} />
                Reiniciar motor
              </button>
            )}
            {onAbrirLog && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={onAbrirLog}>
                <IconoRegistro size={14} />
                Ver registro
              </button>
            )}
          </div>
        </div>
      )}

      <section className="leyenda-gestos">
        <h4>Gestos disponibles</h4>
        <ul>
          {GESTOS.map((gesto) => (
            <li key={`${gesto.simbolo}-${gesto.texto}`}>
              <span className="gesto-simbolo">{gesto.simbolo}</span>
              <span className="gesto-texto">{gesto.texto}</span>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}
