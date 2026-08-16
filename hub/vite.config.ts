import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// Source lives in hub/, built output lands in /app/ at the repo root, because
// GitHub Pages serves the tree as-is: /hub/ would hit Vite's source index.html
// and render a blank page. So the built app answers at wildcatraffle.com/app/.
export default defineConfig({
  base: '/app/',
  build: { outDir: '../app', emptyOutDir: true },
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
})
