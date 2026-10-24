#!/usr/bin/env node
/**
 * Bundles the Node entry points used by `server/index.mjs`:
 *   build/core.js    -> runDiagnostics + defaults (shared with the edge build)
 *   build/server.js  -> NodeTransport
 *
 * esbuild is used instead of tsc because the shared core is written as ESM
 * TypeScript and the server entry is plain JS; one bundling step keeps both
 * halves in sync with the exact same source the Workers build compiles.
 */
import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'build');

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: false,
  logLevel: 'info',
  external: ['node:*'],
};

await build({
  ...shared,
  entryPoints: [join(ROOT, 'shared/core/diagnostics.ts')],
  outfile: join(OUT, 'core.js'),
});

await build({
  ...shared,
  entryPoints: [join(ROOT, 'shared/transport/nodetransport.ts')],
  outfile: join(OUT, 'server.js'),
});

console.log('server bundle written to build/');
