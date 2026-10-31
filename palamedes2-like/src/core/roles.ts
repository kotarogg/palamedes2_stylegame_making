// 役判定（統合仕様 第6〜7章）。成立条件・採択集合をここで決め、消去数・基本攻撃数は V320-FIX-06 の数値表（roleTable.ts）から引く。
// V320-FIX-06：旧「翻数＝消去数」「翻数−1＋数字役ボーナス＝攻撃」は廃止。自動採択は 消去数 → 基本攻撃数 → 数字役の従来の強さ → 役一覧順 → 列挙順。
import { isRed, SUITS, type Piece } from './types';
import { LEGACY_NUMBER_STRENGTH, roleValue, type SuitKey } from './roleTable';

export type NumberRole =
  | 'four_card' // フォーカード 同数字4個
  | 'nikoniko' // ニコニコ 異なる数字のペア2組
  | 'straight' // ストレート 1234 / 3456
  | 'high_straight' // ハイストレート 2345
  | 'full_card' // フルカード 同数字6個
  | 'nikoniko_niko' // ニコニコニコ 異なる数字の3個組2組
  | 'super_straight'; // スーパーストレート 123456

export type SuitRole = 'same_color' | 'all_mark' | 'flush';


export interface RoleResult {
  /** 採択した部分集合（4個または6個） */
  subset: Piece[];
  /** 採択したピースの役ストック上の位置（昇順）。成立光の区間に使う */
  indices: number[];
  size: 4 | 6;
  numberRole: NumberRole | null;
  suitRole: SuitRole | null;
  /** 同色統一の色（表示名 R08〜R11 の分岐用） */
  color: 'red' | 'black' | null;
  /** V320-FIX-06：予定消去ライン数（数値表。複合役は複合表の値。0＝不成立） */
  clear: number;
  /** V320-FIX-06：基本攻撃数（数値表。両連鎖加算・相殺前） */
  baseAttack: number;
  /** 数字役の従来の強さ（自動採択の第4順位だけに使う。数字役なしは0） */
  numberStrength: number;
}

export type StockEvaluation =
  | { kind: 'too_few' }
  /** 4個以上あるが役が成立しない */
  | { kind: 'no_role' }
  | { kind: 'ok'; result: RoleResult };

function counts(ps: readonly Piece[]): number[] {
  const c = [0, 0, 0, 0, 0, 0, 0];
  for (const p of ps) c[p.n]++;
  return c;
}

function sameSet(ns: Set<number>, want: number[]): boolean {
  return ns.size === want.length && want.every((n) => ns.has(n));
}

export function numberRole4(ps: readonly Piece[]): NumberRole | null {
  const c = counts(ps).filter((v) => v > 0).sort((a, b) => b - a);
  if (c[0] === 4) return 'four_card';
  if (c.length === 2 && c[0] === 2 && c[1] === 2) return 'nikoniko';
  const ns = new Set(ps.map((p) => p.n));
  if (sameSet(ns, [2, 3, 4, 5])) return 'high_straight';
  if (sameSet(ns, [1, 2, 3, 4]) || sameSet(ns, [3, 4, 5, 6])) return 'straight';
  return null;
}

export function numberRole6(ps: readonly Piece[]): NumberRole | null {
  const c = counts(ps).filter((v) => v > 0).sort((a, b) => b - a);
  if (c[0] === 6) return 'full_card';
  if (c.length === 2 && c[0] === 3 && c[1] === 3) return 'nikoniko_niko';
  if (sameSet(new Set(ps.map((p) => p.n)), [1, 2, 3, 4, 5, 6])) return 'super_straight';
  return null;
}

/** 成立する属性役のうち最強の1種だけを返す */
export function strongestSuitRole(ps: readonly Piece[]): { role: SuitRole; color: 'red' | 'black' | null } | null {
  const suits = new Set(ps.map((p) => p.suit));
  if (suits.size === 1) return { role: 'flush', color: null };
  if (SUITS.every((s) => suits.has(s))) return { role: 'all_mark', color: null };
  if (ps.every((p) => isRed(p.suit))) return { role: 'same_color', color: 'red' };
  if (ps.every((p) => !isRed(p.suit))) return { role: 'same_color', color: 'black' };
  return null;
}

/** 1つの部分集合を数字役・属性役とも同じ集合で評価する */
export function evaluateSubset(subset: Piece[], indices: number[] = subset.map((_, i) => i)): RoleResult {
  const size = subset.length as 4 | 6;
  const nr = size === 6 ? numberRole6(subset) : numberRole4(subset);
  const sr = strongestSuitRole(subset);
  const color = sr && sr.role === 'same_color' ? sr.color : null;
  const suitKey: SuitKey | null = !sr ? null : sr.role === 'same_color' ? (color as 'red' | 'black') : sr.role;
  const value = roleValue(size, nr, suitKey);
  return {
    subset,
    indices,
    size,
    numberRole: nr,
    suitRole: sr ? sr.role : null,
    color,
    clear: value.clear,
    baseAttack: value.attack,
    numberStrength: nr ? LEGACY_NUMBER_STRENGTH[nr] : 0,
  };
}

