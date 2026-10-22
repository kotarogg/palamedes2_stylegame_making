// 表示倍率（第3版 第17章 B6）：論理640×360を「実画素」の整数倍で表示する。
// 固定N倍：キャンバスの描画バッファ 640N×360N、CSS寸法 (640N/DPR)×(360N/DPR)。DPR 1.25 等でもドットが均等になる。
// 「収まる最大」は別の選択肢。収まらない固定倍率は選べない（黙って別倍率へ置き換えない）。
// 現在の固定倍率が収まらなくなった場合は、明示的に「収まる最大」へ切り替えて通知する。スクロールは出さない。
// 1倍（実画素）すら収まらない場合だけ緊急縮小し、通知を出す。
export const LOGICAL_W = 640;
export const LOGICAL_H = 360;
/** 固定倍率の選択肢は1〜4倍（第3版 修正R4。「収まる最大」は別項目） */
export const MAX_FIXED_SCALE = 4;

/** CSSピクセルの丸め誤差を許す幅 */
const EPS = 1e-6;

/** 実画素でN倍が画面（CSSピクセル vw×vh、DPR）に収まるか */
export function scaleFits(n: number, vw: number, vh: number, dpr: number): boolean {
  return (LOGICAL_W * n) / dpr <= vw + EPS && (LOGICAL_H * n) / dpr <= vh + EPS;
}

/** 収まる最大の実画素整数倍（1倍も収まらなければ 0） */
export function maxFitScale(vw: number, vh: number, dpr: number): number {
  let n = 0;
  while (n < 64 && scaleFits(n + 1, vw, vh, dpr)) n++;
  return n;
}

/** 選べる固定倍率（収まるものだけ true） */
export function fixedScaleChoices(vw: number, vh: number, dpr: number, max = MAX_FIXED_SCALE): { n: number; enabled: boolean }[] {
  return Array.from({ length: max }, (_, i) => ({ n: i + 1, enabled: scaleFits(i + 1, vw, vh, dpr) }));
}

export interface ScaleResult {
  /** fixed＝指定倍率、fit＝収まる最大、emergency＝1倍も収まらず縮小 */
  mode: 'fixed' | 'fit' | 'emergency';
  /** 描画バッファの倍率（実画素）。緊急縮小では1 */
  n: number;
  bufferW: number;
  bufferH: number;
  cssW: number;
  cssH: number;
  /** 指定の固定倍率が収まらず「収まる最大」へ切り替えた（呼出し側が設定を書き換えて通知する） */
  switchedToFit: boolean;
}

/** want：0＝収まる最大、1〜＝固定倍率 */
export function resolveScale(want: number, vw: number, vh: number, dpr: number): ScaleResult {
  const d = dpr > 0 ? dpr : 1;
  const fit = maxFitScale(vw, vh, d);
  if (fit < 1) {
    // 実画素1倍も収まらない：縦横比を保って縮小（ドットは不均等になるため通知する）
    const k = Math.min(vw / LOGICAL_W, vh / LOGICAL_H);
    return { mode: 'emergency', n: 1, bufferW: LOGICAL_W, bufferH: LOGICAL_H, cssW: LOGICAL_W * k, cssH: LOGICAL_H * k, switchedToFit: want !== 0 };
  }
  const fixedOk = want > 0 && scaleFits(want, vw, vh, d);
  const n = fixedOk ? want : fit;
  return {
    mode: fixedOk ? 'fixed' : 'fit',
    n,
    bufferW: LOGICAL_W * n,
    bufferH: LOGICAL_H * n,
    cssW: (LOGICAL_W * n) / d,
    cssH: (LOGICAL_H * n) / d,
    switchedToFit: want > 0 && !fixedOk,
  };
}
