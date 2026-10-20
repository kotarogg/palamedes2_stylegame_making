// ブラウザでの素材読込。PNG・JSONは public/ 配下から実行時に取得する。
import { Layout, sheetsToLoad, SpriteAtlas, type AssetLoadingPolicy, type ManifestFrame, type ScreenLayout, type SpriteManifest } from './data';

export interface Assets {
  atlas: SpriteAtlas;
  layout: Layout;
  images: Map<string, HTMLImageElement>;
  /** B入替用に暗くしたS4（元PNGは変更しない） */
  darkS4: HTMLCanvasElement;
  darkAlpha: number;
}

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

export async function loadAssets(baseUrl: string, darkAlpha: number): Promise<Assets> {
  const [manifest, layoutData] = await Promise.all([
    loadJson<SpriteManifest>(`${baseUrl}data/sprite_manifest_v2.json`),
    loadJson<ScreenLayout>(`${baseUrl}data/screen_layout_v2.json`),
  ]);
  const policy = await loadJson<AssetLoadingPolicy>(`${baseUrl}data/${manifest.asset_loading_policy ?? 'asset_loading_policy.json'}`);
  // 13PNG（12シート＋背景）。読み込み失敗は素材名を示して起動を止める
  const images = new Map<string, HTMLImageElement>();
  await Promise.all(
    sheetsToLoad(manifest, policy).map(async (s) => {
      const img = await loadImage(`${baseUrl}assets/sprites/${s.file}`);
      if (img.width !== s.width || img.height !== s.height)
        throw new Error(`${s.file}: size ${img.width}x${img.height} != manifest ${s.width}x${s.height}`);
      images.set(s.id, img);
    }),
  );
  return {
    atlas: new SpriteAtlas(manifest),
    layout: new Layout(layoutData),
    images,
    darkS4: darken(images.get('S4')!, darkAlpha),
    darkAlpha,
  };
}

/** マニフェストの矩形をそのまま切り出して描画（拡大縮小なし＝ドットを滲ませない） */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  assets: Assets,
  f: ManifestFrame,
  x: number,
  y: number,
  opts: { dark?: boolean; alpha?: number } = {},
): void {
  const src = opts.dark && f.sheet === 'S4' ? assets.darkS4 : assets.images.get(f.sheet)!;
  const prev = ctx.globalAlpha;
  if (opts.alpha !== undefined) ctx.globalAlpha = opts.alpha;
  ctx.drawImage(src, f.x, f.y, f.w, f.h, Math.round(x), Math.round(y), f.w, f.h);
  ctx.globalAlpha = prev;
}
