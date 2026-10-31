// v3.1.0 コア：ピンチ猶予4000ms と 3/2/1 の通知、ミス帰還の降下区間1.6倍、打ち上げ成功連鎖の新倍率と連鎖切り予約
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/core/config';
import { streakAttackBonus } from '../src/core/attack';
import type { Command, Game, GameEvent } from '../src/core/game';
import type { PlayerId } from '../src/core/types';
import { GameView } from '../src/view/gameView';
import { EMPTY, fakeAssets, makeGame, rows, setStock, stepN, testConfig, toPlay } from './helpers';

const atk = (player: PlayerId, lines: number): Command => ({ player, type: 'debugAttack', lines });
const cmd = (player: PlayerId, type: Command['type']): Command => ({ player, type }) as Command;
const evs = <T extends GameEvent['type']>(g: Game, type: T, p?: PlayerId) =>
  g.events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type && (p === undefined || ('player' in e && e.player === p)));

/** 7段の盤面で攻撃段を受け、攻撃ピンチを開始させる。開始tickを返す */
function startAttackPinch(g: Game): number {
  toPlay(g);
  g.step([atk(0, 3)]);
  while (!evs(g, 'attackPinch', 0).length) g.step();
  return evs(g, 'attackPinch', 0)[0].tick;
}

describe('v3.1.0 ピンチ：猶予4000ms、1000/2000/3000ms で 3/2/1、4000ms で期限判定', () => {
  it('到達0ms＝警告のみ（数字なし）→ 1000msで3、2000msで2、3000msで1、4000msで敗北。end で警告解除', () => {
    const g = makeGame({ boards: { 0: rows(7), 1: EMPTY } });
    const t0 = startAttackPinch(g);
    stepN(g, 300);
    const w = evs(g, 'pinchWarn', 0).map((e) => [e.state, e.value, e.tick - t0]);
    expect(w).toEqual([
      ['start', null, 0],
      ['count', 3, 60],
      ['count', 2, 120],
      ['count', 1, 180],
      ['end', null, 240],
    ]);
    expect(evs(g, 'attackPinch', 0).map((e) => [e.state, e.tick - t0])).toEqual([
      ['grace', 0],
      ['defeat', 240],
    ]);
    expect(g.result).toMatchObject({ winner: 1 });
    // 境界の直前は前の数字のまま（999ms では数字なし）
    expect(evs(g, 'pinchWarn', 0).some((e) => e.tick - t0 === 59)).toBe(false);
  });

  it('追加受信で期限を更新・延長しない', () => {
    const g = makeGame({ boards: { 0: rows(7), 1: EMPTY } });
    const t0 = startAttackPinch(g);
    stepN(g, 70);
    g.step([atk(0, 5)]);
    stepN(g, 200);
    expect(evs(g, 'attackPinch', 0).at(-1)).toMatchObject({ state: 'defeat', tick: t0 + 240 });
  });

  it('6段以下へ下がれば解除：end を出し、以後の数字・期限判定なし', () => {
    const g = makeGame({ boards: { 0: rows(7), 1: EMPTY } });
    const t0 = startAttackPinch(g);
    stepN(g, 70); // 3 を表示済み
    // 6段へ（盤面の変化を模擬）。未適用の段で再び7段にならないよう、残りの攻撃段も空にする
    Object.assign(g.players[0].incoming, { waveRemaining: 0, blockRemaining: 0 });
    g.players[0].board.cols.forEach((c) => c.pop());
    stepN(g, 300);
    expect(evs(g, 'pinchWarn', 0).map((e) => [e.state, e.value])).toEqual([
      ['start', null],
      ['count', 3],
      ['end', null],
    ]);
    expect(evs(g, 'attackPinch', 0).map((e) => e.state)).toEqual(['grace', 'release']);
    expect(g.result).toBeNull();
    expect(evs(g, 'pinchWarn', 0)[2].tick - t0).toBe(71);
  });

  it('自分の役処理中は猶予と数字が止まる（既存のタイマー停止条件を維持）', () => {
    const g = makeGame({ boards: { 0: { 0: Array(7).fill('5c'), 1: Array(7).fill('5c'), 2: Array(7).fill('5c'), 3: Array(7).fill('5c'), 4: Array(7).fill('5c'), 5: Array(7).fill('5c') }, 1: EMPTY } });
    const t0 = startAttackPinch(g);
    stepN(g, 30);
    const p = g.players[0];
    const before = p.incoming.pinchRemaining!;
    setStock(g, 0, '1s', '2s', '3s', '4s');
    g.step([cmd(0, 'declare')]);
    const roleTicks = g.ticks(g.config.timing.roleIntroMs) - 2;
    stepN(g, roleTicks);
    expect(p.role).not.toBeNull();
    expect(p.incoming.pinchRemaining).toBe(before); // 宣言tickから停止
    expect(evs(g, 'pinchWarn', 0).filter((e) => e.state === 'count')).toHaveLength(0);
    expect(g.tick - t0).toBeGreaterThan(60); // 壁時計では1000msを過ぎているが、数字は出ない
  });

  it('自然上昇の危険猶予が先行する場合：後から始まった攻撃ピンチで期限を延ばさない。到達通知（start）は1回だけ', () => {
    const g = makeGame({ boards: { 0: rows(7), 1: EMPTY } }, testConfig({ naturalRiseIntervalMs: 1000 }));
    toPlay(g);
    while (!evs(g, 'danger', 0).length) g.step();
    const tn = evs(g, 'danger', 0)[0].tick;
    stepN(g, 30);
    g.step([atk(0, 3)]);
    stepN(g, 400);
    const pinch = evs(g, 'attackPinch', 0);
    expect(pinch.length === 0 || pinch[0].tick > tn).toBe(true);
    expect(evs(g, 'danger', 0).at(-1)).toMatchObject({ state: 'defeat', tick: tn + g.ticks(DEFAULT_CONFIG.dangerGraceMs) });
    expect(evs(g, 'pinchWarn', 0).filter((e) => e.state === 'start')).toHaveLength(1);
  });

  it('攻撃ピンチから警告中に自然上昇の危険猶予が加わっても start を重複させない（早い期限を採る）', () => {
    const g = makeGame({ boards: { 0: rows(7), 1: EMPTY } }, testConfig({ naturalRiseIntervalMs: 2500 }));
    const t0 = startAttackPinch(g);
    stepN(g, 300);
    expect(evs(g, 'pinchWarn', 0).filter((e) => e.state === 'start')).toHaveLength(1);
    const defeatTick = Math.min(...[...evs(g, 'danger', 0), ...evs(g, 'attackPinch', 0)].filter((e) => e.state === 'defeat').map((e) => e.tick));
    expect(defeatTick).toBeLessThanOrEqual(t0 + 240);
  });
});

