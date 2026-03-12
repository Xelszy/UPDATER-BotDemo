
const esbuild = require('esbuild');
const fs = require('fs-extra');

async function build() {
    console.log('🧹 Cleaning dist...');
    await fs.emptyDir('dist'); // Ensure clean build

    console.log('📦 Bundling Renderer...');
    await esbuild.build({
        entryPoints: ['src/renderer/index.tsx'],
        bundle: true,
        platform: 'browser',
        target: ['chrome114'], // Match Electron version approximately
        outfile: 'dist/renderer.js',
        sourcemap: true,
        format: 'cjs', // For simplicity in Electron without complex preload
        loader: { '.tsx': 'tsx', '.ts': 'ts' },
    });

    // Copy HTML
    await fs.copy('src/renderer/index.html', 'dist/index.html');

    console.log('✅ Build Complete.');
}

build().catch(() => process.exit(1));
