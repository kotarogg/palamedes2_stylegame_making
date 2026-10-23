// タイトル・メニュー・キャラ選択・オプション・クレジット・遊び方・確認・結果の描画部品（第3版の採用UI部品＋実行時文字）。
// 文字は Noto Sans JP（font_styles.json）：暗い面＝明色、明るい選択面＝濃紺、副次＝青灰。影なし。
import type { Character } from '../audio/audioMap';
import { drawFrame, type Assets } from '../view/assets';
import { drawText, TEXT_COLORS } from '../view/text';

/** 見出しの強調色（画面見本の見出し） */
export const ACCENT = '#f2b950';

export const CHARACTER_NAME: Record<Character, string> = { kotaro: 'コタロー', akane: 'アカネ', zunko: '東北ずん子' };

/** 単独画像の部品（擬似シートID＝画像ID）を原寸で描く */
function part(ctx: CanvasRenderingContext2D, assets: Assets, id: string, x: number, y: number, opts: { alpha?: number; frame?: string } = {}): void {
  drawFrame(ctx, assets, assets.atlas.frame(id, opts.frame ?? id), x, y, { alpha: opts.alpha });
}

/** 原点（足元）を指定位置へ合わせて描く（menu_* 144×168 原点(72,167)、title_kotaro_nekotaro 原点(108,287)） */
function partAt(ctx: CanvasRenderingContext2D, assets: Assets, id: string, x: number, y: number): void {
  const f = assets.atlas.frame(id, id);
  const [ox, oy] = f.origin ?? [0, 0];
  drawFrame(ctx, assets, f, x - ox, y - oy);
}

export function drawBackground(ctx: CanvasRenderingContext2D, assets: Assets): void {
  part(ctx, assets, 'background_common', 0, 0);
}

/** タイトル（S01）：タイトル背景・ロゴ・コタローがネコタローを抱いた画像だけ */
export function drawTitle(ctx: CanvasRenderingContext2D, assets: Assets, ms: number): void {
  drawBackground(ctx, assets);
  partAt(ctx, assets, 'title_kotaro_nekotaro', 150, 316);
  part(ctx, assets, 'title_logo', 272, 72);
  const blink = Math.floor(ms / 600) % 2 === 0;
  part(ctx, assets, 'input_hint', 358, 279, { alpha: blink ? 1 : 0.6 });
  drawText(ctx, 'A／Enter でスタート', 446, 284, { align: 'center', size: 12 });
}

/** メインメニュー両脇のキャラクター（menu_* を原寸） */
export function drawMenuCharacters(ctx: CanvasRenderingContext2D, assets: Assets, left: Character = 'kotaro', right: Character = 'akane'): void {
  partAt(ctx, assets, `menu_${left}`, 88, 330);
  partAt(ctx, assets, `menu_${right}`, 552, 330);
}

export const MENU_ITEM = { x: 204, y: 84, pitch: 34, w: 232, h: 32 };

export function drawMenuTitle(ctx: CanvasRenderingContext2D, title: string): void {
  drawText(ctx, title, 320, 16, { align: 'center', size: 18, weight: 700 });
}

export function drawMenuItems(
  ctx: CanvasRenderingContext2D,
  assets: Assets,
  labels: readonly string[],
  cursor: number,
  disabled: readonly boolean[] = [],
  pos: { x: number; y: number; pitch: number } = MENU_ITEM,
): void {
  labels.forEach((label, i) => {
    const y = pos.y + pos.pitch * i;
    const sel = i === cursor;
    part(ctx, assets, sel ? 'menu_item_selected' : 'menu_item_normal', pos.x, y);
    drawText(ctx, label, pos.x + MENU_ITEM.w / 2, y + 7, { align: 'center', size: 14, color: disabled[i] ? TEXT_COLORS.secondary : sel ? TEXT_COLORS.onLight : TEXT_COLORS.onDark });
  });
}

/** 画面下の操作ガイド */
export function drawFooter(ctx: CanvasRenderingContext2D, _assets: Assets, text = 'A／Enter：決定　B／Esc：戻る'): void {
  drawText(ctx, text, 320, 334, { align: 'center', size: 10, color: TEXT_COLORS.secondary });
}

