// 採用画像（第3版：graphics_manifest_v3.json＋game_loading_list.json）と screen_layout_v2.json の読取り（DOM非依存）。
// 画像差し替え時はPNGとマニフェストを差し替えるだけでロジックは変更しない。
import type { PlayerId, Suit } from '../core/types';

export interface SheetInfo {
  id: string;
  file: string;
  width: number;
  height: number;
  sha256: string;
}

export interface ManifestFrame {
  sheet: string;
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  reserved: boolean;
  slot?: number;
  number?: number;
  suit?: Suit;
  role_index?: number;
  role_name?: string;
  frame?: 'A' | 'B' | 'C';
  /** v2.1：役成立光の対象領域（フレーム内の原点オフセット） */
  target_rect?: { x: number; y: number; w: number; h: number };
  origin?: [number, number];
  recommended_ms?: number;
}

export interface BackgroundInfo {
  id: string;
  file: string;
  width: number;
  height: number;
}

export interface DisplayFontMetric {
  id_prefix: string;
  ink_box: [number, number, number, number];
  advance: number;
}

export interface SpriteManifest {
  schema: string;
  version: string;
  /** v2.1：読み込み許可リストのファイル名 */
  asset_loading_policy?: string;
  role_glow?: { frame_duration_ms: number; period_ms: number; target_pitch_px: number; draw_order: string[] };
  sheets: SheetInfo[];
  frames: ManifestFrame[];
  animations: Record<string, string[]>;
  /** v2.3：640×360共通背景 */
  backgrounds?: BackgroundInfo[];
  /** v2.3：S12の枠なし数字（倍率・残数・得点の合成） */
  display_font?: { sheet: string; metrics: Record<string, DisplayFontMetric>; line_height: number; phase_period_ms: number };
  legacy_aliases?: Record<string, string>;
  recommended_timing?: Record<string, { durations_ms?: number[]; frame_ms?: number }>;
}

export interface LayoutObject {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  status: string;
}

export interface ScreenLayout {
  schema: string;
  revision: string;
  canvas: { w: number; h: number };
  objects: LayoutObject[];
  attack_stock: {
    max_lines: number;
    big_lines: number;
    big_max: number;
    big_size: [number, number];
    small_lines: number;
    small_max: number;
    small_size: [number, number];
    origins: { p1: [number, number]; p2: [number, number] };
    big_pitch_y: number;
    small_columns: [number, number];
    small_offsets: [number, number][];
  };
  layers: { z: number; content: string }[];
  /** v2.3：シングル右側の情報欄・枠の組み立て */
  graphic_mode_rules?: { single_info_rect: [number, number, number, number] };
}

/** 第3版 graphics_manifest_v3.json の生データ（シート＋単独画像） */
export interface RawManifestV3 {
  version: string;
  sheets: { id: string; file: string; w: number; h: number; sha256: string }[];
  frames: ManifestFrame[];
  animations: Record<string, { frames: string[]; durations_ms?: number[]; loop?: boolean }>;
  standalone_assets: { id: string; file: string; dimensions: [number, number]; origin: [number, number]; frames: { id: string; rect: [number, number, number, number]; origin?: [number, number] }[] }[];
  display_font?: SpriteManifest['display_font'];
}

/** game_loading_list.json（明示読込一覧。フォルダの再帰探索をしない） */
export interface LoadingList {
  files: string[];
  exclude?: string[];
}

export interface LoadTarget {
  id: string;
  file: string;
  width: number;
  height: number;
}

/**
 * 生データを内部形式へ：シートは id のまま、単独画像は「画像ID」を擬似シートIDとしてフレームを登録する。
 * 読み込む画像はすべて明示読込一覧に含まれていなければならない（一覧外は読まない・旧版や見本を混ぜない）。
 */
export function normalizeManifest(raw: RawManifestV3, list: LoadingList): { manifest: SpriteManifest; targets: LoadTarget[] } {
  const allowed = new Set(list.files);
  const targets: LoadTarget[] = [
    ...raw.sheets.map((s) => ({ id: s.id, file: s.file, width: s.w, height: s.h })),
    ...raw.standalone_assets.map((a) => ({ id: a.id, file: a.file, width: a.dimensions[0], height: a.dimensions[1] })),
  ];
  for (const t of targets) if (!allowed.has(t.file)) throw new Error(`image not in loading list: ${t.file}`);
  const frames: ManifestFrame[] = [...raw.frames];
  for (const a of raw.standalone_assets)
    for (const f of a.frames) frames.push({ sheet: a.id, id: f.id, x: f.rect[0], y: f.rect[1], w: f.rect[2], h: f.rect[3], reserved: false, origin: f.origin ?? a.origin });
  // アニメーションは「枠IDの列」と「推奨時間」に分けて保持する（時間はマニフェスト記載値）
  const animations: Record<string, string[]> = {};
  const recommended_timing: Record<string, { durations_ms?: number[] }> = {};
  for (const [k, a] of Object.entries(raw.animations)) {
    animations[k] = a.frames;
    if (a.durations_ms) recommended_timing[k] = { durations_ms: a.durations_ms };
  }
  const manifest: SpriteManifest = {
    schema: 'graphics_manifest_v3',
    version: raw.version,
    sheets: targets.map((t) => ({ id: t.id, file: t.file, width: t.width, height: t.height, sha256: raw.sheets.find((s) => s.id === t.id)?.sha256 ?? '' })),
    frames,
    animations,
    display_font: raw.display_font,
    recommended_timing,
  };
  return { manifest, targets };
}

export class SpriteAtlas {
  private readonly byKey = new Map<string, ManifestFrame>();

  constructor(readonly manifest: SpriteManifest) {
    for (const f of manifest.frames) this.byKey.set(`${f.sheet}/${f.id}`, f);
  }

  frame(sheet: string, id: string): ManifestFrame {
    const f = this.byKey.get(`${sheet}/${id}`);
    if (!f) throw new Error(`sprite frame not found: ${sheet}/${id}`);
    return f;
  }

  /** アニメーション（予備透明枠は通常アニメーションへ混ぜない） */
  animation(sheet: string, name: string): ManifestFrame[] {
    const ids = this.manifest.animations[`${sheet}/${name}`];
    if (!ids) throw new Error(`animation not found: ${sheet}/${name}`);
    return ids.map((id) => this.frame(sheet, id)).filter((f) => !f.reserved);
  }

  piece(n: number, suit: Suit, small = false): ManifestFrame {
    return this.frame('S4', `${small ? 'small' : 'piece'}_${n}_${suit}`);
  }

  role(index: number, frame: 'A' | 'B' | 'C'): ManifestFrame {
    return this.frame('S7', `role_${String(index).padStart(2, '0')}_${frame}`);
  }

  sheet(id: string): SheetInfo {
    const s = this.manifest.sheets.find((x) => x.id === id);
    if (!s) throw new Error(`sheet not found: ${id}`);
    return s;
  }
}

export class Layout {
  private readonly byId = new Map<string, LayoutObject>();

  constructor(readonly data: ScreenLayout) {
    for (const o of data.objects) this.byId.set(o.id, o);
  }

  rect(id: string): LayoutObject {
    const r = this.byId.get(id);
    if (!r) throw new Error(`layout object not found: ${id}`);
    return r;
  }

  pRect(player: PlayerId, name: string): LayoutObject {
    return this.rect(`p${player + 1}_${name}`);
  }
}
