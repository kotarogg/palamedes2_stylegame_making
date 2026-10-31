// V320-FIX-06 第2〜5章：役の数値表（単独15行・複合28組）、自動採択（消去→基本攻撃）、打上連鎖の固定加算と上限99、
// 通常攻撃力＝基本攻撃＋打上連鎖加算＋役連鎖加算（最大14）、盤面不足、シングルの実消去、相殺1対1
import { describe, expect, it } from 'vitest';
import { roleVoiceLine } from '../src/audio/audioMap';
import { computeAttack, resolveCounter, STREAK_ATTACK_BONUS, streakAttackBonus } from '../src/core/attack';
import { DEFAULT_CONFIG } from '../src/core/config';
import { Game, type Command, type GameEvent } from '../src/core/game';
import { COMBO, LEGACY_NUMBER_STRENGTH, MAX_BASE_ATTACK, NUMBER_ONLY, roleValue, SUIT_ONLY } from '../src/core/roleTable';
import { evaluateStock, evaluateSubset, roleLogoIndices, type NumberRole } from '../src/core/roles';
import type { PlayerId } from '../src/core/types';
import { GameView } from '../src/view/gameView';
import { EMPTY, fakeAssets, kind, makeGame, rows, setStock, stepN, testConfig, toPlay } from './helpers';

let id = 1;
const ps = (codes: string[]) => codes.map((c) => ({ id: id++, ...kind(c) }));
const cmd = (player: PlayerId, type: Command['type']): Command => ({ player, type }) as Command;
const evs = <T extends GameEvent['type']>(events: GameEvent[], type: T) => events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);
const cv = (r: { clear: number; baseAttack: number }) => `${r.clear}/${r.baseAttack}`;

/** 数字の並び（4個役・6個役） */
const NUMBERS: Record<NumberRole, number[]> = {
  four_card: [3, 3, 3, 3],
  nikoniko: [2, 2, 5, 5],
  straight: [1, 2, 3, 4],
  high_straight: [2, 3, 4, 5],
  full_card: [4, 4, 4, 4, 4, 4],
  nikoniko_niko: [1, 1, 1, 6, 6, 6],
  super_straight: [1, 2, 3, 4, 5, 6],
};
/** 記号の並び（属性役なし／黒統一／赤統一／オールマーク／フラッシュ） */
const SUITS = {
  none: ['s', 'd', 's', 'd', 's', 'd'],
  black: ['s', 'c', 's', 'c', 's', 'c'],
  red: ['d', 'h', 'd', 'h', 'd', 'h'],
  all_mark: ['s', 'd', 'c', 'h', 's', 'd'],
  flush: ['s', 's', 's', 's', 's', 's'],
} as const;
const make = (ns: number[], suit: keyof typeof SUITS) => ps(ns.map((n, i) => `${n}${SUITS[suit][i]}`));

