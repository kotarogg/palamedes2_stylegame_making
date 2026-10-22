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
  // 修正R1：上端を y=148 に（開始時の予約29＋待機28でも画面内に収まる。Xは維持）
  origin: { 0: [20, 148], 1: [604, 148] },
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

/** 列に描く要素（アイコン・処理中の囲い・相殺の小爆発）。描画と画面内検査で同じ配置を使う */
export type StockDrawEntry =
  | { type: 'icon'; size: 'large' | 'small'; xd: boolean; alpha: number; x: number; y: number; w: number; h: number }
  | { type: 'frame'; x: number; y: number; w: number; h: number }
  | { type: 'burst'; size: 'large' | 'small'; frame: number; x: number; y: number; w: number; h: number };

export interface StockAfterimageState {
  kind: 'counter' | 'discard';
  lines: number;
  /** 発生からの経過ms */
  ms: number;
}

const ICON_PX = { large: 16, small: 8 } as const;
const BURST_PX = { large: 24, small: 12 } as const;
export const BURST_FRAMES = 4;
/** 処理中ブロックの囲い（9スライス 3px） */
export const FRAME_PAD = 3;

/**
 * 1列の配置：上＝処理中ブロックの残り（囲い付き）、その下にピンチ破棄の残像（フェード）、
 * 予約高さの下＝nextPending、その下に相殺の残像（XD顔＋小爆発）。
 */
export function stockColumnLayout(
  x0: number,
  blockY: number,
  pendingY: number,
  blockLines: number,
  pendingLines: number,
  afterimages: readonly StockAfterimageState[],
  cfg: StockViewConfig = DEFAULT_STOCK_VIEW,
): StockDrawEntry[] {
  const out: StockDrawEntry[] = [];
  const group = (lines: number, y0: number, xd: boolean, alpha: number) => {
    for (const ic of stockIcons(lines)) out.push({ type: 'icon', size: ic.size, xd, alpha, x: x0 + ic.x, y: y0 + ic.y, w: ICON_PX[ic.size], h: ICON_PX[ic.size] });
  };
  group(blockLines, blockY, false, 1);
  if (blockLines > 0) out.push({ type: 'frame', x: x0 - FRAME_PAD, y: blockY - FRAME_PAD, w: CELL_PX + 2 * FRAME_PAD, h: stockGroupHeight(blockLines) + 2 * FRAME_PAD });
  group(pendingLines, pendingY, false, 1);
  for (const a of afterimages) {
    if (a.ms < 0) continue;
    if (a.kind === 'discard') {
      if (a.ms < cfg.discardFadeMs) group(a.lines, blockY + stockGroupHeight(blockLines), false, 1 - a.ms / cfg.discardFadeMs);
      continue;
    }
    const fi = Math.floor(a.ms / cfg.counterFrameMs);
    if (fi >= BURST_FRAMES) continue;
    const y0 = pendingY + stockGroupHeight(pendingLines);
    group(a.lines, y0, true, 1);
    for (const ic of stockIcons(a.lines)) {
      const c = ICON_PX[ic.size] / 2;
      const b = BURST_PX[ic.size];
      out.push({ type: 'burst', size: ic.size, frame: fi, x: x0 + ic.x + c - b / 2, y: y0 + ic.y + c - b / 2, w: b, h: b });
    }
  }
  return out;
}
