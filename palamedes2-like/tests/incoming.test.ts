// 受攻撃（第3版 統合実装開始指示 第7〜10章）：ブロック・波・段の時刻、相殺対象、上限29、ピンチ猶予、同tick順序
import { describe, expect, it } from 'vitest';
import { NATURAL_RISE_MS } from '../src/core/config';
import type { Command, Game, GameEvent } from '../src/core/game';
import { createIncoming, receive, tryEndBlock, tryStartBlock, tryStartWave, totalIncoming } from '../src/core/incoming';
import type { PlayerId } from '../src/core/types';
import { EMPTY, makeGame, rows, setStock, stepN, testConfig, toPlay } from './helpers';

const atk = (player: PlayerId, lines: number): Command => ({ player, type: 'debugAttack', lines });
const evs = <T extends GameEvent['type']>(g: Game, type: T, p?: PlayerId) =>
  g.events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type && (p === undefined || ('player' in e && e.player === p)));
const inc = (g: Game, p: PlayerId) => g.players[p].incoming;
const T = (g: Game, ms: number) => g.ticks(ms);

describe('受攻撃の状態機械（数量の移動）', () => {
  const tk = (ms: number) => Math.round((ms * 60) / 1000);

  it('ブロック開始・波開始は内部移動で合計を減らさない。上限29、超過は別統計', () => {
    const s = createIncoming();
    expect(receive(s, 7, 10, tk)).toEqual({ accepted: 7, overflow: 0 });
    expect(s.nextBlockTick).toBe(10 + 120);
    expect(tryStartBlock(s, 129)).toBeNull();
    expect(tryStartBlock(s, 130)).toBe(7);
    expect([s.nextPending, s.blockRemaining, s.waveRemaining, totalIncoming(s)]).toEqual([0, 7, 0, 7]);
    expect(tryStartWave(s)).toBe(3);
    expect([s.blockRemaining, s.waveRemaining, totalIncoming(s)]).toEqual([4, 3, 7]);
    expect(receive(s, 30, 140, tk)).toEqual({ accepted: 22, overflow: 8 });
    expect(totalIncoming(s)).toBe(29);
    expect(s.stats.overflow).toBe(8);
    expect(tryEndBlock(s, 150, tk)).toBe(false);
  });

  it('ブロック終了から2000ms後が最短開始。期間内の受信はその時点、経過後の初回受信はそこから2000ms', () => {
    const s = createIncoming();
    receive(s, 1, 0, tk);
    tryStartBlock(s, 120);
    tryStartWave(s);
    s.waveRemaining = 0; // 実適用済みとみなす
    expect(tryEndBlock(s, 200, tk)).toBe(true);
    expect([s.blockActive, s.blockReserved, s.cooldownUntil, s.nextBlockTick]).toEqual([false, 0, 320, null]);
    receive(s, 2, 250, tk); // 期間内
    expect(s.nextBlockTick).toBe(320);
    receive(s, 2, 260, tk); // 追加受信で延長しない
    expect(s.nextBlockTick).toBe(320);
    const t = createIncoming();
    receive(t, 1, 0, tk);
    tryStartBlock(t, 120);
    tryStartWave(t);
    t.waveRemaining = 0;
    tryEndBlock(t, 200, tk);
    receive(t, 1, 500, tk); // 期間経過後
    expect(t.nextBlockTick).toBe(620);
  });
});