// ---------------------------------------------------------------- 読み物パネル（結果・オプション・クレジット・遊び方）

export const READING_PANEL = { x: 48, y: 40, w: 544, h: 264 };

export function drawReadingPanel(ctx: CanvasRenderingContext2D, assets: Assets, title?: string): void {
  const P = READING_PANEL;
  part(ctx, assets, 'reading_panel', P.x, P.y);
  if (title) drawText(ctx, title, P.x + 24, P.y + 14, { size: 18, weight: 700, color: ACCENT });
}

export interface OptionRow {
  label: string;
  value?: string;
  /** 0〜100 のスライダー表示 */
  slider?: number;
  arrows?: boolean;
  note?: string;
  /** 選べない行（例：現在の画面に収まらない固定倍率） */
  disabled?: boolean;
}

export const OPTION_ROWS = { x: 72, y: 76, pitch: 25, w: 496 };

/** オプション画面（S19〜S23）：reading_panel＋options_row。値の左右に CTRL の矢印、音量は CTRL のスライダー */
export function drawOptionPanel(ctx: CanvasRenderingContext2D, assets: Assets, title: string, rows: readonly OptionRow[], cursor: number, message = ''): void {
  drawReadingPanel(ctx, assets, title);
  const R = OPTION_ROWS;
  const ctrl = (id: string, x: number, y: number, alpha?: number) => drawFrame(ctx, assets, assets.atlas.frame('CTRL', id), x, y, { alpha });
  rows.forEach((r, i) => {
    const y = R.y + R.pitch * i;
    const sel = i === cursor;
    part(ctx, assets, sel ? 'options_row_selected' : 'options_row_normal', R.x, y);
    const color = r.disabled ? TEXT_COLORS.secondary : sel ? TEXT_COLORS.onLight : TEXT_COLORS.onDark;
    drawText(ctx, r.label, R.x + 16, y + 5, { size: 12, color, maxWidth: 220 });
    if (r.slider !== undefined) {
      const rx = 320;
      const rail = assets.atlas.frame('CTRL', 'slider_rail');
      ctrl('slider_rail', rx, y + 8);
      const fill = assets.atlas.frame('CTRL', 'slider_fill');
      const w = Math.round((rail.w * r.slider) / 100);
      if (w > 0) ctx.drawImage(assets.images.get('CTRL')!, fill.x, fill.y, w, fill.h, rx, y + 8, w, fill.h);
      ctrl('slider_knob', rx + w - 4, y + 5);
      drawText(ctx, r.value ?? String(r.slider), rx + rail.w + 16, y + 5, { size: 12, color });
    } else if (r.value !== undefined) {
      const alpha = r.disabled ? 0.4 : 1;
      if (r.arrows) {
        ctrl('arrow_left', 344, y + 6, alpha);
        ctrl('arrow_right', 536, y + 6, alpha);
      }
      drawText(ctx, r.value, 446, y + 5, { align: 'center', size: 12, color, maxWidth: 170 });
    }
  });
  // 説明は最終行（最大8行）の下、パネル内。操作結果のメッセージはパネルの下
  const P = READING_PANEL;
  const note = rows[cursor]?.note;
  if (note) drawText(ctx, note, P.x + P.w / 2, Math.min(R.y + R.pitch * rows.length + 4, P.y + P.h - 16), { align: 'center', size: 10, color: TEXT_COLORS.secondary, maxWidth: P.w - 40 });
  if (message) drawText(ctx, message, P.x + P.w / 2, P.y + P.h + 8, { align: 'center', size: 11, color: ACCENT, box: true, maxWidth: P.w - 40 });
}