describe('v3.1.0 ミス帰還：縦軸へ戻った後の降下区間だけ1.6倍', () => {
  it('反発120ms・山なり260msは不変、降下は1600ms（V320-FIX-04）。returned は returnEndTick、描画も同じ時刻に戻り位置へ到達', () => {
    const g = makeGame({ base: '1s', boards: { 0: { 2: ['4d', '5c'] }, 1: EMPTY } });
    const v = new GameView(g, fakeAssets());
    toPlay(g);
    g.step([cmd(0, 'launch')]);
    stepN(g, 200);
    v.syncEvents();
    const a = evs(g, 'arrive', 0)[0];
    expect(a.success).toBe(false);
    expect(a.arcStartTick - a.tick).toBe(g.ticks(120));
    expect(a.arcEndTick - a.arcStartTick).toBe(g.ticks(260));
    expect(a.returnEndTick - a.arcEndTick).toBe(g.ticks(1600)); // V320-FIX-04：1120→1600ms
    expect(g.ticks(1600)).toBe(96);
    const r = evs(g, 'returned', 0)[0];
    expect(r.tick).toBe(a.returnEndTick);
    expect(r.instant).toBe(false);
    // 帰還中（戻り位置の確保）はその列から打ち上げ・回転できない
    const h = makeGame({ base: '1s', boards: { 0: { 2: ['4d', '5c'] }, 1: EMPTY } });
    toPlay(h);
    h.step([cmd(0, 'launch')]);
    const arrive = h.tick + h.ticks(300);
    while (h.tick < arrive + h.ticks(120) + h.ticks(260) + 60) h.step();
    h.step([cmd(0, 'launch')]);
    expect(evs(h, 'launch', 0)).toHaveLength(1);
    while (!evs(h, 'returned', 0).length) h.step();
    h.step([cmd(0, 'launch')]);
    expect(evs(h, 'launch', 0)).toHaveLength(2);
  });
});