describe('第2章 役の数値表（依頼書の確定値）', () => {
  // 依頼書 2.1 の表をそのまま転記（実装の表と独立に照合する）
  const SPEC_SINGLE: [string, number[], keyof typeof SUITS, string][] = [
    ['フォーカード', NUMBERS.four_card, 'none', '2/2'],
    ['ニコニコ', NUMBERS.nikoniko, 'none', '2/2'],
    ['ストレート', NUMBERS.straight, 'none', '2/2'],
    ['ハイストレート', NUMBERS.high_straight, 'none', '3/3'],
    ['フルカード', NUMBERS.full_card, 'none', '4/5'],
    ['ニコニコニコ', NUMBERS.nikoniko_niko, 'none', '4/5'],
    ['スーパーストレート', NUMBERS.super_straight, 'none', '4/5'],
    ['フォーブラック', [1, 3, 5, 6], 'black', '2/1'],
    ['フォーレッド', [1, 3, 5, 6], 'red', '2/1'],
    ['オールブラック', [1, 1, 3, 4, 5, 6], 'black', '3/2'],
    ['オールレッド', [1, 1, 3, 4, 5, 6], 'red', '3/2'],
    ['オールマーク4個', [1, 3, 5, 6], 'all_mark', '2/2'],
    ['オールマーク6個', [1, 1, 3, 4, 5, 6], 'all_mark', '3/3'],
    ['フラッシュ4個', [1, 3, 5, 6], 'flush', '3/2'],
    ['フラッシュ6個', [1, 1, 3, 4, 5, 6], 'flush', '4/3'],
  ];

  it.each(SPEC_SINGLE)('単独役 %s（15行）', (_name, ns, suit, want) => {
    const r = evaluateSubset(make(ns, suit));
    expect(!!r.numberRole !== !!r.suitRole).toBe(true); // 片方だけ成立
    expect(cv(r)).toBe(want);
  });

  // 依頼書 2.2 の表（黒統一／赤統一／オールマーク／フラッシュ）
  const SPEC_COMBO: Record<NumberRole, [string, string, string, string]> = {
    four_card: ['3/3', '3/3', '3/4', '4/4'],
    nikoniko: ['3/3', '3/3', '3/4', '4/4'],
    straight: ['3/3', '3/3', '3/4', '4/4'],
    high_straight: ['4/4', '4/4', '4/5', '5/5'],
    full_card: ['5/6', '5/6', '5/7', '6/8'],
    nikoniko_niko: ['5/6', '5/6', '5/7', '6/8'],
    super_straight: ['5/6', '5/6', '5/7', '6/8'],
  };

  it('複合役28組：同じ採択集合で数字役＋属性役が成立したら複合表の値（単独役の再合算・大きい方＋1ではない）', () => {
    let n = 0;
    for (const [nr, want] of Object.entries(SPEC_COMBO) as [NumberRole, string[]][]) {
      (['black', 'red', 'all_mark', 'flush'] as const).forEach((suit, i) => {
        const r = evaluateSubset(make(NUMBERS[nr], suit));
        expect([r.numberRole, r.suitRole], `${nr}+${suit}`).toEqual([nr, suit === 'black' || suit === 'red' ? 'same_color' : suit]);
        expect(cv(r), `${nr}+${suit}`).toBe(want[i]);
        // 再合算でないことの確認（単独役の和と一致しない組がある）
        n++;
      });
    }
    expect(n).toBe(28);
    // 例：フルカード＋フラッシュは単独 4/5＋4/3＝8/8 ではなく 6/8、フォーカード＋黒統一は 4/3 ではなく 3/3
    expect(cv(evaluateSubset(make(NUMBERS.full_card, 'flush')))).toBe('6/8');
    expect(cv(evaluateSubset(make(NUMBERS.four_card, 'black')))).toBe('3/3');
  });

  it('実装の表（roleTable.ts）が依頼書の表と一致。基本攻撃の最大は8、旧数字役ボーナスの表は持たない', () => {
    expect(Object.fromEntries(Object.entries(NUMBER_ONLY).map(([k, v]) => [k, `${v.clear}/${v.attack}`]))).toEqual({
      four_card: '2/2', nikoniko: '2/2', straight: '2/2', high_straight: '3/3', full_card: '4/5', nikoniko_niko: '4/5', super_straight: '4/5',
    });
    expect([SUIT_ONLY[4], SUIT_ONLY[6]].map((t) => Object.values(t).map((v) => `${v.clear}/${v.attack}`))).toEqual([
      ['2/1', '2/1', '2/2', '3/2'],
      ['3/2', '3/2', '3/3', '4/3'],
    ]);
    for (const [nr, want] of Object.entries(SPEC_COMBO)) expect(Object.values(COMBO[nr as NumberRole]).map((v) => `${v.clear}/${v.attack}`)).toEqual(want);
    expect(MAX_BASE_ATTACK).toBe(Math.max(...Object.values(COMBO).flatMap((t) => Object.values(t).map((v) => v.attack))));
    expect(roleValue(4, null, null)).toEqual({ clear: 0, attack: 0 });
    // 旧翻数は自動採択の第4順位（数字役の従来の強さ）にだけ残す
    expect(LEGACY_NUMBER_STRENGTH).toEqual({ four_card: 1, nikoniko: 1, straight: 1, high_straight: 2, full_card: 3, nikoniko_niko: 3, super_straight: 3 });
  });

  it('フラッシュへ同色統一を重ねない（属性役は最強1種）。ストレートフラッシュ系3種は専用ロゴ1つで、専用名による追加加算なし', () => {
    const f = evaluateSubset(make([1, 3, 5, 6], 'flush'));
    expect([f.suitRole, f.color, cv(f)]).toEqual(['flush', null, '3/2']);
    expect(roleLogoIndices(f)).toEqual([12]);
    const sf = evaluateSubset(make(NUMBERS.straight, 'flush'));
    const hsf = evaluateSubset(make(NUMBERS.high_straight, 'flush'));
    const ssf = evaluateSubset(make(NUMBERS.super_straight, 'flush'));
    expect([sf, hsf, ssf].map((r) => [roleLogoIndices(r), cv(r)])).toEqual([
      [[13], '4/4'],
      [[14], '5/5'],
      [[15], '6/8'],
    ]);
    // ストレートフラッシュ（専用ロゴ）＝ストレート＋フラッシュの複合表の値と同じ
    expect(cv(sf)).toBe(`${COMBO.straight.flush.clear}/${COMBO.straight.flush.attack}`);
    // 色の大小役：4個はフォー〜、6個はオール〜
    expect(roleLogoIndices(evaluateSubset(make([1, 3, 5, 6], 'black')))).toEqual([7]);
    expect(roleLogoIndices(evaluateSubset(make([1, 1, 3, 4, 5, 6], 'red')))).toEqual([10]);
  });
});

