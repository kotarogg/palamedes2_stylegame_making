// 表示に依存しないゲームロジック共通型

export type Suit = 'spade' | 'diamond' | 'club' | 'heart';

/** S4 シートと同じ並び（各数字について ♠♦♣♥） */
export const SUITS: readonly Suit[] = ['spade', 'diamond', 'club', 'heart'];

export const NUMBERS: readonly number[] = [1, 2, 3, 4, 5, 6];

export type PlayerId = 0 | 1;
export const PLAYERS: readonly PlayerId[] = [0, 1];

export interface Piece {
  /** 盤面・移動中・ストックを通じて一意の論理ID */
  readonly id: number;
  readonly n: number;
  readonly suit: Suit;
}

export const isRed = (s: Suit): boolean => s === 'diamond' || s === 'heart';

export const COLS = 6;
/** 盤面の表示段数（7段＝危険） */
export const ROWS = 7;
