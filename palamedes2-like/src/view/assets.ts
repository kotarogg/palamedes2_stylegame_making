// ブラウザでの素材読込。PNG・JSON・フォントは public/ 配下から実行時に取得する。
// 第3版：gfx/data/graphics_manifest_v3.json と gfx/data/game_loading_list.json（明示読込一覧）に従う。
import type { BitmapFont, BitmapFontDef } from './bitmapFont';
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
  /** v3.1.0 追加画像（additional_assets_v310.json の assets）。id → 定義。画像は images に同じ id で入る */
  extra: Record<string, ExtraAssetDef>;
  /** 遊び方・放置デモ用UI（tutorial_assets.json）。読込前・検証環境では無い */
  tutorial?: TutorialAssets;
  /** V320-FIX-04 追加画像（v320_fix04_assets.json：見出し8枚・倍率数字1枚）。画像は images に同じ id で入る */
  fix04?: Fix04Assets;
}

/** V320-FIX-04 見出しPNG（原寸1倍。body_origin＝旧文字セル左上に合わせる点、visible_xywh＝描画画素の外接） */
export interface Fix04Label {
  id: string;
  file: string;
  canvas: [number, number];
  body_origin: [number, number];
  visible_xywh: [number, number, number, number];
  sha256: string;
}

/** 倍率数字シートの1字（セル矩形・可視範囲・正規化offset・送り） */
export interface RateGlyph {
  char: string;
  rect: [number, number, number, number];
  visible_xywh: [number, number, number, number];
  offset: [number, number];
  advance: number;
}

export interface Fix04AssetsJson {
  format: string;
  assets: { id: string; file: string; canvas: [number, number]; body_origin?: [number, number]; visible_xywh?: [number, number, number, number]; sha256: string }[];
  score_rate_numeric: { sheet: string; cell: [number, number]; baseline_y: number; glyphs: RateGlyph[] };
}

export interface Fix04Assets {
  labels: Record<string, Fix04Label>;
  rate: Fix04AssetsJson['score_rate_numeric'];
}

export function fix04Assets(def: Fix04AssetsJson): Fix04Assets {
  return {
    labels: Object.fromEntries(def.assets.filter((a) => a.body_origin).map((a) => [a.id, a as Fix04Label])),
    rate: def.score_rate_numeric,
  };
}

/** 遊び方・放置デモ用UI（tutorial_assets.json の3画像。画像は images に同じ id で入る） */
export interface TutorialAssets {
  font: BitmapFont;
  /** 操作アイコン（24×24）：move_left／move_right／column_cycle／launch／declare_role／raise */
  icons: Record<string, ManifestFrame>;
  /** 注目枠（24×24、9-slice 外周4px） */
  focus: ManifestFrame;
  focusSlice: number;
}

interface TutorialAssetsJson {
  format: string;
  assets: {
    id: string;
    file: string;
    dimensions: [number, number];
    frames?: string | { id: string; rect: [number, number, number, number] }[];
    nine_slice?: { left: number };
  }[];
}

/** v3.1.0 追加画像の定義（静止1枚。原点は左上） */
export interface ExtraAssetDef {
  id: string;
  file: string;
  canvas: [number, number];
  ink_box: [number, number, number, number];
  sha256: string;
}

interface AdditionalAssetsV310 {
  version: string;
  assets: ExtraAssetDef[];
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
  const [raw, list, layoutData, fontStyles, credits, additional, tutorialDef, tutorialFont, fix04Def] = await Promise.all([
    loadJson<RawManifestV3>(`${root}data/graphics_manifest_v3.json`),
    loadJson<LoadingList>(`${root}data/game_loading_list.json`),
    loadJson<ScreenLayout>(`${baseUrl}data/screen_layout_v2.json`),
    loadJson<FontStyles>(`${root}data/font_styles.json`),
    loadJson<CreditsText>(`${root}data/credits_text.json`),
    loadJson<AdditionalAssetsV310>(`${root}data/additional_assets_v310.json`),
    loadJson<TutorialAssetsJson>(`${root}data/tutorial_assets.json`),
    loadJson<BitmapFontDef>(`${root}data/tutorial_font_16.json`),
    loadJson<Fix04AssetsJson>(`${root}data/v320_fix04_assets.json`),
  ]);
  const { manifest, targets } = normalizeManifest(raw, list);
  // 明示読込一覧の画像だけを読む。読み込み失敗・寸法違いは素材名を示して起動を止める
  const images = new Map<string, HTMLImageElement>();
  const [, , fontLoaded] = await Promise.all([
    Promise.all(
      targets.map(async (t) => {
        const img = await loadImage(`${root}${t.file}`);
        if (img.width !== t.width || img.height !== t.height) throw new Error(`${t.file}: size ${img.width}x${img.height} != manifest ${t.width}x${t.height}`);
        images.set(t.id, img);
      }),
    ),
    // v3.1.0 追加画像（既存の共通マニフェストは変更しない。同じく寸法違いは起動を止める）
    Promise.all(
      additional.assets.map(async (a) => {
        const img = await loadImage(`${root}${a.file}`);
        if (img.width !== a.canvas[0] || img.height !== a.canvas[1]) throw new Error(`${a.file}: size ${img.width}x${img.height} != ${a.canvas.join('x')}`);
        images.set(a.id, img);
      }),
    ),
    list.files.includes(fontStyles.file) ? loadFont(baseUrl, fontStyles) : Promise.resolve(false),
    // 遊び方・放置デモ用UI（既存マニフェストは変更しない。寸法違いは起動を止める）
    Promise.all(
      tutorialDef.assets.map(async (a) => {
        const img = await loadImage(`${root}${a.file}`);
        if (img.width !== a.dimensions[0] || img.height !== a.dimensions[1]) throw new Error(`${a.file}: size ${img.width}x${img.height} != ${a.dimensions.join('x')}`);
        images.set(a.id, img);
      }),
    ),
    // V320-FIX-04 追加画像（見出し・倍率数字。寸法違いは起動を止める）
    Promise.all(
      fix04Def.assets.map(async (a) => {
        const img = await loadImage(`${root}${a.file}`);
        if (img.width !== a.canvas[0] || img.height !== a.canvas[1]) throw new Error(`${a.file}: size ${img.width}x${img.height} != ${a.canvas.join('x')}`);
        images.set(a.id, img);
      }),
    ),
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
    extra: Object.fromEntries(additional.assets.map((a) => [a.id, a])),
    tutorial: tutorialAssets(tutorialDef, tutorialFont, images),
    fix04: fix04Assets(fix04Def),
  };
}

function tutorialAssets(def: TutorialAssetsJson, font: BitmapFontDef, images: Map<string, HTMLImageElement>): TutorialAssets {
  const frame = (sheet: string, id: string, r: [number, number, number, number]): ManifestFrame => ({ sheet, id, x: r[0], y: r[1], w: r[2], h: r[3], reserved: false });
  const icons = def.assets.find((a) => a.id === 'tutorial_action_icons')!;
  const focus = def.assets.find((a) => a.id === 'tutorial_focus_frame')!;
  return {
    font: { def: font, image: images.get('tutorial_font_16')! },
    icons: Object.fromEntries((icons.frames as { id: string; rect: [number, number, number, number] }[]).map((f) => [f.id, frame('tutorial_action_icons', f.id, f.rect)])),
    focus: frame('tutorial_focus_frame', 'focus', [0, 0, focus.dimensions[0], focus.dimensions[1]]),
    focusSlice: focus.nine_slice?.left ?? 4,
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