describe('第3章 自動採択と表示整合', () => {
  it('6個全体の成立を優先 → 消去数 → 基本攻撃数 → 数字役の従来の強さ → 役一覧順 → 列挙順', () => {
    // 6個全体：オールマーク6個（3/3）。4個部分集合にフォーカード＋オールマーク（3/4）があっても6個全体を優先
    const whole = evaluateStock(ps(['1s', '1d', '1c', '1h', '3s', '5d']));
    expect(whole.kind === 'ok' && [whole.result.size, cv(whole.result)]).toEqual([6, '3/3']);
    // 消去同数（3）：ハイストレート 3/3 ＞ フラッシュ4個 3/2
    const r = evaluateStock(ps(['2h', '3h', '4h', '5c', '6h']));
    expect(r.kind === 'ok' && [r.result.numberRole, cv(r.result)]).toEqual(['high_straight', '3/3']);
    // 5個は5通り（同じ値なら先に列挙された集合）
    const e = evaluateStock(ps(['1s', '2s', '3s', '4s', '1s']));
    expect(e.kind === 'ok' && e.result.indices).toEqual([0, 1, 2, 3]);
  });

  it('成立光（宣言前の採用位置）・宣言結果・役名ロゴ・代表ボイスの選定元が同じ採択結果', () => {
    const g = makeGame({ boards: { 0: rows(4), 1: EMPTY } });
    const v = new GameView(g, fakeAssets());
    setStock(g, 0, '2h', '3h', '4h', '5c', '6h');
    toPlay(g);
    const glow = v.glowTargets(0, g.tick)!;
    g.step([cmd(0, 'declare')]);
    const d = evs(g.events, 'declare')[0];
    expect(glow.indices).toEqual(d.result.indices);
    expect(d.result.indices).toEqual([0, 1, 2, 3]); // 2♥3♥4♥5♣（ハイストレート）
    expect(d.logos).toEqual(roleLogoIndices(d.result));
    expect(d.logos).toEqual([3]);
    expect(roleVoiceLine(d.logos[0])).toBe('role_04'); // 代表ボイス＝表示順の先頭ロゴ
    expect(d.consumed).toHaveLength(5); // 採択外を含め手役ストック全体を消費
    expect(g.players[0].roleStock).toEqual([]);
  });
});

