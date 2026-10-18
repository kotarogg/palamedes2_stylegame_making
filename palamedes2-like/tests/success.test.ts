import { describe, expect, it } from 'vitest';
import { isLaunchSuccess, kindFromIndex, kindIndex, PieceFactory } from '../src/core/pieces';
import { createSeededRng, createSequenceRng } from '../src/core/rng';
import { NUMBERS, SUITS } from '../src/core/types';

/** 独立した期待値：環状の隣接を「次・前」の列挙で作る */
function expected(a: { n: number; suit: string }, b: { n: number; suit: string }): boolean {
  const next = (n: number) => (n % 6) + 1;
  const prev = (n: number) => ((n + 4) % 6) + 1;
  return a.n === b.n || next(a.n) === b.n || prev(a.n) === b.n || a.suit === b.suit;
}

describe('打ち上げ成功判定（到達時）', () => {
  it('24×24 全組合せが独立期待値と一致する', () => {
    let count = 0;
    let successes = 0;
    for (const n1 of NUMBERS)
      for (const s1 of SUITS)
        for (const n2 of NUMBERS)
          for (const s2 of SUITS) {
            const a = { n: n1, suit: s1 };
            const b = { n: n2, suit: s2 };
            expect(isLaunchSuccess(a, b), `${n1}${s1} -> ${n2}${s2}`).toBe(expected(a, b));
            count++;
            if (isLaunchSuccess(a, b)) successes++;
          }
    expect(count).toBe(576);
    // 数字一致/隣接で 3/6、属性一致は残り 3/6 のうち 1/4 → 24*(12+3)=360
    expect(successes).toBe(360);
  });

  it('1と6は隣接、属性一致は数字によらず成功、それ以外は失敗', () => {
    expect(isLaunchSuccess({ n: 1, suit: 'spade' }, { n: 6, suit: 'heart' })).toBe(true);
    expect(isLaunchSuccess({ n: 6, suit: 'club' }, { n: 1, suit: 'diamond' })).toBe(true);
    expect(isLaunchSuccess({ n: 4, suit: 'heart' }, { n: 1, suit: 'heart' })).toBe(true);
    expect(isLaunchSuccess({ n: 4, suit: 'heart' }, { n: 1, suit: 'spade' })).toBe(false);
    expect(isLaunchSuccess({ n: 3, suit: 'club' }, { n: 6, suit: 'diamond' })).toBe(false);
  });
});

describe('ピース生成', () => {
  it('24種のインデックスが相互変換でき、S4の並び（数字昇順・♠♦♣♥）と一致', () => {
    for (let i = 0; i < 24; i++) {
      const k = kindFromIndex(i);
      expect(kindIndex(k.n, k.suit)).toBe(i);
    }
    expect(kindFromIndex(1)).toEqual({ n: 1, suit: 'diamond' });
    expect(kindFromIndex(23)).toEqual({ n: 6, suit: 'heart' });
  });

  it('乱数源を差し替えでき、既定乱数で24種がほぼ均等に出る', () => {
    const f = new PieceFactory();
    const fixed = createSequenceRng([0, 23.5 / 24]);
    expect(f.create(fixed)).toMatchObject({ n: 1, suit: 'spade' });
    expect(f.create(fixed)).toMatchObject({ n: 6, suit: 'heart' });
    const rng = createSeededRng(42);
    const hist = Array(24).fill(0);
    const N = 240000;
    for (let i = 0; i < N; i++) {
      const p = f.create(rng);
      hist[kindIndex(p.n, p.suit)]++;
    }
    for (const h of hist) expect(Math.abs(h - N / 24) / (N / 24)).toBeLessThan(0.03);
  });

  it('IDは一意', () => {
    const f = new PieceFactory();
    const rng = createSeededRng(1);
    const ids = new Set(Array.from({ length: 1000 }, () => f.create(rng).id));
    expect(ids.size).toBe(1000);
  });
});
