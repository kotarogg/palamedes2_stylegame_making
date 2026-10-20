// sprite_manifest_v2.json / screen_layout_v2.json の読取り（DOM非依存）。
// 画像差し替え時はPNGとマニフェストを差し替えるだけでロジックは変更しない。
import type { AttackIconLayoutRules } from '../core/attack';
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

/** asset_loading_policy.json（v2.3：明示許可リスト13PNG。旧版・プレビュー・ZIPを再帰収集しない） */
export interface AssetLoadingPolicy {
  mode: 'explicit_allowlist';
  files: string[];
  exclude?: string[];
  no_recursive_discovery: boolean;
}

export interface LoadTarget {
  id: string;
  file: string;
  width: number;
  height: number;
}

/**
 * 読み込むPNG＝マニフェストの12シート＋背景。すべて許可リストに含まれることを検査し、許可リスト外は読まない。
 * アトラス方式のみ使用（個別PNG role_glow_frames は読み込まない＝二重読み込みしない）。
 */
export function sheetsToLoad(manifest: SpriteManifest, policy: AssetLoadingPolicy): LoadTarget[] {
  if (policy.mode !== 'explicit_allowlist' || !policy.no_recursive_discovery) throw new Error('asset policy must be explicit_allowlist without recursive discovery');
  const allowed = new Set(policy.files);
  const targets: LoadTarget[] = [
    ...manifest.sheets.map((s) => ({ id: s.id, file: s.file, width: s.width, height: s.height })),
    ...(manifest.backgrounds ?? []).map((b) => ({ id: b.id, file: b.file, width: b.width, height: b.height })),
  ];
  for (const t of targets) if (!allowed.has(t.file)) throw new Error(`sheet not in allowlist: ${t.file}`);
  return targets;
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

  attackOrigin(player: PlayerId): [number, number] {
    return player === 0 ? this.data.attack_stock.origins.p1 : this.data.attack_stock.origins.p2;
  }

  attackRules(): AttackIconLayoutRules {
    const a = this.data.attack_stock;
    return {
      bigLines: a.big_lines,
      bigMax: a.big_max,
      bigPitchY: a.big_pitch_y,
      smallMax: a.small_max,
      smallOffsets: a.small_offsets,
    };
  }
}