describe('第4章 連鎖による攻撃加算と計算式', () => {
  it('打上連鎖：0〜4＋0、5〜9＋1、10〜99＋2（4→5、9→10、98→99 の境界）。役連鎖は現行（＋0〜＋4）', () => {
    expect(STREAK_ATTACK_BONUS).toEqual(DEFAULT_CONFIG.streakAttackBonus);
    expect([0, 4, 5, 9, 10, 98, 99].map((n) => streakAttackBonus(n))).toEqual([0, 0, 1, 1, 2, 2, 2]);
    expect([1, 2, 3, 4, 5, 6].map((c) => computeAttack(0, 0, c).chainBonus)).toEqual([0, 1, 2, 3, 4, 4]);
    expect(DEFAULT_CONFIG.streakMaxCount).toBe(99);
  });

  it('打上連鎖の上限99：98→99、99の後の成功も99のまま（攻撃加算は増えない）', () => {
    const g = makeGame({ base: '1s', boards: { 0: { 2: ['2s', '3s', '4s'] }, 1: EMPTY } });
    toPlay(g);
    const p = g.players[0];
    p.streakCount = 98;
    for (let i = 0; i < 3; i++) {
      g.step([cmd(0, 'launch')]);
      stepN(g, g.ticks(g.config.timing.launchMs) + g.ticks(g.config.timing.packMs) + 1);
    }
    expect(evs(g.events, 'arrive').map((a) => [a.success, a.streak])).toEqual([
      [true, 99],
      [true, 99],
      [true, 99],
    ]);
    expect(g.currentStreakBonus(p)).toBe(2);
  });

  it('切断予約：有効な連鎖中の1回目の失敗で予約、予約後の成功で解除されず、予約中の次の失敗で切断。連鎖がなければヒビ付き0連鎖を作らない', () => {
    const board = { 0: ['4d', '5c'], 1: ['2s', '5c'], 2: ['4h', '5c'], 3: ['4c', '5c'] };
    const g = makeGame({ base: '1s', boards: { 0: board, 1: EMPTY } });
    toPlay(g);
    const p = g.players[0];
    const shot = (col: number) => {
      p.selectedCol = col;
      g.step([cmd(0, 'launch')]);
      while (g.flights.some((f) => f.player === 0) || g.isLocked(p)) g.step();
    };
    shot(3); // 連鎖なしの失敗：予約を作らない
    expect([p.streakCount, p.streakCutReserved]).toEqual([0, false]);
    p.streakCount = 5;
    shot(0); // 失敗 → 予約
    expect([p.streakCount, p.streakCutReserved]).toEqual([5, true]);
    shot(1); // 成功 → 6、予約は残る
    expect([p.streakCount, p.streakCutReserved]).toEqual([6, true]);
    shot(2); // 予約中の失敗 → 切断
    expect([p.streakCount, p.streakCutReserved]).toEqual([0, false]);
    expect(evs(g.events, 'streakCut').map((e) => e.state)).toEqual(['reserved', 'ended']);
  });

  it('最大攻撃14＝基本8（フルカード＋フラッシュ）＋打上連鎖＋2＋役連鎖＋4。宣言時点の値で確定し、処理途中の変化で再計算しない', () => {
    const g = makeGame({ boards: { 0: rows(7), 1: EMPTY } });
    setStock(g, 0, '3s', '3s', '3s', '3s', '3s', '3s');
    toPlay(g);
    const p = g.players[0];
    p.streakCount = 12;
    p.chainCount = 4;
    p.chainRemaining = 100;
    g.step([cmd(0, 'declare')]);
    const d = evs(g.events, 'declare')[0];
    expect([d.result.numberRole, d.result.suitRole, cv(d.result), d.chainCount, d.streak, d.streakBonus]).toEqual(['full_card', 'flush', '6/8', 5, 12, 2]);
    p.streakCount = 0; // 処理途中の変化（攻撃は宣言時点のスナップショット）
    stepN(g, 600);
    const a = evs(g.events, 'attack')[0];
    expect(a.breakdown).toEqual({ base: 8, streakCount: 12, streakBonus: 2, chainBonus: 4, power: 14 });
    expect(a.linesCleared).toBe(6); // 自フィールドの消去数は連鎖の影響を受けない
  });

  it('盤面不足：存在する分まで消去して打ち切り、攻撃数は減らさない', () => {
    const g = makeGame({ boards: { 0: rows(2), 1: EMPTY } });
    setStock(g, 0, '1c', '2c', '3c', '4c', '5c', '6c'); // スーパーストレートフラッシュ 6/8
    toPlay(g);
    g.step([cmd(0, 'declare')]);
    stepN(g, 400);
    const a = evs(g.events, 'attack')[0];
    expect(evs(g.events, 'lineClear')).toHaveLength(2);
    expect([a.linesCleared, a.breakdown.power, a.counter.sent]).toEqual([2, 8, 8]);
  });

  it('シングル：実行された消去ラインだけ得点・ノルマ（1ライン＝6個、100点×宣言時の得点倍率）。攻撃送信なし', () => {
    const g = new Game({
      seed: 3,
      config: testConfig(),
      single: { kind: 'stage', stage: 1 },
      setup: (x) => {
        x.players[0].board.cols.forEach((_c, i) => (x.players[0].board.cols[i] = [0, 1].map(() => ({ kind: 'piece' as const, piece: x.factory.make(5, 'club') }))));
        x.players[0].roleStock = [1, 2, 3, 4, 5, 6].map((n) => x.factory.make(n, 'heart')); // 消去6
      },
    });
    while (!g.playing) g.step();
    g.step([cmd(0, 'declare')]);
    stepN(g, 400);
    const line = evs(g.events, 'score').filter((e) => e.cause === 'line');
    expect(line.map((e) => e.delta)).toEqual([100, 100]);
    expect(evs(g.events, 'progress').map((e) => e.units)).toEqual([6, 6]);
    expect(evs(g.events, 'attack')[0].counter.sent).toBe(0);
  });
});

