// 文字描画：実行時の文字（メニュー・説明・数値ラベル）はキャンバスの文字、倍率・得点などの見出し数値はS12の枠なし数字を合成。
// S12の合成は runtime_display_reference.js と同じ規則（インク幅で詰め、領域に収まらなければ縮小。値は丸めない）。
import { drawFrame, type Assets } from './assets';

export const UI_FONT = '"Noto Sans CJK JP", "Yu Gothic UI", "Yu Gothic", "Meiryo", sans-serif';

export interface TextOpts {
  color?: string;
  align?: CanvasTextAlign;
  size?: number;
  bold?: boolean;
  shadow?: boolean;
  /** 背景の半透明帯 */
  box?: boolean;
  maxWidth?: number;
}

export function drawText(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, o: TextOpts = {}): void {
  ctx.save();
  ctx.font = `${o.bold ? 'bold ' : ''}${o.size ?? 10}px ${UI_FONT}`;
  ctx.textBaseline = 'top';
  ctx.textAlign = o.align ?? 'left';
  if (o.box) {
    const w = Math.min(o.maxWidth ?? Infinity, ctx.measureText(s).width) + 6;
    const bx = o.align === 'center' ? x - w / 2 : o.align === 'right' ? x - w + 3 : x - 3;
    ctx.fillStyle = 'rgba(0,0,16,0.72)';
    ctx.fillRect(Math.round(bx), y - 2, Math.ceil(w), (o.size ?? 10) + 4);
  }
  if (o.shadow !== false) {
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.fillText(s, x + 1, y + 1, o.maxWidth);
  }
  ctx.fillStyle = o.color ?? '#ffffff';
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
