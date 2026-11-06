import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Evitar que Vite obscurezca errores de Tauri
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // 3. Decirle a Vite que ignore la carpeta src-tauri
      ignored: ['**/src-tauri/**'],
    },
  },
});