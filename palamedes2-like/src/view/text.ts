// 文字描画：実行時の文字（メニュー・説明・数値ラベル）はキャンバスの文字、倍率・得点などの見出し数値はS12の枠なし数字を合成。
// S12の合成は runtime_display_reference.js と同じ規則（インク幅で詰め、領域に収まらなければ縮小。値は丸めない）。
import { drawFrame, type Assets } from './assets';

/**
 * 第3版：採用フォント Noto Sans JP（gfx/fonts/NotoSansJP-VF.ttf、font_styles.json）。読込は assets.loadFont で完了を待つ。
 * 読込に失敗した場合は画面上部に警告を表示する（黙って別フォントへ退避したことにしない）。
 */
export const UI_FONT = '"Noto Sans JP", sans-serif';

/** font_styles.json の文字色（暗い背景＝明色、明るい選択面＝濃紺）と副次色 */
export const TEXT_COLORS = { onDark: '#fff1d6', onLight: '#0b1f35', secondary: '#a5c5c5' } as const;

export interface TextOpts {
  color?: string;
  align?: CanvasTextAlign;
  size?: number;
  bold?: boolean;
  /** 明示的な太さ（font_styles.json：本文600、見出し・得点700） */
  weight?: number;
  /** 文字の影（font_styles.json は影なし。既定 false） */
  shadow?: boolean;
  /** 背景の半透明帯 */
  box?: boolean;
  maxWidth?: number;
}

export function drawText(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, o: TextOpts = {}): void {
  ctx.save();
  ctx.font = `${o.weight ?? (o.bold ? 700 : 600)} ${o.size ?? 10}px ${UI_FONT}`;
  ctx.textBaseline = 'top';
  ctx.textAlign = o.align ?? 'left';
  if (o.box) {
    const w = Math.min(o.maxWidth ?? Infinity, ctx.measureText(s).width) + 6;
    const bx = o.align === 'center' ? x - w / 2 : o.align === 'right' ? x - w + 3 : x - 3;
    ctx.fillStyle = 'rgba(0,0,16,0.72)';
    ctx.fillRect(Math.round(bx), y - 2, Math.ceil(w), (o.size ?? 10) + 4);
  }
  if (o.shadow === true) {
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.fillText(s, x + 1, y + 1, o.maxWidth);
  }
  ctx.fillStyle = o.color ?? TEXT_COLORS.onDark;
  ctx.fillText(s, x, y, o.maxWidth);
  ctx.restore();
}

export type Phase = 'A' | 'B' | 'C';

/** S12の数字・×・小数点を合成（領域内に中央寄せ。収まらなければ縮小。値の丸め・桁制限はしない） */
export function drawNumeric(
  ctx: CanvasRenderingContext2D,
  assets: Assets,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  phase: Phase = 'A',
  align: 'center' | 'left' = 'center',
): void {
  const font = assets.atlas.manifest.display_font;
  if (!font) return;
  const parts = [...text].map((ch) => {
    const m = font.metrics[ch];
    if (!m) throw new Error(`unsupported display glyph: ${ch}`);
    return { f: assets.atlas.frame(font.sheet, m.id_prefix + phase), box: m.ink_box };
  });
  const natural = parts.reduce((w, p) => w + (p.box[2] - p.box[0]), 0) - 2 * (parts.length - 1);
  const scale = Math.min(1, maxWidth / natural);
  let dx = align === 'center' ? x + (maxWidth - natural * scale) / 2 : x;
  const img = assets.images.get(font.sheet)!;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  for (const { f, box } of parts) {
    const w = box[2] - box[0];
    ctx.drawImage(img, f.x + box[0], f.y, w, 34, Math.round(dx), Math.round(y), w * scale, 34);
    dx += (w - 2) * scale;
  }
  ctx.restore();
}

/**
 * v3.1.0 S12 数字の1文字（ink_box で切り出した 34px 高のセル）。crack を指定すると、切り出す前の数字セル（36×34）の (2,0) に
 * ヒビ画像（32×34）を置き、数字の不透明部をマスクにして合成する（数字の外へはみ出さない。数字幅へ伸縮しない）。
 * A/B/C の位相ごと・ヒビごとにキャッシュし、毎フレーム画像を作らない
 */
