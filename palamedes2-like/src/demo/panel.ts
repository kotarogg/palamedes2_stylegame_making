// 遊び方・放置デモの説明パネル（右の info_panel［384,128,192,224］の内側）と戻る案内の描画。
// 配置は設計書 第4節（見出し［396,140］16px、本文［396,170］から22px送り最大4行、例／操作［396,266］、戻る案内［396,310］2行18px送り）。
// 対戦デモの戻る案内は1行［x222,y270,w196,h20］中心x320。取得回数・役連鎖の実値は既存HUDを使い、パネルに第二のゲーム状態を持たない。
import type { Suit } from '../core/types';
import { drawFrame, drawNineSlice, type Assets } from '../view/assets';
import { drawBitmapText, TUTORIAL_COLORS } from '../view/bitmapFont';
import { TUTORIAL_SCRIPT } from './lesson';

export const PANEL = {
  heading: { x: 396, y: 140, w: 168, h: 20 },
  body: { x: 396, y: 170, w: 168, h: 88, step: 22, maxLines: 4 },
  example: { x: 396, y: 266, w: 168, h: 40, piece: 24, gap: 2 },
  hint: { x: 396, y: 310, step: 18 },
} as const;

/** 対戦形式の戻る案内（文字の原点。外接領域［222,270,196,20］） */
export const VERSUS_HINT = { x: 320, y: 272 } as const;

export type HintLayout = 'single' | 'versus';

export interface PanelContent {
  heading?: string;
  lines?: readonly string[];
  /** 例のピース（既存素材の小型ピース24px、間隔2px） */
  pieces?: readonly { n: number; suit: Suit }[];
  /** 操作アイコン（tutorial_action_icons の id） */
  icons?: readonly string[];
}

/**
 * v3.2.0 説明パネルの不要な内線を消す：info_panel.png は本編SINGLEの情報欄用に横線3本（y＋36/98/160、x＋12〜179）を持つ。
 * 説明パネルでは同じ面の色で塗り、外枠は残す（本編SINGLEの情報欄は従来どおり線あり）
 */
export const INFO_PANEL_RULES = { x: 384 + 12, w: 168, ys: [128 + 36, 128 + 98, 128 + 160], color: 'rgb(20,43,65)' } as const;

export function hidePanelRules(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = INFO_PANEL_RULES.color;
  for (const y of INFO_PANEL_RULES.ys) ctx.fillRect(INFO_PANEL_RULES.x, y, INFO_PANEL_RULES.w, 1);
}

/** 説明パネルの面（info_panel［384,128］）。中央の見出し（ALL CLEAR 等）の端がパネルへ掛からないよう、説明の前に描き直す */
export const INFO_PANEL_AT = { x: 384, y: 128 } as const;

export function drawTutorialPanel(ctx: CanvasRenderingContext2D, assets: Assets, c: PanelContent): void {
  drawFrame(ctx, assets, assets.atlas.frame('info_panel', 'info_panel'), INFO_PANEL_AT.x, INFO_PANEL_AT.y);
  hidePanelRules(ctx);
  const font = assets.tutorial?.font;
  if (c.heading) drawBitmapText(ctx, font, c.heading, PANEL.heading.x, PANEL.heading.y + 2, { color: TUTORIAL_COLORS.heading });
  (c.lines ?? []).slice(0, PANEL.body.maxLines).forEach((l, i) => drawBitmapText(ctx, font, l, PANEL.body.x, PANEL.body.y + i * PANEL.body.step));
  const ex = PANEL.example;
  let x = ex.x;
  for (const p of c.pieces ?? []) {
    drawFrame(ctx, assets, assets.atlas.piece(p.n, p.suit, true), x, ex.y);
    x += ex.piece + ex.gap;
  }
  const icons = assets.tutorial?.icons;
  if (icons)
    for (const id of c.icons ?? []) {
      const f = icons[id];
      if (!f) continue;
      drawFrame(ctx, assets, f, x, ex.y);
      x += ex.piece + ex.gap;
    }
}

/** 戻る案内：シングル形式は右下2行、対戦形式は中央1行。1pxの暗色縁取り。フェード・点滅・消灯をしない（暗転より手前に描く） */
export function drawReturnHint(ctx: CanvasRenderingContext2D, assets: Assets, layout: HintLayout): void {
  const font = assets.tutorial?.font;
  const h = TUTORIAL_SCRIPT.return_hint;
  const o = { color: TUTORIAL_COLORS.body, outline: TUTORIAL_COLORS.outline };
  if (layout === 'versus') drawBitmapText(ctx, font, h.one_line, VERSUS_HINT.x, VERSUS_HINT.y, { ...o, align: 'center' });
  else h.two_lines.forEach((l, i) => drawBitmapText(ctx, font, l, PANEL.hint.x, PANEL.hint.y + i * PANEL.hint.step, o));
}

/** 注目枠（9-slice の角印）。成立光とは別。点滅させない */
export function drawFocus(ctx: CanvasRenderingContext2D, assets: Assets, r: { x: number; y: number; w: number; h: number }): void {
  const t = assets.tutorial;
  if (!t) return;
  drawNineSlice(ctx, assets, t.focus, t.focusSlice, r.x, r.y, r.w, r.h);
}
