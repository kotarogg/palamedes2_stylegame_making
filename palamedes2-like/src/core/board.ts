// 盤面の論理配列。列は「足場（キャラの立つ線）」から下へ吊り下がる並びで、
// index 0 が最上段（発射・B対象）。最長列が盤面下端に接し、上昇は各列の下へ1個ずつ追加する。
import { COLS, type Piece } from './types';

export type Slot =
  | { kind: 'piece'; piece: Piece }
  /** 発射中・帰還待ちのピースの予約空白（通常の空きセルではない） */
  | { kind: 'reserved'; pieceId: number };

export class Board {
  readonly cols: Slot[][];

  constructor(cols?: Slot[][]) {
    this.cols = cols ?? Array.from({ length: COLS }, () => []);
  }

  clone(): Board {
    return new Board(this.cols.map((c) => c.map((s) => ({ ...s }))));
  }

  /** 予約空白を含む最長列の段数（盤面の高さ） */
  height(): number {
    return Math.max(0, ...this.cols.map((c) => c.length));
  }

  top(col: number): Slot | undefined {
    return this.cols[col][0];
  }

  isReserved(col: number): boolean {
    return this.cols[col][0]?.kind === 'reserved';
  }

  /** 発射：最上段を予約空白へ置き換える（列は詰めない） */
  reserveTop(col: number): Piece {
    const s = this.cols[col][0];
    if (!s || s.kind !== 'piece') throw new Error(`column ${col} has no launchable piece`);
    this.cols[col][0] = { kind: 'reserved', pieceId: s.piece.id };
    return s.piece;
  }

  private reservedIndex(col: number, pieceId: number): number {
    const i = this.cols[col].findIndex((s) => s.kind === 'reserved' && s.pieceId === pieceId);
    if (i < 0) throw new Error(`reservation for piece ${pieceId} not found in column ${col}`);
    return i;
  }

  /** 成功到達：予約を解除し、残りを上へ詰める */
  releaseReservation(col: number, pieceId: number): void {
    this.cols[col].splice(this.reservedIndex(col, pieceId), 1);
  }

  /** 失敗帰還完了：予約空白へピースを戻す */
  fillReservation(col: number, piece: Piece): void {
    this.cols[col][this.reservedIndex(col, piece.id)] = { kind: 'piece', piece };
  }

  /** B：最上段を最下段へ循環し、残りを上へ詰める */
  rotate(col: number): void {
    const c = this.cols[col];
    const top = c.shift();
    if (top) c.push(top);
  }

  /** 上昇・攻撃行追加：各列の下へ1個ずつ追加 */
  appendRow(row: readonly Piece[]): void {
    if (row.length !== COLS) throw new Error('row must have 6 pieces');
    row.forEach((p, i) => this.cols[i].push({ kind: 'piece', piece: p }));
  }

  /** 盤面上の全ピースID（予約は pieceId として含む） */
  allIds(): number[] {
    return this.cols.flatMap((c) => c.map((s) => (s.kind === 'piece' ? s.piece.id : s.pieceId)));
  }
}