describe('v3.1.0 打ち上げ成功連鎖：攻撃加算と連鎖切り予約', () => {
  // V320-FIX-06 で更新：旧攻撃倍率表（×1／×1.25／×1.5／×1.75）は廃止。固定加算 0〜4＋0、5〜9＋1、10〜99＋2
  it('攻撃加算：4→5、9→10 の境界（旧攻撃倍率表は廃止）', () => {
    expect([0, 1, 4, 5, 9, 10, 98, 99].map((n) => streakAttackBonus(n))).toEqual([0, 0, 0, 1, 1, 2, 2, 2]);
    expect(DEFAULT_CONFIG.streakAttackBonus).toEqual([{ minCount: 5, bonus: 1 }, { minCount: 10, bonus: 2 }]);
    // シングルの得点倍率表は変更しない
    expect(DEFAULT_CONFIG.streakScoreTable.map((s) => s.minCount)).toEqual([1, 3, 5, 7]);
  });

  /** 列2から順に打ち上げる（ミス用 4d、成功用 2s）。列を直接選ぶ */
  function launchFrom(g: Game, col: number) {
    g.players[0].selectedCol = col;
    g.step([cmd(0, 'launch')]);
    stepN(g, g.ticks(300) + g.ticks(120) + 2); // 到達＋成功時の上詰め硬直を待つ
  }
  const board = { 0: ['4d', '5c'], 1: ['2s', '5c'], 2: ['4h', '5c'], 3: ['3s', '5c'], 4: ['4c', '5c'], 5: ['2s', '5c'] };

  it('予約なしでミス→予約（成功数・倍率・受付時間は維持）→ 予約中の成功は更新するが予約は残る → 再ミスで即終了', () => {
    const g = makeGame({ base: '1s', boards: { 0: board, 1: EMPTY } });
    toPlay(g);
    const p = g.players[0];
    p.streakCount = 7;
    p.streakRemaining = null;
    launchFrom(g, 0); // ミス
    expect(evs(g, 'streakCut', 0)).toMatchObject([{ state: 'reserved', reason: 'miss', count: 7 }]);
    expect([p.streakCount, p.streakCutReserved, g.currentStreakBonus(p)]).toEqual([7, true, 1]);
    // V320-FIX-05 で更新：旧「ミス・成功で受付時間を更新」は時間制限の撤廃で無効（受付残りは null のまま）
    expect(p.streakRemaining).toBeNull();
    launchFrom(g, 1); // 成功（1♠→2♠）
    expect([p.streakCount, p.streakCutReserved]).toEqual([8, true]);
    expect(p.streakRemaining).toBeNull();
    launchFrom(g, 2); // 再ミス（2♠ と 4♥）
    expect(evs(g, 'streakCut', 0).at(-1)).toMatchObject({ state: 'ended', reason: 'miss', count: 8 });
    expect([p.streakCount, p.streakRemaining, p.streakCutReserved, g.currentStreakBonus(p)]).toEqual([0, 0, false, 0]);
  });

  // V320-FIX-05：既定では時間切れはない。受付時間を明示した設定（streakWindowMs≠null）の場合の動作として残す
  it('受付時間を設定した場合だけ：ミス→時間切れで終了し予約解除。次の新しい成功連鎖へ予約を持ち越さない', () => {
    const g = makeGame({ base: '1s', boards: { 0: board, 1: EMPTY } }, testConfig({ streakWindowMs: 3000 }));
    toPlay(g);
    const p = g.players[0];
    p.streakCount = 3;
    p.streakRemaining = 40;
    launchFrom(g, 0); // ミス → 予約
    expect(p.streakCutReserved).toBe(true);
    stepN(g, 40);
    expect(evs(g, 'streakCut', 0).at(-1)).toMatchObject({ state: 'ended', reason: 'timeout', count: 3 });
    expect([p.streakCount, p.streakCutReserved]).toEqual([0, false]);
    launchFrom(g, 1); // 新しい成功
    expect([p.streakCount, p.streakCutReserved]).toEqual([1, false]);
  });

  it('連鎖が有効でない状態のミスは予約しない', () => {
    const g = makeGame({ base: '1s', boards: { 0: board, 1: EMPTY } });
    toPlay(g);
    launchFrom(g, 0);
    expect(evs(g, 'streakCut', 0)).toHaveLength(0);
    expect(g.players[0].streakCutReserved).toBe(false);
  });

  it('役の宣言では予約も成功数も解除しない。役成立連鎖には影響しない', () => {
    const g = makeGame({ base: '1s', boards: { 0: rows(6), 1: EMPTY } });
    toPlay(g);
    const p = g.players[0];
    p.streakCount = 5;
    p.streakRemaining = 60;
    p.streakCutReserved = true;
    setStock(g, 0, '1s', '2s', '3s', '4s');
    g.step([cmd(0, 'declare')]);
    stepN(g, 5);
    expect([p.streakCount, p.streakCutReserved]).toEqual([5, true]);
    expect(p.chainCount).toBe(1);
    while (p.role) g.step();
    expect(p.chainCount).toBe(1);
  });
});

