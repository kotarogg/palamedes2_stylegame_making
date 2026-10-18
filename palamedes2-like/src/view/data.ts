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
}

/** asset_loading_policy.json（明示許可リスト。再帰収集しない） */
export interface AssetLoadingPolicy {
  schema: string;
  mode: 'allowlist_only';
  recursive_discovery: boolean;
  sheets: string[];
  optional_standalone_directory?: string;
  exclude_directories?: string[];
}

/** マニフェストの7シートが許可リストに含まれ、許可リスト外を読まないことを検査し、読み込むシートを返す */
export function sheetsToLoad(manifest: SpriteManifest, policy: AssetLoadingPolicy): SheetInfo[] {
  if (policy.mode !== 'allowlist_only' || policy.recursive_discovery) throw new Error('asset policy must be allowlist_only without recursive discovery');
  const allowed = new Set(policy.sheets);
  for (const s of manifest.sheets) if (!allowed.has(s.file)) throw new Error(`sheet not in allowlist: ${s.file}`);
  // アトラス方式のみ使用（個別PNG role_glow_frames は読み込まない＝二重読み込みしない）
  return manifest.sheets;
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