describe('受攻撃ブロック・攻撃波（ゲーム内）', () => {
  it('7受信を3＋3＋1で消化：段は0／400／800ms、波間は最後の実適用から450ms。途中の12受信は次ブロック待機分のまま', () => {
    const g = makeGame({ boards: { 0: EMPTY, 1: EMPTY } });
    toPlay(g);
    g.step([atk(0, 7)]);
    const t0 = g.tick;
    stepN(g, 140);
    g.step([atk(0, 12)]); // 現ブロック消化中の受信
    stepN(g, 200);
    expect(evs(g, 'blockStart', 0).map((e) => [e.tick - t0, e.lines])).toEqual([[120, 7]]);
    expect(evs(g, 'waveStart', 0).map((e) => e.lines)).toEqual([3, 3, 1]);
    const s = T(g, 400);
    const w = T(g, 450);
    const r = evs(g, 'attackRow', 0).map((e) => e.tick - t0);
    expect(r).toEqual([120, 120 + s, 120 + 2 * s, 120 + 2 * s + w, 120 + 3 * s + w, 120 + 4 * s + w, 120 + 4 * s + 2 * w]);
    expect(evs(g, 'attackRow', 0).map((e) => e.firstOfWave)).toEqual([true, false, false, true, false, false, true]);
    // 7段到達（ピンチ）で猶予開始。12は現ブロックに混ぜず次ブロック待機分
    expect(g.players[0].board.height()).toBe(7);
    expect([inc(g, 0).nextPending, inc(g, 0).blockRemaining, inc(g, 0).waveRemaining]).toEqual([12, 0, 0]);
    expect(evs(g, 'blockEnd', 0).map((e) => e.tick - t0)).toEqual([120 + 4 * s + 2 * w]);
  });

  it('境界直前・同tick・直後の受信：直前と同tickは新ブロックへ、直後は次ブロック待機分', () => {
    const run = (offset: number) => {
      const g = makeGame({ boards: { 0: EMPTY, 1: EMPTY } });
      toPlay(g);
      g.step([atk(0, 3)]);
      const t0 = g.tick;
      stepN(g, offset - 1);
      g.step([atk(0, 2)]); // t0+offset で受信
      stepN(g, 2);
      return [evs(g, 'blockStart', 0)[0].lines, inc(g, 0).nextPending, evs(g, 'blockStart', 0)[0].tick - t0];
    };
    expect(run(119)).toEqual([5, 0, 120]);
    expect(run(120)).toEqual([5, 0, 120]);
    expect(run(121)).toEqual([3, 2, 120]);
  });

  it('内部割当だけでは表示数が減らず、実適用で1減る。ブロック終了まで予約高さを維持', () => {
    const g = makeGame({ boards: { 0: EMPTY, 1: EMPTY } });
    toPlay(g);
    g.step([atk(0, 5)]);
    stepN(g, 119);
    expect(totalIncoming(inc(g, 0))).toBe(5);
    g.step(); // ブロック開始＋波開始＋1段目
    expect(evs(g, 'blockStart', 0)).toHaveLength(1);
    expect(evs(g, 'waveStart', 0)).toHaveLength(1);
    expect(evs(g, 'attackRow', 0).map((e) => e.total)).toEqual([4]);
    expect(inc(g, 0).blockReserved).toBe(5);
    stepN(g, 200);
    expect(evs(g, 'attackRow', 0).map((e) => e.total)).toEqual([4, 3, 2, 1, 0]);
    expect(inc(g, 0).blockReserved).toBe(0);
  });

  it('相殺は nextPending のみ。blockRemaining と waveRemaining は相殺されない（V320-FIX-06：1対1）', () => {
    const g = makeGame({ boards: { 0: rows(4), 1: EMPTY } });
    toPlay(g);
    g.step([atk(0, 6)]);
    stepN(g, 120); // ブロック6開始、1段目適用 → wave 2・block 3
    g.step([atk(0, 4)]); // 次ブロック待機分4
    const s = inc(g, 0);
    const before = [s.nextPending, s.blockRemaining, s.waveRemaining];
    expect(before).toEqual([4, 3, 2]);
    setStock(g, 0, '1s', '2s', '3s', '4s');
    g.step([{ player: 0, type: 'declare' }]);
    stepN(g, 400);
    const a = evs(g, 'attack', 0)[0];
    // V320-FIX-06 で更新：ストレートフラッシュの基本攻撃4・待機4 → 1対1で相殺4・送信0（旧 1対2 では相殺に2を使い2を送信）
    expect(a.counter).toEqual({ usedPower: 4, canceled: 4, sent: 0, discarded: 0 });
    expect(evs(g, 'attackCancel', 0).map((e) => e.canceled)).toEqual([4]);
    // 現ブロック・波は相殺されずに、役処理後に実適用される
    expect(s.stats.canceled).toBe(4);
    expect(evs(g, 'attackRow', 0)).toHaveLength(6);
  });

  it('役処理中は段を保留し、再開後も直前の実適用から400ms以上。期限超過分を同tickにまとめない', () => {
    const g = makeGame({ boards: { 0: rows(1), 1: EMPTY } });
    toPlay(g);
    g.step([atk(0, 3)]);
    stepN(g, 120);
    expect(evs(g, 'attackRow', 0)).toHaveLength(1);
    setStock(g, 0, '1s', '2s', '3s', '4s');
    g.step([{ player: 0, type: 'declare' }]);
    stepN(g, 500);
    const end = evs(g, 'roleEnd', 0)[0].tick;
    const r = evs(g, 'attackRow', 0).map((e) => e.tick);
    expect(r).toHaveLength(3);
    expect(r[1]).toBeGreaterThanOrEqual(end);
    expect(r[2] - r[1]).toBe(T(g, 400));
    expect(new Set(r).size).toBe(3);
  });

  it('7段到達時は同じ波の余りだけ破棄し、現ブロック残量は保持。破棄は相殺と別イベントで表示数も減る', () => {
    const g = makeGame({ boards: { 0: rows(5), 1: EMPTY } });
    toPlay(g);
    g.step([atk(0, 5)]);
    const t0 = g.tick;
    stepN(g, 120 + T(g, 400));
    expect(g.players[0].board.height()).toBe(7);
    expect(evs(g, 'attackRow', 0)).toHaveLength(2);
    expect(evs(g, 'attackDiscard', 0).map((e) => [e.lines, e.total, e.tick - t0])).toEqual([[1, 2, 120 + T(g, 400)]]);
    expect([inc(g, 0).blockRemaining, inc(g, 0).waveRemaining, inc(g, 0).stats.pinchDiscarded]).toEqual([2, 0, 1]);
    expect(evs(g, 'attackCancel', 0)).toHaveLength(0);
    expect(evs(g, 'attackPinch', 0).map((e) => e.state)).toEqual(['grace']);
  });

  it('ピンチ中は後続波を適用せず、6段以下へ下がれば解除して再開。新たに7段へ届けば猶予を改めて開始', () => {
    const g = makeGame({ boards: { 0: rows(5), 1: EMPTY } });
    toPlay(g);
    g.step([atk(0, 5)]);
    stepN(g, 120 + T(g, 400) + 30);
    expect(evs(g, 'attackRow', 0)).toHaveLength(2);
    g.players[0].board.removeTopRow(); // 消去で6段へ
    g.step(); // 解除。次波の1段目は期限を過ぎているので、このtickに適用されて再び7段 → 猶予を改めて開始
    expect(evs(g, 'attackPinch', 0).map((e) => [e.state, e.tick])).toEqual([
      ['grace', evs(g, 'attackPinch', 0)[0].tick],
      ['release', g.tick],
      ['grace', g.tick],
    ]);
    expect(evs(g, 'attackRow', 0)).toHaveLength(3);
    expect(evs(g, 'attackRow', 0)[2].tick).toBe(g.tick);
  });

  it('期限時7段なら敗北。既ピンチ・追加受信・ブロック切替で猶予を延長しない', () => {
    const g = makeGame({ boards: { 0: rows(7), 1: EMPTY } });
    toPlay(g);
    g.step([atk(0, 3)]);
    const t0 = g.tick;
    stepN(g, 120); // ブロック開始・段が到来 → 7段なので適用せず猶予開始
    expect(evs(g, 'attackRow', 0)).toHaveLength(0);
    expect(evs(g, 'attackDiscard', 0)).toHaveLength(0);
    expect(inc(g, 0).waveRemaining).toBe(3); // 未適用分は保持
    const grace = evs(g, 'attackPinch', 0)[0];
    expect(grace.tick - t0).toBe(120);
    stepN(g, 30);
    g.step([atk(0, 4)]);
    stepN(g, 210);
    // v3.1.0：猶予4000ms（240tick）。追加受信で延長しない
    expect(evs(g, 'attackPinch', 0).map((e) => [e.state, e.tick - t0])).toEqual([
      ['grace', 120],
      ['defeat', 360],
    ]);
    expect(g.result).toMatchObject({ winner: 1, outcome: 'win' });
    expect(g.players[0].board.height()).toBe(7); // 8段を描画してから負けない
  });

  it('29上限と消化による容量回復：確定29から4消費後に10受信→4だけ待機へ、6は上限超過破棄', () => {
    const g = makeGame({ boards: { 0: EMPTY, 1: EMPTY } });
    toPlay(g);
    g.step([atk(0, 29)]);
    stepN(g, 120 + 2 * T(g, 400) + T(g, 450));
    expect(evs(g, 'attackRow', 0)).toHaveLength(4);
    expect(totalIncoming(inc(g, 0))).toBe(25);
    expect(inc(g, 0).blockReserved).toBe(29);
    g.step([atk(0, 10)]);
    expect(evs(g, 'attackReceive', 0).at(-1)).toMatchObject({ accepted: 4, overflow: 6, total: 29 });
    expect(inc(g, 0).nextPending).toBe(4);
    expect(inc(g, 0).stats.overflow).toBe(6);
  });

  it('自然上昇と攻撃段が同tick：攻撃段を先に扱い、7段到達なら自然上昇を追加せず既存の危険状態へ', () => {
    const g = makeGame({ boards: { 0: rows(6), 1: EMPTY } }, testConfig({ naturalRiseIntervalMs: NATURAL_RISE_MS.normal }));
    toPlay(g);
    g.step([atk(0, 1)]);
    g.players[0].riseCountdown = 120; // ブロック開始と同じtickに自然上昇時刻
    stepN(g, 120);
    expect(evs(g, 'attackRow', 0)).toHaveLength(1);
    expect(evs(g, 'rise', 0).filter((e) => e.kind === 'natural')).toHaveLength(0);
    expect(g.players[0].board.height()).toBe(7);
    expect(evs(g, 'danger', 0).map((e) => e.state)).toEqual(['grace']);
  });

  it('自然上昇の危険猶予が先に期限を迎えれば、その早い期限で敗北（後から始まる攻撃ピンチの4000msで延長しない）', () => {
    const g = makeGame({ boards: { 0: rows(7), 1: EMPTY } }, testConfig({ naturalRiseIntervalMs: NATURAL_RISE_MS.normal }));
    toPlay(g);
    g.players[0].riseCountdown = 1;
    g.step(); // 自然上昇時刻：7段 → 4秒の危険猶予
    const t0 = g.tick;
    stepN(g, 140);
    g.step([atk(0, 2)]); // 攻撃ピンチ猶予は 140+1+120 で開始されるが、自然の猶予（240）が先
    stepN(g, 300);
    expect(g.result?.tick).toBe(t0 + 240);
  });

  it('左右を入れ替えても結果が対称', () => {
    const run = (p: PlayerId) => {
      const g = makeGame({ boards: { 0: rows(3), 1: rows(3) } });
      toPlay(g);
      g.step([atk(p, 9)]);
      stepN(g, 50);
      g.step([atk(p, 6)]);
      stepN(g, 600);
      return g.events.filter((e) => 'player' in e && e.player === p && e.type !== 'move').map((e) => ({ ...e, player: 0 }));
    };
    expect(run(1)).toEqual(run(0));
  });

  it('低FPS・大きいtick刻みでも段の順序と時刻は変わらない（固定ステップ）', () => {
    const run = () => {
      const g = makeGame({ boards: { 0: rows(1), 1: EMPTY } });
      toPlay(g);
      g.step([atk(0, 11)]);
      stepN(g, 900);
      return evs(g, 'attackRow', 0).map((r) => [r.tick, r.step, r.waveId]);
    };
    expect(run()).toEqual(run());
  });
});