/** 確認ダイアログ（dialog_panel 288×112） */
export function drawConfirm(ctx: CanvasRenderingContext2D, assets: Assets, title: string, choices: readonly string[], cursor: number, x = 176, y = 124, sub = ''): void {
  part(ctx, assets, 'dialog_panel', x, y);
  drawText(ctx, title, x + 144, y + 16, { align: 'center', size: 14, weight: 700, maxWidth: 264 });
  if (sub) drawText(ctx, sub, x + 144, y + 40, { align: 'center', size: 10, color: TEXT_COLORS.secondary, maxWidth: 264 });
  const w = 112;
  choices.forEach((c, i) => {
    const cx = Math.round(x + 144 + (i - (choices.length - 1) / 2) * (w + 16));
    const sel = i === cursor;
    ctx.fillStyle = sel ? '#ffe39b' : '#132538';
    ctx.fillRect(cx - w / 2, y + 68, w, 26);
    ctx.strokeStyle = sel ? '#e0a040' : '#a5c5c5';
    ctx.strokeRect(cx - w / 2 + 0.5, y + 68.5, w - 1, 25);
    drawText(ctx, c, cx, y + 73, { align: 'center', size: 12, color: sel ? TEXT_COLORS.onLight : TEXT_COLORS.onDark });
  });
}

/** 結果（S13〜S18）：reading_panel＋S9見出し＋行＋選択肢（menu_item） */
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
  drawReadingPanel(ctx, assets);
  if (headId) drawFrame(ctx, assets, assets.atlas.frame('S9', `${headId}_${phase}`), 240, 42);
  let ly = 110;
  for (const l of lines) {
    drawText(ctx, l, 320, ly, { align: 'center', size: 14, maxWidth: 500 });
    ly += 22;
  }
  drawMenuItems(ctx, assets, choices, cursor, [], { x: 204, y: 190, pitch: 32 });
  if (hint) drawText(ctx, hint, 320, 276, { align: 'center', size: 12, color: ACCENT });
}

// ---------------------------------------------------------------- キャラクター選択（S05）

export const SELECT_SLOTS: readonly Character[] = ['kotaro', 'akane', 'zunko'];
const SLOT_X = [128, 320, 512];

export function drawCharacterSelect(
  ctx: CanvasRenderingContext2D,
  assets: Assets,
  cursors: readonly [number, number],
  locked: readonly [boolean, boolean],
  ms: number,
  /** カーソルを出す人数（CPU対戦は1Pだけ。2Pカーソルは出さない） */
  players: 1 | 2 = 2,
): void {
  drawBackground(ctx, assets);
  drawText(ctx, 'キャラクター選択', 240, 14, { size: 18, weight: 700 });
  SELECT_SLOTS.forEach((c, i) => {
    const cx = SLOT_X[i];
    part(ctx, assets, `icon_${c}`, cx - 32, 76);
    drawText(ctx, CHARACTER_NAME[c], cx, 146, { align: 'center', size: 12 });
    partAt(ctx, assets, `menu_${c}`, cx, 328);
  });
  // 1P／2Pのカーソル（決定済みは点滅しない）と「決定済み」
  ([0, 1] as const).slice(0, players).forEach((p) => {
    const cx = SLOT_X[cursors[p]];
    const on = locked[p] || Math.floor(ms / 400) % 2 === 0;
    part(ctx, assets, `cursor_${p + 1}p_focus`, cx - 48, 60, { alpha: on ? 1 : 0.55 });
    if (locked[p]) {
      part(ctx, assets, 'selection_locked', cx - 48, 300);
      drawText(ctx, `${p + 1}P 決定済み`, cx, 303, { align: 'center', size: 11, color: TEXT_COLORS.onLight });
    }
  });
}

// ---------------------------------------------------------------- クレジット（S24）

export interface CreditItem {
  text: string;
  /** 選択して決定すると外部ブラウザで開くURL */
  url?: string;
}

export function drawCredits(ctx: CanvasRenderingContext2D, assets: Assets, items: readonly CreditItem[], page: number, pages: number, cursor: number | null): void {
  drawReadingPanel(ctx, assets, 'クレジット');
  items.forEach((it, i) => {
    const y = 90 + i * 24;
    const sel = cursor === i;
    if (sel) {
      ctx.fillStyle = '#ffe39b';
      ctx.fillRect(68, y - 3, 504, 20);
    }
    drawText(ctx, it.text, 76, y, { size: 12, color: sel ? TEXT_COLORS.onLight : it.url ? '#bfe6ff' : TEXT_COLORS.onDark, maxWidth: 488 });
  });
  drawText(ctx, `${page + 1} / ${pages}`, 572, 282, { align: 'right', size: 11, color: TEXT_COLORS.secondary });
}
