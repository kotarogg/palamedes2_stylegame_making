// 連鎖HUDの縦配置（V320-FIX-03 で縦帯化、V320-FIX-04 で見出しを PM検収合格の見出しPNGへ置換）。
// MODE1 の役連鎖と打上連鎖を盤面外側の縦帯（1P x0〜48、2P x592〜640）へまとめ、全行の中心を帯の中心線（x24／x616）に揃える。
// 座標・寸法はここだけで持ち、描画（gameView）・教材の注目枠（demo/stages）・検査が共通に参照する。640×360 の論理px、左上原点。
// 見出しPNGは原寸1倍。左上＝旧文字セル左上 − body_origin（透明余白込みの画像中心では決めない）。
import type { PlayerId } from '../core/types';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 見出しPNG（v320_fix04_assets.json と同じ値。検査で JSON と照合する） */
export const HUD_LABELS = {
  label_role_main: { canvas: [44, 36], body_origin: [6, 1], visible_xywh: [2, 1, 38, 34] },
  label_role_chain_sub: { canvas: [44, 20], body_origin: [6, 2], visible_xywh: [2, 1, 37, 18] },
  label_launch_main: { canvas: [44, 20], body_origin: [6, 2], visible_xywh: [2, 1, 37, 18] },
  label_launch_chain_sub: { canvas: [44, 20], body_origin: [6, 2], visible_xywh: [2, 1, 37, 18] },
  label_score_main: { canvas: [44, 20], body_origin: [6, 2], visible_xywh: [2, 1, 38, 18] },
  label_score_rate: { canvas: [44, 20], body_origin: [6, 2], visible_xywh: [2, 1, 37, 18] },
  label_attack: { canvas: [44, 20], body_origin: [6, 2], visible_xywh: [2, 1, 37, 18] },
  label_cancel: { canvas: [44, 20], body_origin: [6, 2], visible_xywh: [2, 1, 38, 18] },
} as const;
export type HudLabelId = keyof typeof HUD_LABELS;

/** 見出しPNGの配置：画像左上（x,y）・キャンバス寸法（w,h）と、描画画素の外接 visible */
export interface LabelRow extends Box {
  id: HudLabelId;
  visible: Box;
}

/** S12 数字の行：中心x・上端y・高さ上限・幅上限（既存の等比収め） */
export interface DigitRow {
  cx: number;
  y: number;
  h: number;
  maxW: number;
}

export interface ChainHudLayout {
  /** 縦帯 */
  strip: Box;
  cx: number;
  /** 役・連鎖（役連鎖） */
  roleTitle: LabelRow;
  roleSub: LabelRow;
  roleDigits: DigitRow;
  /** 攻撃加算「＋○」（対戦のみ。上端・16px） */
  plus: { cx: number; y: number; size: number };
  /** 打上・連鎖（打上連鎖） */
  streakTitle: LabelRow;
  streakSub: LabelRow;
  streakDigits: DigitRow;
}

const STRIP = { 0: { x: 0, w: 48 }, 1: { x: 592, w: 48 } } as const;

export const CHAIN_HUD = {
  /** 旧文字セルの左上（1P。2P は +592）。PNG はここから body_origin を引いた位置へ置く */
  rows: {
    roleTitle: { cellX: 8, y: 130, id: 'label_role_main' },
    roleSub: { cellX: 8, y: 168, id: 'label_role_chain_sub' },
    roleDigits: { y: 190, h: 34, maxW: 46 },
    plus: { y: 228, size: 16 },
    streakTitle: { cellX: 8, y: 258, id: 'label_launch_main' },
    streakSub: { cellX: 8, y: 278, id: 'label_launch_chain_sub' },
    streakDigits: { y: 300, h: 17, maxW: 46 },
  },
  /**
   * SINGLE の得点倍率（V320-FIX-04 第4.3節）：1P の合成領域（24,64,48,56）。
   * 得点PNGは領域内(2,0)、倍率PNGは(2,18)、倍率数字（score_rate_numeric_sheet、1倍）は上端 y36・幅48の中央
   */
  singleRate: { area: { x: 24, y: 64, w: 48, h: 56 }, score: { dx: 2, dy: 0, id: 'label_score_main' }, rate: { dx: 2, dy: 18, id: 'label_score_rate' }, digitsTop: 36 },
  /** 打上連鎖切り予約中の揺れ（第4.2節）：600ms 周期の最初の200ms、約50msごとに次のオフセット */
  shake: { periodMs: 600, activeMs: 200, stepMs: 50, offsets: [[0, 0], [-1, 0], [1, -1], [0, 1]] as const },
} as const;

