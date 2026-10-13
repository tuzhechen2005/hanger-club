import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Relative base so the static build works from any path on Sites.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1200 },
})