export function fourSubsets<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  const n = items.length;
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++) for (let d = c + 1; d < n; d++) out.push([items[a], items[b], items[c], items[d]]);
  return out;
}

/** 役一覧（統合仕様7.4 R01〜R16）の掲載順。同点時の最終採択に使う */
const NUMBER_ORDER: readonly NumberRole[] = [
  'four_card',
  'nikoniko',
  'straight',
  'high_straight',
  'full_card',
  'nikoniko_niko',
  'super_straight',
];

function suitOrder(r: RoleResult): number {
  if (r.suitRole === 'same_color') return r.color === 'black' ? 0 : 1; // R08/R10 黒 → R09/R11 赤
  if (r.suitRole === 'all_mark') return 2;
  if (r.suitRole === 'flush') return 3;
  return 4;
}

/**
 * 同じ選択段階の候補比較（V320-FIX-06 第3章）：消去数 → 基本攻撃数 → 数字役の従来の強さ → 役一覧の掲載順。
 * 負なら a を採択。完全に同じ役なら列挙順（先に見つかった部分集合）を保つ。
 */
export function compareCandidates(a: RoleResult, b: RoleResult): number {
  if (a.clear !== b.clear) return b.clear - a.clear;
  if (a.baseAttack !== b.baseAttack) return b.baseAttack - a.baseAttack;
  if (a.numberStrength !== b.numberStrength) return b.numberStrength - a.numberStrength;
  const na = a.numberRole ? NUMBER_ORDER.indexOf(a.numberRole) : NUMBER_ORDER.length;
  const nb = b.numberRole ? NUMBER_ORDER.indexOf(b.numberRole) : NUMBER_ORDER.length;
  if (na !== nb) return na - nb;
  return suitOrder(a) - suitOrder(b);
}

function pickStrongest(candidates: RoleResult[]): StockEvaluation {
  let best: RoleResult | null = null;
  for (const r of candidates) if (r.clear > 0 && (!best || compareCandidates(r, best) < 0)) best = r;
  return best ? { kind: 'ok', result: best } : { kind: 'no_role' };
}

/**
 * 役ストック（最大6個）の評価。並びが連続している必要はない（全組合せ評価）。
 * 4個：その4個。5個：5通りの4個部分集合から最強。
 * 6個：6個全体で成立する役（6個役）を優先。無ければ15通りの4個部分集合から最強。
 * 同点は compareCandidates で自動採択する（選択UIなし）。
 */
export function evaluateStock(stock: readonly Piece[]): StockEvaluation {
  if (stock.length < 4) return { kind: 'too_few' };
  if (stock.length === 6) {
    const whole = evaluateSubset([...stock], [0, 1, 2, 3, 4, 5]);
    if (whole.clear > 0) return { kind: 'ok', result: whole };
  }
  const idx = stock.map((_, i) => i);
  return pickStrongest(fourSubsets(idx).map((ix) => evaluateSubset(ix.map((i) => stock[i]), ix)));
}

/** 採択位置を連続区間に分割（成立光の囲み単位）。例 [0,1,3,4] → [[0,2],[3,2]]（開始位置・長さ） */
export function glowSegments(indices: readonly number[]): Array<{ start: number; length: number }> {
  const sorted = [...indices].sort((a, b) => a - b);
  const out: Array<{ start: number; length: number }> = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && last.start + last.length === i) last.length++;
    else out.push({ start: i, length: 1 });
  }
  return out;
}

const NUMBER_LOGO: Record<NumberRole, number> = {
  four_card: 0,
  nikoniko: 1,
  straight: 2,
  high_straight: 3,
  full_card: 4,
  nikoniko_niko: 5,
  super_straight: 6,
};

/**
 * 表示する役名ロゴ（S7 role_index = R番号-1）の列。
 * 判定（数値表）とは分離した表示名の対応。R08〜R11・R16 は暫定名。
 * 専用ロゴがあるストレートフラッシュ系（R14〜R16）は専用ロゴだけ。それ以外の複合は数字役→属性役の順（確定）。
 */
export function roleLogoIndices(r: RoleResult): number[] {
  const flush = r.suitRole === 'flush';
  if (flush && r.numberRole === 'straight') return [13];
  if (flush && r.numberRole === 'high_straight') return [14];
  if (flush && r.numberRole === 'super_straight') return [15];
  const out: number[] = [];
  if (r.numberRole) out.push(NUMBER_LOGO[r.numberRole]);
  if (r.suitRole === 'same_color') {
    const black = r.color === 'black';
    out.push(r.size === 4 ? (black ? 7 : 8) : black ? 9 : 10);
  } else if (r.suitRole === 'all_mark') out.push(11);
  else if (flush) out.push(12);
  return out;
}
