import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [
    tailwindcss(),
    tanstackStart({
      // SPA output only: dist/client, no SSR server. Served as static
      // [assets] from the Cloudflare worker (run_worker_first for /v1/*).
      spa: { enabled: true },
    }),
  ],
})
