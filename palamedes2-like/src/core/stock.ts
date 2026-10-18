import type { Piece } from './types';

export const ROLE_STOCK_MAX = 6;

/**
 * 役ストックへ追加（SNAP）。7個目は左端の最古を破棄し、残りを左詰めして右端へ追加。
 * 新しい配列を返し、破棄したピースがあれば discarded に入れる。
 */
export function pushRoleStock(stock: readonly Piece[], p: Piece): { stock: Piece[]; discarded: Piece | null } {
  if (stock.length < ROLE_STOCK_MAX) return { stock: [...stock, p], discarded: null };
  return { stock: [...stock.slice(1), p], discarded: stock[0] };
}
