// 差し替え可能な乱数源。テストでは固定列を注入できる。

export interface Rng {
  /** [0,1) の一様乱数 */
  next(): number;
}

/** 再現性のある既定乱数（mulberry32） */
export function createSeededRng(seed: number): Rng {
  let a = seed >>> 0;
  return {
    next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/** 指定した値を順に返す（テスト用）。尽きたら先頭へ戻る */
export function createSequenceRng(values: readonly number[]): Rng {
  let i = 0;
  return {
    next() {
      const v = values[i % values.length];
      i++;
      return v;
    },
  };
}

export function randomInt(rng: Rng, n: number): number {
  return Math.min(n - 1, Math.floor(rng.next() * n));
}
