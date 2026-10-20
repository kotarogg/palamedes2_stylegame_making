// メニュー・オプション・遊び方・確認ダイアログ・結果パネルの描画部品（S8のパネル類＋実行時文字）。
import { drawFrame, type Assets } from '../view/assets';
import { drawPanel, drawText } from '../view/text';

export const MENU_ITEM = { x: 200, y: 103, pitch: 45, w: 240, h: 40 };

export function drawBackground(ctx: CanvasRenderingContext2D, assets: Assets): void {
  const bg = assets.images.get('BG_MENU');
  if (bg) ctx.drawImage(bg, 0, 0);
  else {
    ctx.fillStyle = '#14142a';
    ctx.fillRect(0, 0, 640, 360);
  }
}

/** メインメニューの両脇のキャラクター（画面見本 main_menu：48×56を3倍、最近傍） */
export function drawMenuCharacters(ctx: CanvasRenderingContext2D, assets: Assets, ms: number): void {
  const A = assets.atlas;
  const f1 = A.animation('S1', 'idle');
  const f2 = A.animation('S2', 'idle');
  const i = Math.floor(ms / 220);
  const draw = (f: ReturnType<typeof A.frame>, x: number, y: number) =>
    ctx.drawImage(assets.images.get(f.sheet)!, f.x, f.y, f.w, f.h, x, y, f.w * 3, f.h * 3);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  draw(f1[i % f1.length], 35, 136);
  draw(f2[i % f2.length], 460, 136);
  ctx.restore();
}

export function drawMenuItems(ctx: CanvasRenderingContext2D, assets: Assets, labels: readonly string[], cursor: number, disabled: readonly boolean[] = []): void {
  labels.forEach((label, i) => {
    const y = MENU_ITEM.y + MENU_ITEM.pitch * i;
    drawPanel(ctx, assets, i === cursor ? 'menu_item_selected' : 'menu_item_normal', MENU_ITEM.x, y);
    drawText(ctx, label, MENU_ITEM.x + MENU_ITEM.w / 2, y + 12, { align: 'center', size: 14, bold: true, color: disabled[i] ? '#8a8aa0' : i === cursor ? '#fff6c8' : '#ffffff' });
  });
  drawFrame(ctx, assets, assets.atlas.frame('S8', 'selection_cursor'), MENU_ITEM.x - 23, MENU_ITEM.y + MENU_ITEM.pitch * cursor + 12);
}

/** 画面下の操作ガイド（パッド A／B、キーボード Enter／Esc） */
export function drawFooter(ctx: CanvasRenderingContext2D, assets: Assets, confirm = '決定', back = '戻る'): void {
  const S8 = (id: string) => assets.atlas.frame('S8', id);
  drawFrame(ctx, assets, S8('pad_button'), 154, 324);
  drawText(ctx, 'A', 166, 329, { align: 'center', size: 9, bold: true, color: '#1a1a2e', shadow: false });
  drawText(ctx, confirm, 182, 329, { size: 10 });
  drawFrame(ctx, assets, S8('pad_button'), 286, 324);
  drawText(ctx, 'B', 298, 329, { align: 'center', size: 9, bold: true, color: '#1a1a2e', shadow: false });
  drawText(ctx, back, 314, 329, { size: 10 });
  drawFrame(ctx, assets, S8('keycap_wide'), 414, 324);
  drawText(ctx, 'Enter', 438, 330, { align: 'center', size: 8, bold: true, color: '#1a1a2e', shadow: false });
  drawText(ctx, confirm, 466, 329, { size: 10 });
  drawFrame(ctx, assets, S8('keycap'), 520, 324);
  drawText(ctx, 'Esc', 534, 330, { align: 'center', size: 8, bold: true, color: '#1a1a2e', shadow: false });
  drawText(ctx, back, 552, 329, { size: 10 });
}

export interface OptionRow {
  label: string;
  value?: string;
  /** 0〜100 のスライダー表示 */
  slider?: number;
  arrows?: boolean;
  note?: string;
}

export const OPTION_PANEL = { x: 96, y: 39, w: 448, h: 284, rowY: 84, pitch: 28 };

