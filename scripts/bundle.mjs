import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionDir = path.join(rootDir, 'extension');
const serverDir = path.join(rootDir, 'language-server');

const shared = {
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    sourcemap: false,
    external: ['vscode'],
};

await build({
    ...shared,
    entryPoints: {
        extension: path.join(extensionDir, 'src', 'extension.ts'),
        debugAdapter: path.join(extensionDir, 'src', 'debugAdapter.ts'),
    },
    outdir: path.join(extensionDir, 'out'),
    tsconfig: path.join(extensionDir, 'tsconfig.json'),
});

await build({
    ...shared,
    entryPoints: {
        server: path.join(serverDir, 'src', 'server.ts'),
    },
    outdir: path.join(serverDir, 'out'),
    tsconfig: path.join(serverDir, 'tsconfig.json'),
});
