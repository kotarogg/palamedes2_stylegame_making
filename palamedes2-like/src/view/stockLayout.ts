// 受攻撃ストックの表示配置（第3版 第10章）。DOM非依存の純粋関数。
// 大アイコン＝5ライン（16×16）、小アイコン＝1ライン（8×8、16×16の区画に左上→右上→左下→右下の2×2）。各群とも大を先に置く。
// 上の群＝処理中ブロック（予約高さはブロック終了まで維持）、下の群＝nextPending（予約領域の下に固定）。群を混ぜない。

export interface StockViewConfig {
  /** 列の左上（論理px）。P1は盤面枠の左、P2は右 */
  origin: Record<0 | 1, [number, number]>;
  /** 処理中ブロックの予約領域と待機群の間隔 */
  groupGapPx: number;
  /** 処理中ブロック枠の点滅（素材の推奨 240ms） */
  blinkMs: number;
  /** ブロック終了時の待機群の上詰め */
  slideMs: number;
  /** 相殺：XD顔＋小爆発 4コマ×40ms（減算は即時。残像） */
  counterFrameMs: number;
  /** ピンチ破棄：フェードして消える */
  discardFadeMs: number;
}

export const DEFAULT_STOCK_VIEW: StockViewConfig = {
  origin: { 0: [20, 228], 1: [604, 228] },
  groupGapPx: 6,
  blinkMs: 240,
  slideMs: 120,
  counterFrameMs: 40,
  discardFadeMs: 120,
};

export const LARGE_LINES = 5;
export const CELL_PX = 16;

export interface StockIcon {
  size: 'large' | 'small';
  /** 群の左上からの相対位置 */
  x: number;
  y: number;
}

/** 1群のアイコン配置（大を先に。小は最後の16×16区画へ 左上→右上→左下→右下） */
export function stockIcons(lines: number): StockIcon[] {
  const n = Math.max(0, Math.floor(lines));
  const large = Math.floor(n / LARGE_LINES);
  const small = n % LARGE_LINES;
  const out: StockIcon[] = [];
  for (let i = 0; i < large; i++) out.push({ size: 'large', x: 0, y: CELL_PX * i });
  const sy = CELL_PX * large;
  for (let i = 0; i < small; i++) out.push({ size: 'small', x: (i % 2) * 8, y: sy + Math.floor(i / 2) * 8 });
  return out;
}

/** 1群の高さ（px） */
export function stockGroupHeight(lines: number): number {
  const n = Math.max(0, Math.floor(lines));
  return CELL_PX * (Math.floor(n / LARGE_LINES) + (n % LARGE_LINES > 0 ? 1 : 0));
}

/**
 * 待機群（nextPending）の上端の相対Y。処理中ブロックがある間は予約高さ＋間隔の下に固定し、
 * ブロック終了後は slideMs かけて上端へ上詰めする（ms は終了からの経過。終了していなければ null）。
 */
export function pendingGroupY(reservedPx: number | null, slideFromPx: number | null, sinceEndMs: number | null, cfg: StockViewConfig = DEFAULT_STOCK_VIEW): number {
  if (reservedPx !== null) return reservedPx > 0 ? reservedPx + cfg.groupGapPx : 0;
  if (slideFromPx === null || sinceEndMs === null) return 0;
  const u = Math.max(0, Math.min(1, sinceEndMs / cfg.slideMs));
  return Math.round(slideFromPx * (1 - u));
}
