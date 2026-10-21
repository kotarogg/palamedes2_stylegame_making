import { defineConfig } from 'vitest/config';

// base './' で dist をどの階層に置いても相対パスで動かす
// 第3版：共有ドライブのコネクタは1回に送れる量に限りがあるため、配布JSを圧縮し、ソースのフォルダ単位で分割する。
// keepNames でクラス名・関数名を保持（エラー表示・自動検証で画面名を読むため）
export default defineConfig({
  base: './',
  esbuild: { keepNames: true },
  build: {
    outDir: 'dist',
    assetsInlineLimit: 0,
    sourcemap: false,
    minify: 'esbuild',
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          const m = /\/src\/(core|view|audio|input|ui)\//.exec(id);
          return m ? m[1] : undefined;
        },
      },
    },
  },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