/** 見出しPNGを旧文字セル左上（cellX,cellY）へ body_origin で合わせた配置 */
export function labelAt(id: HudLabelId, cellX: number, cellY: number): LabelRow {
  const d = HUD_LABELS[id];
  const x = cellX - d.body_origin[0];
  const y = cellY - d.body_origin[1];
  return { id, x, y, w: d.canvas[0], h: d.canvas[1], visible: { x: x + d.visible_xywh[0], y: y + d.visible_xywh[1], w: d.visible_xywh[2], h: d.visible_xywh[3] } };
}

export function chainHudLayout(p: PlayerId): ChainHudLayout {
  const s = STRIP[p];
  const cx = s.x + s.w / 2;
  const r = CHAIN_HUD.rows;
  const lab = (row: { cellX: number; y: number; id: HudLabelId }) => labelAt(row.id, s.x + row.cellX, row.y);
  const roleTitle = lab(r.roleTitle);
  return {
    strip: { x: s.x, y: roleTitle.y, w: s.w, h: r.streakDigits.y + r.streakDigits.h - roleTitle.y },
    cx,
    roleTitle,
    roleSub: lab(r.roleSub),
    roleDigits: { cx, y: r.roleDigits.y, h: r.roleDigits.h, maxW: r.roleDigits.maxW },
    plus: { cx, y: r.plus.y, size: r.plus.size },
    streakTitle: lab(r.streakTitle),
    streakSub: lab(r.streakSub),
    streakDigits: { cx, y: r.streakDigits.y, h: r.streakDigits.h, maxW: r.streakDigits.maxW },
  };
}

const union = (bs: Box[]): Box => {
  const x0 = Math.min(...bs.map((b) => b.x));
  const y0 = Math.min(...bs.map((b) => b.y));
  const x1 = Math.max(...bs.map((b) => b.x + b.w));
  const y1 = Math.max(...bs.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

/**
 * 教材の注目枠：見出し画像の実際の装飾範囲（visible）と数字の最大範囲の外接。
 * 役連鎖＝役〜役連鎖数（対戦なら攻撃加算まで）、打上連鎖＝打上〜打上連鎖数
 */
export function chainFocusBox(p: PlayerId, kind: 'chain' | 'streak', withPlus: boolean): Box {
  const l = chainHudLayout(p);
  const digitBox = (d: DigitRow): Box => ({ x: d.cx - d.maxW / 2, y: d.y, w: d.maxW, h: d.h });
  if (kind === 'streak') return union([l.streakTitle.visible, l.streakSub.visible, digitBox(l.streakDigits)]);
  const parts = [l.roleTitle.visible, l.roleSub.visible, digitBox(l.roleDigits)];
  if (withPlus) parts.push({ x: l.cx - l.roleDigits.maxW / 2, y: l.plus.y, w: l.roleDigits.maxW, h: l.plus.size + 2 });
  return union(parts);
}

/** 揺れのオフセット（予約開始からの経過ms。乱数は使わない） */
export function crackShakeOffset(elapsedMs: number): readonly [number, number] {
  const s = CHAIN_HUD.shake;
  if (elapsedMs < 0) return [0, 0];
  const ph = elapsedMs % s.periodMs;
  if (ph >= s.activeMs) return [0, 0];
  return s.offsets[Math.floor(ph / s.stepMs) % s.offsets.length];
}

/** SINGLE 倍率数字の1字の定義（v320_fix04_assets.json の score_rate_numeric.glyphs） */
export interface RateGlyphDef {
  char: string;
  rect: readonly number[];
  visible_xywh: readonly number[];
  offset: readonly number[];
  advance: number;
}

/** 倍率数字列の字配置：各字のセル描画位置（列左端からの dx）と、最後の字の可視幅までの列幅 */
export function rateRun(glyphs: readonly RateGlyphDef[], text: string): { width: number; cells: { g: RateGlyphDef; dx: number }[] } {
  let pen = 0;
  let width = 0;
  const cells: { g: RateGlyphDef; dx: number }[] = [];
  for (const ch of text) {
    const g = glyphs.find((x) => x.char === ch);
    if (!g) throw new Error(`score_rate_numeric: no glyph ${ch}`);
    const dx = pen + g.offset[0];
    cells.push({ g, dx });
    width = Math.max(width, dx + g.visible_xywh[0] + g.visible_xywh[2]);
    pen += g.advance;
  }
  return { width, cells };
}
