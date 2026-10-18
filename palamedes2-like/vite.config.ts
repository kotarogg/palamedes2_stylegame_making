import { defineConfig } from 'vitest/config';

// base './' で dist をどの階層に置いても相対パスで動かす
export default defineConfig({
  base: './',
  // minify なし：配布物を読めるままにし、共有先へのテキスト転送とSHA照合を容易にする
  build: { outDir: 'dist', assetsInlineLimit: 0, sourcemap: false, minify: false },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
