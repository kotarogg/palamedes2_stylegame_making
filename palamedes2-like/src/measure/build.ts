// V320-MEASURE-01 計測用テストビルドの判定とビルド情報。
// 通常ビルド（npm run build）では __MEASURE_BUILD__ が false になり、計測の記録器・画面は作られない（読み込まれても動かない）。
// 計測用ビルドは npm run build:measure（vite --mode measure、出力 dist-measure/）。
declare const __MEASURE_BUILD__: boolean | undefined;
declare const __BUILD_COMMIT__: string | undefined;
declare const __BUILD_TIME__: string | undefined;

export const MEASURE_BUILD: boolean = typeof __MEASURE_BUILD__ !== 'undefined' && __MEASURE_BUILD__ === true;

declare const __RELEASE_BUILD__: boolean | undefined;
/** 公開用ビルド（npm run build:release＝vite --mode release、出力 dist-release/）。自動検証用のフックを含めない */
export const RELEASE_BUILD: boolean = typeof __RELEASE_BUILD__ !== 'undefined' && __RELEASE_BUILD__ === true;

declare const __RELEASE_LABEL__: string | undefined;
/** 版の表示名（公開用ビルドは .env.release の VITE_RELEASE_LABEL、それ以外は「開発ビルド」） */
export const RELEASE_LABEL: string = typeof __RELEASE_LABEL__ !== 'undefined' && __RELEASE_LABEL__ ? __RELEASE_LABEL__ : 'v3.2.0 開発ビルド';

export const BUILD_INFO = {
  mode: MEASURE_BUILD ? 'measure' : RELEASE_BUILD ? 'release' : 'standard',
  commit: typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : 'unknown',
  builtAt: typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : 'unknown',
};
