import { convertFileSrc } from '@tauri-apps/api/core';

export function obtenerNombreArchivo(ruta) {
  if (!ruta) return '';
  return ruta.split('\\').pop().split('/').pop();
}

export function obtenerExtension(ruta) {
  const nombre = obtenerNombreArchivo(ruta);
  const punto = nombre.lastIndexOf('.');
  return punto >= 0 ? nombre.slice(punto + 1).toLowerCase() : '';
}

export function esPDF(ruta) {
  return obtenerExtension(ruta) === 'pdf';
}

export function esImagen(ruta) {
  return ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(obtenerExtension(ruta));
}

export function rutaAUrlTauri(ruta) {
  if (!ruta) return '';
  return convertFileSrc(ruta);
}