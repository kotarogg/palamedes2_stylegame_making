import { execSync } from 'node:child_process';
import { defineConfig } from 'vitest/config';

// V320-MEASURE-01：--mode measure で計測用テストビルド（出力 dist-measure/）。通常ビルドは従来どおり dist/
const commit = (() => {
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
})();

// base './' で dist をどの階層に置いても相対パスで動かす
// 第3版：共有ドライブのコネクタは1回に送れる量に限りがあるため、配布JSを圧縮し、ソースのフォルダ単位で分割する。
// keepNames でクラス名・関数名を保持（エラー表示・自動検証で画面名を読むため）
export default defineConfig(({ mode }) => ({
  base: './',
  esbuild: { keepNames: true },
  define: {
    // 単体テスト（mode＝test）でも計測の接続を検査できるよう true。記録器を渡さない限り動作は通常と同じ
    __MEASURE_BUILD__: JSON.stringify(mode === 'measure' || mode === 'test'),
    __BUILD_COMMIT__: JSON.stringify(commit),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  build: {
    outDir: mode === 'measure' ? 'dist-measure' : 'dist',
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
}));
