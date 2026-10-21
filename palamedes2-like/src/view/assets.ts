// ブラウザでの素材読込。PNG・JSON・フォントは public/ 配下から実行時に取得する。
// 第3版：gfx/data/graphics_manifest_v3.json と gfx/data/game_loading_list.json（明示読込一覧）に従う。
import { Layout, normalizeManifest, SpriteAtlas, type LoadingList, type ManifestFrame, type RawManifestV3, type ScreenLayout } from './data';

export interface FontStyles {
  family: string;
  file: string;
  dark_background_text: string;
  selected_light_background_text: string;
  secondary: string;
}

export interface CreditsText {
  status: string;
  lines: string[];
  links: Record<string, string>;
}

export interface Assets {
  atlas: SpriteAtlas;
  layout: Layout;
  images: Map<string, HTMLImageElement>;
  /** B入替用に暗くしたS4（元PNGは変更しない） */
  darkS4: HTMLCanvasElement;
  darkAlpha: number;
  fontStyles: FontStyles;
  credits: CreditsText;
  /** 採用フォント（Noto Sans JP）の読込結果。false なら画面に警告を出す（黙って代替フォントへ退避しない） */
  fontLoaded: boolean;
}

export const GFX_ROOT = 'gfx/';

async function loadJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`image load failed: ${url}`));
    img.src = url;
  });
}

function darken(img: HTMLImageElement, alpha: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d')!;
  g.drawImage(img, 0, 0);
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = `rgba(0,0,24,${alpha})`;
  g.fillRect(0, 0, c.width, c.height);
  return c;
}

/** 採用フォントを FontFace で読み込み、描画前に読込完了を待つ。失敗は false（呼出し側が警告を表示） */
async function loadFont(baseUrl: string, styles: FontStyles): Promise<boolean> {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined') return false;
  try {
    const face = new FontFace(styles.family, `url(${baseUrl}${GFX_ROOT}${styles.file})`, { weight: '100 900', style: 'normal' });
    await face.load();
    document.fonts.add(face);
    await document.fonts.load(`600 12px "${styles.family}"`, 'あ');
    return document.fonts.check(`600 12px "${styles.family}"`, 'あ');
  } catch {
    return false;
  }
}

export async function loadAssets(baseUrl: string, darkAlpha: number): Promise<Assets> {
  const root = `${baseUrl}${GFX_ROOT}`;
  const [raw, list, layoutData, fontStyles, credits] = await Promise.all([
    loadJson<RawManifestV3>(`${root}data/graphics_manifest_v3.json`),
    loadJson<LoadingList>(`${root}data/game_loading_list.json`),
    loadJson<ScreenLayout>(`${baseUrl}data/screen_layout_v2.json`),
    loadJson<FontStyles>(`${root}data/font_styles.json`),
    loadJson<CreditsText>(`${root}data/credits_text.json`),
  ]);
  const { manifest, targets } = normalizeManifest(raw, list);
  // 明示読込一覧の画像だけを読む。読み込み失敗・寸法違いは素材名を示して起動を止める
  const images = new Map<string, HTMLImageElement>();
  const [, fontLoaded] = await Promise.all([
    Promise.all(
      targets.map(async (t) => {
        const img = await loadImage(`${root}${t.file}`);
        if (img.width !== t.width || img.height !== t.height) throw new Error(`${t.file}: size ${img.width}x${img.height} != manifest ${t.width}x${t.height}`);
        images.set(t.id, img);
      }),
    ),
    list.files.includes(fontStyles.file) ? loadFont(baseUrl, fontStyles) : Promise.resolve(false),
  ]);
  return {
    atlas: new SpriteAtlas(manifest),
    layout: new Layout(layoutData),
    images,
    darkS4: darken(images.get('S4')!, darkAlpha),
    darkAlpha,
    fontStyles,
    credits,
    fontLoaded,
  };
}

/** マニフェストの矩形をそのまま切り出して描画（拡大縮小なし＝ドットを滲ませない）。flipX は左右反転（向きの反転のみ） */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  assets: Assets,
  f: ManifestFrame,
  x: number,
  y: number,
  opts: { dark?: boolean; alpha?: number; flipX?: boolean } = {},
): void {
  const src = opts.dark && f.sheet === 'S4' ? assets.darkS4 : assets.images.get(f.sheet)!;
  const prev = ctx.globalAlpha;
  if (opts.alpha !== undefined) ctx.globalAlpha = prev * opts.alpha;
  if (opts.flipX) {
    ctx.save();
    ctx.translate(Math.round(x) + f.w, Math.round(y));
    ctx.scale(-1, 1);
    ctx.drawImage(src, f.x, f.y, f.w, f.h, 0, 0, f.w, f.h);
    ctx.restore();
  } else ctx.drawImage(src, f.x, f.y, f.w, f.h, Math.round(x), Math.round(y), f.w, f.h);
  ctx.globalAlpha = prev;
}

/** 9スライス描画（角は原寸、辺・中央は整数pxで引き伸ばし）。囲み枠を任意の内寸へ合わせる */
export function drawNineSlice(ctx: CanvasRenderingContext2D, assets: Assets, f: ManifestFrame, slice: number, x: number, y: number, w: number, h: number): void {
  const img = assets.images.get(f.sheet)!;
  const s = slice;
  const xs = [0, s, f.w - s, f.w];
  const ys = [0, s, f.h - s, f.h];
  const dx = [0, s, w - s, w];
  const dy = [0, s, h - s, h];
  x = Math.round(x);
  y = Math.round(y);
  for (let j = 0; j < 3; j++)
    for (let i = 0; i < 3; i++) {
      const sw = xs[i + 1] - xs[i];
      const sh = ys[j + 1] - ys[j];
      const dw = dx[i + 1] - dx[i];
      const dh = dy[j + 1] - dy[j];
      if (sw > 0 && sh > 0 && dw > 0 && dh > 0) ctx.drawImage(img, f.x + xs[i], f.y + ys[j], sw, sh, x + dx[i], y + dy[j], dw, dh);
    }
}
