// 遊び方・放置デモの共通ビットマップフォント（tutorial_font_16.png／tutorial_font_16.json：16px白マスク、v3.2.0 採用版 327字）。
// 表示側で着色（本文 #fff1d6・見出し #f2b950・補助 #a5c5c5）し、戻る案内などに 1px の暗色縁取り（#0b1f35）を付ける。
// 字形の縮小はしない。拡大は整数倍だけ（V320-FIX-03 連鎖HUDの「役」2倍・最近傍）。収録外の文字は採用済み Noto Sans JP で描き、欠字として記録する（黙って差し替えない）。
import { drawText, UI_FONT } from './text';

export interface BitmapGlyph {
  codepoint: string;
  rect: [number, number, number, number];
  advance: number;
  offset: [number, number];
}

export interface BitmapFontDef {
  format: string;
  cell: [number, number];
  line_height: number;
  glyphs: Record<string, BitmapGlyph>;
}

export interface BitmapFont {
  def: BitmapFontDef;
  image: CanvasImageSource & { width: number; height: number };
}

export const TUTORIAL_COLORS = { body: '#fff1d6', heading: '#f2b950', secondary: '#a5c5c5', outline: '#0b1f35' } as const;

/** 収録外として描いた文字（コードポイント表記）。検査・報告用 */
export const missingGlyphs = new Set<string>();

const cp = (ch: string) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;

/** 文字列を NFC で1字ずつ（サロゲートを分けない） */
export const chars = (s: string): string[] => [...s.normalize('NFC')];

/** 収録外の文字（描画せずに判定。テスト・データ検査用） */
export function uncovered(def: BitmapFontDef, s: string): string[] {
  return chars(s).filter((c) => !def.glyphs[c]);
}

/** 送り幅の合計（収録外は 16px として数える） */
export function measureBitmap(def: BitmapFontDef, s: string): number {
  return chars(s).reduce((w, c) => w + (def.glyphs[c]?.advance ?? def.cell[0]), 0);
}

const tinted = new WeakMap<object, Map<string, HTMLCanvasElement>>();

function tint(font: BitmapFont, color: string): HTMLCanvasElement {
  let m = tinted.get(font.image as object);
  if (!m) tinted.set(font.image as object, (m = new Map()));
  let c = m.get(color);
  if (!c) {
    c = document.createElement('canvas');
    c.width = font.image.width;
    c.height = font.image.height;
    const g = c.getContext('2d')!;
    g.drawImage(font.image, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = color;
    g.fillRect(0, 0, c.width, c.height);
    m.set(color, c);
  }
  return c;
}

export interface BitmapTextOpts {
  color?: string;
  align?: 'left' | 'center' | 'right';
  /** 縁取り色（倍率と同じ px 幅。戻る案内・連鎖HUD） */
  outline?: string;
  /** 整数倍の拡大（最近傍）。既定1 */
  scale?: 1 | 2;
}

function drawRun(ctx: CanvasRenderingContext2D, font: BitmapFont, s: string, x: number, y: number, color: string, k = 1): void {
  const sheet = tint(font, color);
  let dx = x;
  for (const ch of chars(s)) {
    const gl = font.def.glyphs[ch];
    if (gl) {
      const [sx, sy, w, h] = gl.rect;
      ctx.drawImage(sheet, sx, sy, w, h, Math.round(dx + gl.offset[0] * k), Math.round(y + gl.offset[1] * k), w * k, h * k);
      dx += gl.advance * k;
    } else {
      missingGlyphs.add(cp(ch));
      ctx.save();
      ctx.font = `400 ${16 * k}px ${UI_FONT}`;
      ctx.textBaseline = 'top';
      ctx.fillStyle = color;
      ctx.fillText(ch, Math.round(dx), Math.round(y));
      ctx.restore();
      dx += font.def.cell[0] * k;
    }
  }
}

/** ビットマップ文字を原寸で描く。font が無い（読込前・検証環境）ときは採用フォントで同じ位置へ描く */
export function drawBitmapText(ctx: CanvasRenderingContext2D, font: BitmapFont | null | undefined, s: string, x: number, y: number, o: BitmapTextOpts = {}): void {
  const color = o.color ?? TUTORIAL_COLORS.body;
  const k = o.scale ?? 1;
  if (!font) {
    drawText(ctx, s, x, y, { size: 16 * k, weight: 400, color, align: o.align ?? 'left' });
    return;
  }
  const w = measureBitmap(font.def, s) * k;
  const x0 = Math.round(o.align === 'center' ? x - w / 2 : o.align === 'right' ? x - w : x);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  if (o.outline) for (const [ox, oy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) drawRun(ctx, font, s, x0 + ox * k, y + oy * k, o.outline, k);
  drawRun(ctx, font, s, x0, y, color, k);
  ctx.restore();
}
