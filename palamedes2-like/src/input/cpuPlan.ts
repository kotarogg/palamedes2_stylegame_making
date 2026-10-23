// CPU の取得経路の探索と所要時間の見積り（v3.1.0）。判断に使うのはプレイヤーに見える情報だけ：
// 共通基準（場のカード）、自分の盤面（帰還中の予約を含む）、役ストック。未来のランダムピースは知らない前提。
// 盤面を書き換えない（写しで探索する）。探索の深さは今回必要な残り取得数に限定する。
import type { Board } from '../core/board';
import { isLaunchSuccess } from '../core/pieces';
import { evaluateStock, evaluateSubset } from '../core/roles';
import { pushRoleStock } from '../core/stock';
import type { Piece } from '../core/types';

/** 取得経路の時間見積りに使う既存の操作時間（ms） */
export interface PlanTiming {
  /** 列移動1歩 */
  charMoveMs: number;
  /** 打ち上げ（飛行＝操作硬直） */
  launchMs: number;
  /** 成功取得後の上詰め硬直 */
  packMs: number;
}

/** 目標：4＝役（4ピース役以上）を作る、6＝6ピース役（6個全体の役）を作る、any＝最短で成立可能な役 */
export type Goal = 4 | 6 | 'any';

export interface Candidate {
  col: number;
  piece: Piece;
}

/** 盤面の写し（各列：上から。null＝帰還予約など打ち上げ不可の最上段で、その列は塞がる） */
type SimCols = (Piece | null)[][];

export function simCols(board: Board): SimCols {
  return board.cols.map((c) => c.map((s) => (s.kind === 'piece' ? s.piece : null)));
}

/** 取得可能な候補：最上段が打ち上げ可能なピースで、基準に対して成功する列 */
export function candidatesOf(cols: SimCols, base: Piece): Candidate[] {
  const out: Candidate[] = [];
  cols.forEach((c, col) => {
    const top = c[0];
    if (top && isLaunchSuccess(top, base)) out.push({ col, piece: top });
  });
  return out;
}

/** 1回の取得（移動＋打ち上げ＋上詰め硬直）の所要時間 */
export function acquireMs(from: number, to: number, t: PlanTiming): number {
  return Math.abs(to - from) * t.charMoveMs + t.launchMs + t.packMs;
}

export function goalReached(stock: readonly Piece[], goal: Goal): boolean {
  if (goal === 6) return stock.length === 6 && evaluateSubset([...stock], [0, 1, 2, 3, 4, 5]).han > 0;
  const ev = evaluateStock(stock);
  return ev.kind === 'ok';
}

export interface PathResult {
  /** 最初に取る候補 */
  first: Candidate;
  /** 目標達成までの取得回数 */
  steps: number;
  /** 目標達成までの所要時間（ms） */
  ms: number;
}

/**
 * 目標までの最短経路（所要時間）を、最初に取る候補ごとに求める。maxDepth を超える経路は探さない。
 * 返り値は最初の候補の列 → 最短の経路。達成不能な候補は含めない。
 */
export function shortestPaths(cols: SimCols, base: Piece, stock: readonly Piece[], fromCol: number, goal: Goal, maxDepth: number, t: PlanTiming): Map<number, PathResult> {
  const best = new Map<number, PathResult>();
  if (maxDepth <= 0) return best;
  const dfs = (cs: SimCols, b: Piece, st: readonly Piece[], at: number, depth: number, ms: number, first: Candidate | null) => {
    for (const c of candidatesOf(cs, b)) {
      const f = first ?? c;
      const nms = ms + acquireMs(at, c.col, t);
      const prev = best.get(f.col);
      if (prev && prev.ms <= nms) continue; // 同じ最初の候補でより速い経路が既にある
      const next = pushRoleStock(st, c.piece).stock;
      if (goalReached(next, goal)) {
        best.set(f.col, { first: f, steps: depth + 1, ms: nms });
        continue;
      }
      if (depth + 1 >= maxDepth) continue;
      const ncs = cs.map((col, i) => (i === c.col ? col.slice(1) : col));
      dfs(ncs, c.piece, next, c.col, depth + 1, nms, f);
    }
  };
  dfs(cols, base, stock, fromCol, 0, 0, null);
  return best;
}

/** 目標までに必要な残り取得数（探索の深さ）。手元6は押し出しを伴うため最大2回まで見る */
export function depthFor(goal: Goal, hand: number): number {
  if (goal === 6) return Math.max(0, 6 - hand);
  if (hand < 4) return 4 - hand;
  return hand >= 6 ? 2 : Math.min(2, 6 - hand);
}

/** MODE2：取得後にも出せる候補の数（取った列の次のピースを含む） */
export function remainingAfter(cols: SimCols, c: Candidate): number {
  const ncs = cols.map((col, i) => (i === c.col ? col.slice(1) : col));
  return candidatesOf(ncs, c.piece).length;
}