export function drawOptionPanel(ctx: CanvasRenderingContext2D, assets: Assets, title: string, rows: readonly OptionRow[], cursor: number, message = ''): void {
  const P = OPTION_PANEL;
  drawPanel(ctx, assets, 'settings_panel', P.x, P.y);
  drawText(ctx, title, P.x + P.w / 2, P.y + 18, { align: 'center', size: 14, bold: true, color: '#fff3c8' });
  const S8 = (id: string) => assets.atlas.frame('S8', id);
  // 画面見本 options_*：焦点枠は 310×29 に伸長して x=198、スライダーは x=300、左右矢印は x=319／491
  rows.forEach((r, i) => {
    const y = P.rowY + P.pitch * i;
    if (i === cursor) {
      const f = S8('focus_ring');
      ctx.drawImage(assets.images.get('S8')!, f.x, f.y, f.w, f.h, 198, y - 7, 310, 29);
    }
    drawText(ctx, r.label, 210, y + 2, { size: 11, color: i === cursor ? '#fff6c8' : '#ffffff', maxWidth: 100 });
    if (r.slider !== undefined) {
      const rx = 300;
      drawFrame(ctx, assets, S8('slider_rail'), rx, y + 1);
      const fill = S8('slider_fill');
      const w = Math.round((160 * r.slider) / 100);
      if (w > 0) ctx.drawImage(assets.images.get('S8')!, fill.x, fill.y, fill.w, fill.h, rx, y + 4, w, fill.h);
      drawFrame(ctx, assets, S8('slider_knob'), rx + w - 8, y - 3);
      drawText(ctx, r.value ?? String(r.slider), rx + 170, y + 2, { size: 10 });
    } else if (r.value !== undefined) {
      if (r.arrows) {
        drawFrame(ctx, assets, S8('arrow_left'), 319, y);
        drawFrame(ctx, assets, S8('arrow_right'), 491, y);
      }
      drawText(ctx, r.value, 413, y + 2, { align: 'center', size: 11, color: '#d8f0ff', maxWidth: 150 });
    }
  });
  const note = rows[cursor]?.note;
  if (note) drawText(ctx, note, P.x + P.w / 2, P.y + P.h - 40, { align: 'center', size: 9, color: '#c9d6ff', maxWidth: P.w - 30 });
  if (message) drawText(ctx, message, P.x + P.w / 2, P.y + P.h - 26, { align: 'center', size: 10, color: '#c0ffd0', maxWidth: P.w - 30 });
}

/** 確認ダイアログ（S8 confirmation_panel 280×120） */
export function drawConfirm(ctx: CanvasRenderingContext2D, assets: Assets, title: string, choices: readonly string[], cursor: number, x = 180, y = 110, sub = ''): void {
  drawPanel(ctx, assets, 'confirmation_panel', x, y);
  drawText(ctx, title, x + 140, y + 22, { align: 'center', size: 12, bold: true, color: '#fff3c8', maxWidth: 260 });
  if (sub) drawText(ctx, sub, x + 140, y + 42, { align: 'center', size: 9, color: '#c9d6ff', maxWidth: 260 });
  const w = 110;
  choices.forEach((c, i) => {
    const cx = x + 140 + (i - (choices.length - 1) / 2) * (w + 10);
    ctx.fillStyle = i === cursor ? 'rgba(255,214,90,0.9)' : 'rgba(40,40,80,0.9)';
    ctx.fillRect(Math.round(cx - w / 2), y + 70, w, 24);
    drawText(ctx, c, cx, y + 76, { align: 'center', size: 11, bold: true, color: i === cursor ? '#1a1a2e' : '#ffffff', shadow: i !== cursor });
  });
}

/** 結果パネル（S8 result_panel 320×232）：見出しS9＋行＋選択肢 */
export function drawResultPanel(
  ctx: CanvasRenderingContext2D,
  assets: Assets,
  headId: string | null,
  lines: readonly string[],
  choices: readonly string[],
  cursor: number,
  phase: 'A' | 'B' | 'C',
  hint = '',
): void {
  const x = 160;
  const y = 64;
  drawPanel(ctx, assets, 'result_panel', x, y);
  if (headId) drawFrame(ctx, assets, assets.atlas.frame('S9', `${headId}_${phase}`), 240, 73);
  let ly = y + 80;
  for (const l of lines) {
    drawText(ctx, l, 320, ly, { align: 'center', size: 11, color: '#ffffff', maxWidth: 290 });
    ly += 16;
  }
  choices.forEach((c, i) => {
    const iy = 210 + 32 * i;
    drawPanel(ctx, assets, i === cursor ? 'menu_item_selected' : 'menu_item_normal', 200, iy - 6);
    drawText(ctx, c, 320, iy + 6, { align: 'center', size: 12, bold: true, color: i === cursor ? '#fff6c8' : '#ffffff' });
  });
  if (hint) drawText(ctx, hint, 320, y + 214, { align: 'center', size: 10, color: '#c0ffd0' });
}
