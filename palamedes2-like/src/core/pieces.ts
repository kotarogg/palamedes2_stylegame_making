import { randomInt, type Rng } from './rng';
import { NUMBERS, SUITS, type Piece, type Suit } from './types';

/** 24種（数字1〜6×属性4）。インデックス = (n-1)*4 + suitIndex */
export function kindIndex(n: number, suit: Suit): number {
  return (n - 1) * 4 + SUITS.indexOf(suit);
}

export function kindFromIndex(i: number): { n: number; suit: Suit } {
  return { n: NUMBERS[Math.floor(i / 4)], suit: SUITS[i % 4] };
}

/** ピース生成。原則24種均等。IDは生成器全体で一意 */
export class PieceFactory {
  private nextId = 1;

  create(rng: Rng): Piece {
    const k = kindFromIndex(randomInt(rng, 24));
    return { id: this.nextId++, n: k.n, suit: k.suit };
  }

  /** テスト・検証用：種類を指定して生成 */
  make(n: number, suit: Suit): Piece {
    return { id: this.nextId++, n, suit };
  }
}

/**
 * 打ち上げ成功判定（共通基準へ到達した時点で呼ぶ）。
 * 数字一致・数字隣接（1と6も隣接）・属性一致のいずれか。
 */
export function isLaunchSuccess(p: { n: number; suit: Suit }, base: { n: number; suit: Suit }): boolean {
  const d = Math.abs(p.n - base.n);
  return d === 0 || d === 1 || d === 5 || p.suit === base.suit;
}

export const pieceLabel = (p: { n: number; suit: Suit }): string =>
  `${p.n}${{ spade: '♠', diamond: '♦', club: '♣', heart: '♥' }[p.suit]}`;
