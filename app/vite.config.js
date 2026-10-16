import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appDir = fileURLToPath(new URL('.', import.meta.url));

// Lee app/.env y app/.env.local sin dejar que un valor vacío heredado del shell gane.
function readEnvFiles() {
  const out = {};
  for (const name of ['.env', '.env.local']) {
    const file = path.join(appDir, name);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return out;
}

// En desarrollo, sirve /api/payroll con el mismo handler que usa Vercel.
// La key se lee de app/.env.local y solo existe en el proceso de Node.
function localApi() {
  return {
    name: 'nomina-zk-local-api',
    configureServer(server) {
      server.middlewares.use('/api/payroll', async (req, res) => {
        try {
          // import() nativo (no ssrLoadModule): así el polyfill de `process` del cliente no tapa process.env.
          const file = path.join(appDir, 'api/payroll.js');
          const { default: handler } = await import(`${pathToFileURL(file).href}?t=${fs.statSync(file).mtimeMs}`);
          await handler(req, res);
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    },
  };
}

export default defineConfig(() => {
  const env = readEnvFiles();
  for (const key of ['OPENROUTER_API_KEY', 'OPENROUTER_MODEL']) {
    if (env[key] && !process.env[key]) process.env[key] = env[key];
  }

  return {
    root: appDir,
    plugins: [
      nodePolyfills({
        include: ['buffer', 'process', 'util', 'stream', 'events', 'crypto', 'os', 'path'],
        globals: { Buffer: true, process: true, global: true },
      }),
      localApi(),
    ],
    build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
    // Pre-optimizar las deps que se cargan tarde evita que Vite recargue la página a mitad de un retiro.
    optimizeDeps: {
      include: ['snarkjs', 'circomlibjs', '@stellar/freighter-api', '@stellar/stellar-sdk'],
      esbuildOptions: { target: 'es2022' },
    },
  };
});
