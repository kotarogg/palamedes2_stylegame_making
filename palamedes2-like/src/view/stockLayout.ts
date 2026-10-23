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
  // 修正R1：上端を y=148 に（開始時の予約29＋待機28でも画面内に収まる）。
  // v3.1.0：中央エリア（x264〜376）の左右へ移動（PM初期配置基準 P1(272,148)、P2(352,148)）。盤面・キャラ・手役領域は動かさない
  origin: { 0: [272, 148], 1: [352, 148] },
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

/**
 * 列に描く要素。vanish＝表示専用の消失対象（相殺の XD 顔・ピンチ破棄のフェード）と小爆発。
 * 消失対象は有効なストックではない（数量・相殺・消化に含めない）ので、通常のストックより前面に描く。
 */
export type StockDrawEntry =
  | { type: 'icon'; size: 'large' | 'small'; xd: boolean; alpha: number; vanish: boolean; x: number; y: number; w: number; h: number }
  | { type: 'frame'; x: number; y: number; w: number; h: number }
  | { type: 'burst'; size: 'large' | 'small'; frame: number; x: number; y: number; w: number; h: number };

/**
 * 消失演出1件（修正R5）。y＝発生時に確定した群の上端（論理px）。後から増減した待機群の末尾へは配置し直さない。
 * 相殺は待機群に、ピンチ破棄は現ブロックに所属し、所属する群の移動（上詰め）にだけ追従する。
 */
export interface StockAfterimageState {
  kind: 'counter' | 'discard';
  lines: number;
  /** 発生からの経過ms */
  ms: number;
  y: number;
}

const ICON_PX = { large: 16, small: 8 } as const;
const BURST_PX = { large: 24, small: 12 } as const;
export const BURST_FRAMES = 4;
/** 処理中ブロックの囲い（9スライス 3px） */
export const FRAME_PAD = 3;

/** 消失演出の長さ（相殺＝4コマ×40ms、破棄＝フェード） */
export function afterimageDurationMs(kind: 'counter' | 'discard', cfg: StockViewConfig = DEFAULT_STOCK_VIEW): number {
  return kind === 'counter' ? cfg.counterFrameMs * BURST_FRAMES : cfg.discardFadeMs;
}

/** 相殺の消失対象の位置：相殺後に残った待機群の下（待機群の上端からの相対px）。相殺の時点で確定する */
export const counterAnchorOffset = (pendingAfter: number): number => stockGroupHeight(pendingAfter);
/** ピンチ破棄の消失対象の位置：破棄後に残った現ブロックの下（ブロックの上端からの相対px） */
export const discardAnchorOffset = (blockAfter: number): number => stockGroupHeight(blockAfter);

/**
 * 1列の配置：処理中ブロックの残り（囲い付き）→ nextPending → 消失演出（記録した位置、発生順。前面）。
 * 呼び出し側は、通常ストックより消失演出を前面へ（同じ消失演出の中は発生順に）描く。
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
  const group = (lines: number, y0: number, xd: boolean, alpha: number, vanish: boolean) => {
    for (const ic of stockIcons(lines)) out.push({ type: 'icon', size: ic.size, xd, alpha, vanish, x: x0 + ic.x, y: y0 + ic.y, w: ICON_PX[ic.size], h: ICON_PX[ic.size] });
  };
  group(blockLines, blockY, false, 1, false);
  if (blockLines > 0) out.push({ type: 'frame', x: x0 - FRAME_PAD, y: blockY - FRAME_PAD, w: CELL_PX + 2 * FRAME_PAD, h: stockGroupHeight(blockLines) + 2 * FRAME_PAD });
  group(pendingLines, pendingY, false, 1, false);
  for (const a of afterimages) {
    if (a.ms < 0 || a.ms >= afterimageDurationMs(a.kind, cfg)) continue;
    if (a.kind === 'discard') {
      group(a.lines, a.y, false, 1 - a.ms / cfg.discardFadeMs, true);
      continue;
    }
    const fi = Math.floor(a.ms / cfg.counterFrameMs);
    group(a.lines, a.y, true, 1, true);
    for (const ic of stockIcons(a.lines)) {
      const c = ICON_PX[ic.size] / 2;
      const b = BURST_PX[ic.size];
      out.push({ type: 'burst', size: ic.size, frame: fi, x: x0 + ic.x + c - b / 2, y: a.y + ic.y + c - b / 2, w: b, h: b });
    }
  }
  return out;
}
