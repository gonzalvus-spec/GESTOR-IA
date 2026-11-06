/**
 * Iconos SVG delgados (trazo) para que la interfaz no dependa de emojis.
 * Todos heredan el color con `currentColor` y aceptan tamaño por props.
 */

function Base({ children, size = 18, className = '', ...resto }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
      {...resto}
    >
      {children}
    </svg>
  );
}

export function IconoLogo({ size = 22, className = '' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <rect x="2.5" y="4" width="19" height="12.5" rx="2.5" fill="currentColor" opacity="0.18" />
      <rect
        x="2.5"
        y="4"
        width="19"
        height="12.5"
        rx="2.5"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path d="M10 8.2v4.1l3.6-2.05L10 8.2Z" fill="currentColor" />
      <path
        d="M8 20h8M12 16.5V20"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconoCarpeta({ size = 20, className = '' }) {
  return (
    <Base size={size} className={className}>
      <path d="M3 7.5A2 2 0 0 1 5 5.5h3.6a2 2 0 0 1 1.5.7l1 1.3H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9Z" />
    </Base>
  );
}

export function IconoDocumento({ size = 20, className = '' }) {
  return (
    <Base size={size} className={className}>
      <path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5l-5-5Z" />
      <path d="M14 3.5v5h5M9 13h6M9 16.5h4" />
    </Base>
  );
}

export function IconoImagen({ size = 20, className = '' }) {
  return (
    <Base size={size} className={className}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m4.5 17 4.2-4.2a1.8 1.8 0 0 1 2.5 0l2 2M14 15.5l1.6-1.6a1.8 1.8 0 0 1 2.5 0l2.4 2.4" />
    </Base>
  );
}

export function IconoArchivo({ size = 20, className = '' }) {
  return (
    <Base size={size} className={className}>
      <path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5l-5-5Z" />
      <path d="M14 3.5v5h5" />
    </Base>
  );
}

export function IconoAtras({ size = 18, className = '' }) {
  return (
    <Base size={size} className={className}>
      <path d="M15 5l-7 7 7 7" />
    </Base>
  );
}

export function IconoInicio({ size = 18, className = '' }) {
  return (
    <Base size={size} className={className}>
      <path d="m4 10.5 8-6.5 8 6.5" />
      <path d="M6.5 9.5V19a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5V9.5" />
    </Base>
  );
}

export function IconoBuscar({ size = 16, className = '' }) {
  return (
    <Base size={size} className={className}>
      <circle cx="11" cy="11" r="6.2" />
      <path d="m16 16 4 4" />
    </Base>
  );
}

export function IconoPlay({ size = 18, className = '' }) {
  return (
    <Base size={size} className={className}>
      <path d="M8 5.5v13l10-6.5-10-6.5Z" fill="currentColor" stroke="none" />
    </Base>
  );
}

export function IconoCamara({ size = 18, className = '' }) {
  return (
    <Base size={size} className={className}>
      <rect x="2.8" y="6.5" width="12.4" height="11" rx="2.4" />
      <path d="m15.2 11 5-2.7v7.4l-5-2.7" />
    </Base>
  );
}

export function IconoMano({ size = 18, className = '' }) {
  return (
    <Base size={size} className={className}>
      <path d="M9 11V5.6a1.6 1.6 0 0 1 3.2 0V11" />
      <path d="M12.2 10.6V4.6a1.6 1.6 0 0 1 3.2 0v6.6" />
      <path d="M15.4 11V7.2a1.6 1.6 0 0 1 3.2 0V14a7 7 0 0 1-7 7h-1a5 5 0 0 1-4.3-2.5L3.8 14a1.7 1.7 0 0 1 2.9-1.7L9 15" />
    </Base>
  );
}

export function IconoZoom({ size = 18, className = '' }) {
  return (
    <Base size={size} className={className}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M11 8.5v5M8.5 11h5M16 16l4.5 4.5" />
    </Base>
  );
}

export function IconoRefrescar({ size = 16, className = '' }) {
  return (
    <Base size={size} className={className}>
      <path d="M20 11.5A8 8 0 1 0 17.6 17" />
      <path d="M20 5.5v6h-6" />
    </Base>
  );
}

export function IconoRegistro({ size = 16, className = '' }) {
  return (
    <Base size={size} className={className}>
      <path d="M5.5 3.5h9L19 8v12.5H5.5V3.5Z" />
      <path d="M14.5 3.5V8H19M8.5 12h7M8.5 15.5h5" />
    </Base>
  );
}

export function IconoChevron({ size = 14, className = '' }) {
  return (
    <Base size={size} className={className}>
      <path d="m9 5 7 7-7 7" />
    </Base>
  );
}

export function IconoAlerta({ size = 16, className = '' }) {
  return (
    <Base size={size} className={className}>
      <path d="M12 4 2.8 20h18.4L12 4Z" />
      <path d="M12 9.5v4.5M12 17h.01" />
    </Base>
  );
}