describe('v3.1.0 修正R2：自然上昇の危険猶予も4000ms（3/2/1 は開始1000ms後から）', () => {
  it('自然上昇から開始：到達0〜1000ms未満は数字なし、1000/2000/3000msで 3/2/1、4000msで敗北。通常周期は変更しない', () => {
    expect(DEFAULT_CONFIG.dangerGraceMs).toBe(4000);
    const g = makeGame({ boards: { 0: rows(7), 1: EMPTY } }, testConfig({ naturalRiseIntervalMs: 1000 }));
    toPlay(g);
    while (!evs(g, 'danger', 0).length) g.step();
    const t0 = evs(g, 'danger', 0)[0].tick;
    stepN(g, 300);
    expect(evs(g, 'pinchWarn', 0).map((e) => [e.state, e.value, e.tick - t0])).toEqual([
      ['start', null, 0],
      ['count', 3, 60],
      ['count', 2, 120],
      ['count', 1, 180],
      ['end', null, 240],
    ]);
    expect(evs(g, 'danger', 0).at(-1)).toMatchObject({ state: 'defeat', tick: t0 + 240 });
  });

  it('攻撃ピンチが先・自然上昇の猶予が後：先行する攻撃ピンチの期限で判定（後の猶予で延長しない）。start は1回', () => {
    const g = makeGame({ boards: { 0: rows(7), 1: EMPTY } }, testConfig({ naturalRiseIntervalMs: 7000 }));
    const t0 = startAttackPinch(g);
    g.players[0].riseCountdown = 30; // 攻撃ピンチの30tick後に自然上昇の時刻（7段のまま → 自然上昇の危険猶予も開始）
    stepN(g, 400);
    expect(evs(g, 'danger', 0)[0]).toMatchObject({ state: 'grace' });
    expect(evs(g, 'danger', 0)[0].tick).toBeGreaterThan(t0);
    const defeat = Math.min(...[...evs(g, 'danger', 0), ...evs(g, 'attackPinch', 0)].filter((e) => e.state === 'defeat').map((e) => e.tick));
    expect(defeat).toBe(t0 + 240);
    expect(evs(g, 'pinchWarn', 0).filter((e) => e.state === 'start')).toHaveLength(1);
    expect(evs(g, 'pinchWarn', 0).filter((e) => e.state === 'count').map((e) => e.tick - t0)).toEqual([60, 120, 180]);
  });

  it('自然上昇の猶予中は役処理で止まり、解除で終了する', () => {
    const g = makeGame({ boards: { 0: rows(7), 1: EMPTY } }, testConfig({ naturalRiseIntervalMs: 1000 }));
    toPlay(g);
    while (!evs(g, 'danger', 0).length) g.step();
    stepN(g, 30);
    const p = g.players[0];
    const before = p.graceRemaining!;
    setStock(g, 0, '1s', '2s', '3s', '4s');
    g.step([cmd(0, 'declare')]);
    stepN(g, g.ticks(g.config.timing.roleIntroMs) - 2);
    expect(p.graceRemaining).toBe(before);
    while (p.role) g.step();
    stepN(g, 2);
    expect(evs(g, 'pinchWarn', 0).at(-1)).toMatchObject({ state: 'end' });
    expect(g.result).toBeNull();
  });
});