const glyphCache = new Map<string, { canvas: HTMLCanvasElement; w: number }>();
export function numericGlyph(assets: Assets, ch: string, phase: Phase, crack: string | null): { canvas: HTMLCanvasElement; w: number } {
  const key = `${ch}|${phase}|${crack ?? ''}`;
  const hit = glyphCache.get(key);
  if (hit) return hit;
  const font = assets.atlas.manifest.display_font!;
  const m = font.metrics[ch];
  if (!m) throw new Error(`unsupported display glyph: ${ch}`);
  const f = assets.atlas.frame(font.sheet, m.id_prefix + phase);
  const w = m.ink_box[2] - m.ink_box[0];
  const c = document.createElement('canvas');
  c.width = w;
  c.height = 34;
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  g.drawImage(assets.images.get(font.sheet)!, f.x + m.ink_box[0], f.y, w, 34, 0, 0, w, 34);
  if (crack) {
    // マスク：既に描いた数字の不透明部だけにヒビを重ねる（切り出し後の相対位置は 2−ink_box.x0）
    g.globalCompositeOperation = 'source-atop';
    g.drawImage(assets.images.get(crack)!, 2 - m.ink_box[0], 0);
    g.globalCompositeOperation = 'source-over';
  }
  const out = { canvas: c, w };
  glyphCache.set(key, out);
  return out;
}

/** 合成済みの数字列の自然な幅（34px高・既存 drawNumeric と同じく1文字ごとに2px詰める） */
export function numericNaturalWidth(assets: Assets, text: string): number {
  const font = assets.atlas.manifest.display_font!;
  const ws = [...text].map((ch) => font.metrics[ch].ink_box[2] - font.metrics[ch].ink_box[0]);
  return ws.reduce((a, b) => a + b, 0) - 2 * Math.max(0, ws.length - 1);
}

/**
 * v3.1.0 S12 数字列を指定の高さで描く（縦横等比・最近傍。横だけ潰さない）。maxWidth に収まらなければ等比で縮める。
 * crackDigits：数字（0〜9）にだけヒビを合成する（×・小数点には付けない）。返り値は描いた幅
 */
export function drawNumericScaled(
  ctx: CanvasRenderingContext2D,
  assets: Assets,
  text: string,
  x: number,
  y: number,
  height: number,
  maxWidth: number,
  align: 'left' | 'right' | 'center',
  phase: Phase,
  crackDigits: string | null = null,
): number {
  if (!assets.atlas.manifest.display_font) return 0;
  const natural = numericNaturalWidth(assets, text);
  const scale = Math.min(height / 34, maxWidth / natural);
  const width = Math.round(natural * scale);
  let dx = align === 'left' ? x : align === 'right' ? x - width : x - width / 2;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  for (const ch of text) {
    const gl = numericGlyph(assets, ch, phase, crackDigits && /[0-9]/.test(ch) ? crackDigits : null);
    ctx.drawImage(gl.canvas, Math.round(dx), Math.round(y), Math.round(gl.w * scale), Math.round(34 * scale));
    dx += (gl.w - 2) * scale;
  }
  ctx.restore();
  return width;
}

/** 倍率の表示文字列（×1、×1.25、×2.5 など。値を丸めない） */
export function multiplierText(num: number, den: number): string {
  const v = num / den;
  const s = Number.isInteger(v) ? String(v) : String(Math.round(v * 10000) / 10000);
  return `×${s}`;
}

/** S12の色替え位相（90ms周期で A→B→C） */
export function numericPhase(ms: number, periodMs = 90): Phase {
  return (['A', 'B', 'C'] as const)[Math.floor(ms / periodMs) % 3];
}

/** S8のパネル類を原寸で描く（拡大しない） */
export function drawPanel(ctx: CanvasRenderingContext2D, assets: Assets, id: string, x: number, y: number, alpha?: number): void {
  drawFrame(ctx, assets, assets.atlas.frame('S8', id), x, y, { alpha });
}

/** 経過時間 m:ss.cc */
export function formatTime(ms: number): string {
  const cs = Math.floor(ms / 10);
  const m = Math.floor(cs / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${m}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}