describe('第5章 相殺1対1', () => {
  it('依頼書の例：攻撃3・待機0／1／3／5', () => {
    const ex = [0, 1, 3, 5].map((w) => {
      const c = resolveCounter(3, w, DEFAULT_CONFIG.counterPerLine);
      return { 相殺: c.canceled, 送信: c.sent, 待機残: w - c.canceled };
    });
    expect(ex).toEqual([
      { 相殺: 0, 送信: 3, 待機残: 0 },
      { 相殺: 1, 送信: 2, 待機残: 0 },
      { 相殺: 3, 送信: 0, 待機残: 0 },
      { 相殺: 3, 送信: 0, 待機残: 2 },
    ]);
  });

  it('本編：次ブロック待機分だけを1対1で相殺し、残りを送信（現ブロック未消化分・進行中の波は対象外）', () => {
    const g = makeGame({ boards: { 0: rows(4), 1: EMPTY } });
    toPlay(g);
    g.step([{ player: 0, type: 'debugAttack', lines: 6 } as Command]);
    stepN(g, 120); // 現ブロック6開始
    g.step([{ player: 0, type: 'debugAttack', lines: 2 } as Command]); // 次ブロック待機2
    const s = g.players[0].incoming;
    const block = s.blockRemaining + s.waveRemaining;
    setStock(g, 0, '1s', '2s', '3s', '4s'); // 攻撃4
    g.step([cmd(0, 'declare')]);
    stepN(g, 400);
    const a = evs(g.events, 'attack')[0];
    expect(a.counter).toEqual({ usedPower: 2, canceled: 2, sent: 2, discarded: 0 });
    expect(s.stats.canceled).toBe(2);
    expect(block).toBeGreaterThan(0); // 現ブロックの残りは相殺されずに適用される
    expect(evs(g.events, 'attackRow').filter((e) => e.player === 0).length).toBe(6);
  });
});
