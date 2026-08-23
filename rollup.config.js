import resolve from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import typescript from '@rollup/plugin-typescript'
import peerDepsExternal from 'rollup-plugin-peer-deps-external'
import dts from 'rollup-plugin-dts'
import terser from '@rollup/plugin-terser'
import { createRequire } from 'node:module'

const pkgVersion = createRequire(import.meta.url)('./package.json').version

// Stamp the real package version wherever __NOHMO_VERSION__ appears. A literal would
// drift from package.json on every release. Applied to EVERY bundle, not just the
// server one, because each SDK now reports its own version on the event envelope.
const versionPlugin = {
  name: 'nohmo-version',
  transform(code) {
    return code.includes('__NOHMO_VERSION__')
      ? { code: code.replace(/__NOHMO_VERSION__/g, pkgVersion), map: null }
      : null
  },
}

// Kept external so they stay real requires in the bundle rather than being inlined or
// shimmed. Both the bare and node:-prefixed forms, since either can appear in an import.
const NODE_BUILTINS = [
  'http', 'https', 'os', 'url', 'zlib', 'buffer', 'crypto',
  'node:http', 'node:https', 'node:os', 'node:url', 'node:zlib', 'node:buffer', 'node:crypto',
]

export default [
  {
    input: 'src/index.ts',
    output: [
      {
        file: 'dist/index.cjs',
        format: 'cjs',
        sourcemap: true,
        banner: "'use client';",
      },
      {
        file: 'dist/index.esm.js',
        format: 'esm',
        sourcemap: true,
        banner: "'use client';",
      },
    ],
    plugins: [
      peerDepsExternal(),
      resolve({ browser: true }),
      commonjs(),
      typescript({ tsconfig: './tsconfig.build.json' }),
      versionPlugin,
    ],
    external: ['react', 'react-dom'],
  },
  {
    input: 'src/index.ts',
    output: [{ file: 'dist/index.d.ts', format: 'esm' }],
    plugins: [dts()],
    external: ['react', 'react-dom'],
  },
  // React Native entry point
  {
    input: 'src/react-native/index.ts',
    output: [
      {
        file: 'dist/react-native.cjs',
        format: 'cjs',
        sourcemap: true,
      },
      {
        file: 'dist/react-native.esm.js',
        format: 'esm',
        sourcemap: true,
      },
    ],
    plugins: [
      peerDepsExternal(),
      resolve(),
      commonjs(),
      typescript({ tsconfig: './tsconfig.build.json' }),
      versionPlugin,
    ],
    external: [
      'react',
      'react-native',
      '@react-native-async-storage/async-storage',
    ],
  },
  {
    input: 'src/react-native/index.ts',
    output: [{ file: 'dist/react-native.d.ts', format: 'esm' }],
    plugins: [dts()],
    external: ['react', 'react-native', '@react-native-async-storage/async-storage'],
  },
  // Autocapture runtime (used by the Babel plugin at runtime)
  {
    input: 'src/react-native/autocapture.ts',
    output: [
      { file: 'dist/autocapture.cjs', format: 'cjs', sourcemap: true },
      { file: 'dist/autocapture.esm.js', format: 'esm', sourcemap: true },
    ],
    plugins: [
      peerDepsExternal(),
      resolve(),
      commonjs(),
      typescript({ tsconfig: './tsconfig.build.json' }),
      versionPlugin,
    ],
    external: ['react', 'react-native'],
  },
  {
    input: 'src/react-native/autocapture.ts',
    output: [{ file: 'dist/autocapture.d.ts', format: 'esm' }],
    plugins: [dts()],
    external: ['react', 'react-native'],
  },
  // Node server entry point (`nohmo/server`).
  //
  // Deliberately NOT built with resolve({ browser: true }) like the entries above — that
  // would swap node: built-ins for browser shims. Node built-ins are external so they
  // stay real requires, and no 'use client' banner is emitted: this never reaches a
  // bundler that cares.
  {
    input: 'src/server/index.ts',
    output: [
      // .cjs, NOT .cjs.js. package.json sets "type": "module", so Node treats every .js
      // file as ESM — a CommonJS bundle named .js fails to load with "require is not
      // defined in ES module scope". The existing dist/*.cjs.js entries have exactly that
      // bug today; do not copy the pattern here. Express apps are frequently CommonJS,
      // so this entry in particular has to be require()-able.
      { file: 'dist/server.cjs', format: 'cjs', sourcemap: true, exports: 'named' },
      { file: 'dist/server.esm.js', format: 'esm', sourcemap: true },
    ],
    plugins: [
      resolve({ preferBuiltins: true }),
      commonjs(),
      typescript({ tsconfig: './tsconfig.build.json' }),
      versionPlugin,
    ],
    external: NODE_BUILTINS,
  },
  {
    input: 'src/server/index.ts',
    output: [{ file: 'dist/server.d.ts', format: 'esm' }],
    plugins: [dts()],
    external: NODE_BUILTINS,
  },
  {
    input: 'src/browser.ts',
    output: {
      file: 'dist/n.min.js',
      format: 'iife',
      name: 'NohmoScript',
    },
    plugins: [
      resolve({ browser: true }),
      commonjs(),
      typescript({ tsconfig: './tsconfig.build.json' }),
      terser(),
      versionPlugin,
    ],
  },
]
