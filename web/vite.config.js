import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Header mimetici: la Live API del Ministero (carburanti.mise.gov.it) risponde 403
// alle chiamate senza Origin/Referer del proprio portale. Il proxy li riscrive, così
// il browser interroga il Ministero senza incorrere in blocchi CORS.
const MIMIT_ORIGIN = 'https://carburanti.mise.gov.it'

const MIMIT_PROXY_HEADERS = {
  Origin: MIMIT_ORIGIN,
  Referer: `${MIMIT_ORIGIN}/ospzSearch/zona`,
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // /api/mimit/ospzApi/search/zone -> https://carburanti.mise.gov.it/ospzApi/search/zone
      '/api/mimit': {
        target: MIMIT_ORIGIN,
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/api\/mimit/, ''),
        headers: MIMIT_PROXY_HEADERS,
      },
    },
  },
  preview: {
    proxy: {
      '/api/mimit': {
        target: MIMIT_ORIGIN,
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/api\/mimit/, ''),
        headers: MIMIT_PROXY_HEADERS,
      },
    },
  },
})
