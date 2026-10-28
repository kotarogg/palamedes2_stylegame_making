// V320-FIX-03 連鎖HUDの縦配置（PM指示 V320R_PM_REVIEW_HUD_ORDER_20261028 第4章）。
// MODE1 の役連鎖と打上連鎖を盤面外側の縦帯（1P x0〜48、2P x592〜640）へまとめ、全行の中心を帯の中心線（x24／x616）に揃える。
// 座標・寸法・倍率はここだけで持ち、描画（gameView）・教材の注目枠（demo/stages）・検査が共通に参照する。640×360 の論理px、左上原点。
// 見出しは既存の共通16pxビットマップ文字（tutorial_font_16）を原寸で使い、「役」だけ整数2倍。新しい画像は使わない。
import type { PlayerId } from '../core/types';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 文字本体の外接（左上・寸法）と整数倍率 */
export interface TextRow extends Box {
  text: string;
  scale: 1 | 2;
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
  /** 役（2倍）・連鎖 */
  roleTitle: TextRow;
  roleSub: TextRow;
  roleDigits: DigitRow;
  /** 攻撃加算「＋○」（対戦のみ。上端・16px） */
  plus: { cx: number; y: number; size: number };
  /** 打上・連鎖 */
  streakTitle: TextRow;
  streakSub: TextRow;
  streakDigits: DigitRow;
}

const STRIP = { 0: { x: 0, w: 48 }, 1: { x: 592, w: 48 } } as const;

export const CHAIN_HUD = {
  /** 見出しの色・縁取り（共通フォントの見出し色と暗色） */
  color: '#f2b950',
  outline: '#0b1f35',
  rows: {
    roleTitle: { y: 130, text: '役', scale: 2 },
    roleSub: { y: 168, text: '連鎖', scale: 1 },
    roleDigits: { y: 190, h: 34, maxW: 46 },
    plus: { y: 228, size: 16 },
    streakTitle: { y: 258, text: '打上', scale: 1 },
    streakSub: { y: 278, text: '連鎖', scale: 1 },
    streakDigits: { y: 300, h: 17, maxW: 46 },
  },
  /** SINGLE の得点倍率（上部の既存倍率領域［24,94,120,34］へ独立表示） */
  singleRate: { area: { x: 24, y: 94, w: 120, h: 34 }, heading: { x: 24, y: 94, size: 9, text: '得点倍率' }, value: { x: 24, y: 108, h: 17, maxW: 116 } },
} as const;

/** 全角16pxの字数×16×倍率 */
function textRow(cx: number, y: number, text: string, scale: 1 | 2): TextRow {
  const w = [...text].length * 16 * scale;
  return { text, scale, x: cx - w / 2, y, w, h: 16 * scale };
}

export function chainHudLayout(p: PlayerId): ChainHudLayout {
  const s = STRIP[p];
  const cx = s.x + s.w / 2;
  const r = CHAIN_HUD.rows;
  return {
    strip: { x: s.x, y: r.roleTitle.y, w: s.w, h: r.streakDigits.y + r.streakDigits.h - r.roleTitle.y },
    cx,
    roleTitle: textRow(cx, r.roleTitle.y, r.roleTitle.text, r.roleTitle.scale),
    roleSub: textRow(cx, r.roleSub.y, r.roleSub.text, r.roleSub.scale),
    roleDigits: { cx, y: r.roleDigits.y, h: r.roleDigits.h, maxW: r.roleDigits.maxW },
    plus: { cx, y: r.plus.y, size: r.plus.size },
    streakTitle: textRow(cx, r.streakTitle.y, r.streakTitle.text, r.streakTitle.scale),
    streakSub: textRow(cx, r.streakSub.y, r.streakSub.text, r.streakSub.scale),
    streakDigits: { cx, y: r.streakDigits.y, h: r.streakDigits.h, maxW: r.streakDigits.maxW },
  };
}

/** 教材の注目枠：役連鎖（役〜連鎖数。対戦なら攻撃加算まで）と打上連鎖（打上〜連鎖数）の外接 */
export function chainFocusBox(p: PlayerId, kind: 'chain' | 'streak', withPlus: boolean): Box {
  const l = chainHudLayout(p);
  const top = kind === 'chain' ? l.roleTitle.y : l.streakTitle.y;
  const d = kind === 'chain' ? l.roleDigits : l.streakDigits;
  const bottom = kind === 'chain' && withPlus ? l.plus.y + l.plus.size + 2 : d.y + d.h;
  return { x: l.cx - d.maxW / 2, y: top, w: d.maxW, h: bottom - top };
}
