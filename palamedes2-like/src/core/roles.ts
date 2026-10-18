// 役判定（統合仕様 第6〜7章）。翻数は攻撃量換算とは別物（換算式は未確定 G01）。
import { isRed, SUITS, type Piece } from './types';

export type NumberRole =
  | 'four_card' // フォーカード 同数字4個
  | 'nikoniko' // ニコニコ 異なる数字のペア2組
  | 'straight' // ストレート 1234 / 3456
  | 'high_straight' // ハイストレート 2345
  | 'full_card' // フルカード 同数字6個
  | 'nikoniko_niko' // ニコニコニコ 異なる数字の3個組2組
  | 'super_straight'; // スーパーストレート 123456

export type SuitRole = 'same_color' | 'all_mark' | 'flush';

export const NUMBER_ROLE_HAN: Record<NumberRole, number> = {
  four_card: 1,
  nikoniko: 1,
  straight: 1,
  high_straight: 2,
  full_card: 3,
  nikoniko_niko: 3,
  super_straight: 3,
};

export const SUIT_ROLE_HAN: Record<SuitRole, number> = { same_color: 1, all_mark: 2, flush: 3 };

export interface RoleResult {
  /** 採択した部分集合（4個または6個） */
  subset: Piece[];
  size: 4 | 6;
  numberRole: NumberRole | null;
  suitRole: SuitRole | null;
  /** 同色統一の色（表示名 R08〜R11 の分岐用） */
  color: 'red' | 'black' | null;
  /** 数字役＋属性役（最強1種）の翻数合計。複合表示名で二重加算しない */
  han: number;
}

export type StockEvaluation =
  | { kind: 'too_few' }
  /** 4個以上あるが役が成立しない。無役宣言の扱いは未確定（G04） */
  | { kind: 'no_role' }
  /** 最強候補が同翻数で複数種類。同点役の優先順位は未確定（G04） */
  | { kind: 'tie'; candidates: RoleResult[] }
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
export function evaluateSubset(subset: Piece[]): RoleResult {
  const size = subset.length as 4 | 6;
  const nr = size === 6 ? numberRole6(subset) : numberRole4(subset);
  const sr = strongestSuitRole(subset);
  const han = (nr ? NUMBER_ROLE_HAN[nr] : 0) + (sr ? SUIT_ROLE_HAN[sr.role] : 0);
  return {
    subset,
    size,
    numberRole: nr,
    suitRole: sr ? sr.role : null,
    color: sr && sr.role === 'same_color' ? sr.color : null,
    han,
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

const signature = (r: RoleResult) => `${r.size}:${r.numberRole ?? '-'}:${r.suitRole ?? '-'}:${r.color ?? '-'}`;

function pickStrongest(candidates: RoleResult[]): StockEvaluation {
  const valid = candidates.filter((r) => r.han > 0);
  if (valid.length === 0) return { kind: 'no_role' };
  const max = Math.max(...valid.map((r) => r.han));
  const bySig = new Map<string, RoleResult>();
  for (const r of valid) if (r.han === max && !bySig.has(signature(r))) bySig.set(signature(r), r);
  const top = [...bySig.values()];
  return top.length === 1 ? { kind: 'ok', result: top[0] } : { kind: 'tie', candidates: top };
}

/**
 * 役ストック（最大6個）の評価。
 * 4個：その4個。5個：5通りの4個部分集合から最強。
 * 6個：6個全体で成立する役（6個役）を優先。無ければ15通りの4個部分集合から最強。
 */
export function evaluateStock(stock: readonly Piece[]): StockEvaluation {
  if (stock.length < 4) return { kind: 'too_few' };
  if (stock.length === 6) {
    const whole = evaluateSubset([...stock]);
    if (whole.han > 0) return { kind: 'ok', result: whole };
  }
  return pickStrongest(fourSubsets(stock).map(evaluateSubset));
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
 * 判定（翻数）とは分離した表示名の対応。R08〜R11・R16 は暫定名。
 * 名称の決まっていない複合（例：フォーカード＋同色統一）は数字役→属性役の順に表示する（表示上の技術選択）。
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
