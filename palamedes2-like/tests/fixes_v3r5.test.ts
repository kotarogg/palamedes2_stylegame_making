// 第3版 追加修正R5（相殺の消失演出と数量・表示の整合）の回帰。
// 消失演出は表示専用：数量（nextPending・上限29・相殺・消化）は core が即時に確定し、表示はイベントの時点の数量で位置を決める。
import { describe, expect, it } from 'vitest';
import { AudioBus, DEFAULT_MIX } from '../src/audio/audioBus';
import type { AudioBus as Bus } from '../src/audio/audioBus';
import { SoundDirector } from '../src/audio/director';
import type { Command, Game, GameEvent } from '../src/core/game';
import { totalIncoming } from '../src/core/incoming';
import type { PlayerId } from '../src/core/types';
import { GameView } from '../src/view/gameView';
import { DEFAULT_STOCK_VIEW, pendingGroupY, stockGroupHeight } from '../src/view/stockLayout';
import { EMPTY, fakeAssets, makeGame, rows, setStock, stepN, toPlay } from './helpers';

const atk = (player: PlayerId, lines: number): Command => ({ player, type: 'debugAttack', lines });
const FAR = 1e9;
const TOP = DEFAULT_STOCK_VIEW.origin[0][1];

/** 受攻撃の状態を直接設定（現ブロックは波を進めない＝残量を固定） */
function setIncoming(g: Game, p: PlayerId, o: { reserved?: number; cur?: number; pending: number; nextBlockTick?: number | null }) {
  const s = g.players[p].incoming;
  s.blockActive = (o.cur ?? 0) > 0;
  s.blockReserved = o.reserved ?? 0;
  s.blockRemaining = o.cur ?? 0;
  s.waveRemaining = 0;
  s.nextPending = o.pending;
  s.nextStepTick = FAR;
  s.nextBlockTick = o.nextBlockTick ?? null;
}

/**
 * 相殺1バッチ（攻撃側の確定処理と同じ：nextPending を即時に減らし attackCancel を出す）。
 * 相殺量・時刻を指定するための注入で、数量の処理は core の cancelPending と同じ。
 */
function cancelAt(g: Game, p: PlayerId, n: number) {
  const s = g.players[p].incoming;
  const c = Math.min(n, s.nextPending);
  s.nextPending -= c;
  s.stats.canceled += c;
  (g.events as GameEvent[]).push({ type: 'attackCancel', tick: g.tick, player: p, canceled: c, total: totalIncoming(s), pending: s.nextPending });
}

/** 1P対戦の盤面（受攻撃の段を進めない状態）で表示を用意 */
function setup(boards = { 0: EMPTY, 1: EMPTY }) {
  const g = makeGame({ boards });
  const v = new GameView(g, fakeAssets());
  toPlay(g);
  return { g, v };
}

/** 描画計画の全要素が画面内か（実描画と同じ計画） */
function assertOnScreen(v: GameView, p: PlayerId, t: number) {
  const plan = v.stockDrawPlan(p, t);
  for (const e of plan.entries) {
    if (e.x < 0 || e.y < 0 || e.x + e.w > 640 || e.y + e.h > 360) throw new Error(`画面外 ${JSON.stringify(e)}`);
  }
  if (plan.label) expect(plan.label.y).toBeGreaterThanOrEqual(0);
  return plan;
}

const ms = (g: Game, n: number) => g.ticks(n);

describe('修正R5：相殺の消失演出（数量と表示の整合）', () => {
  it('開始予約29・現残1・待機28 → 12相殺 → 6受信：数量は即時、爆発は相殺時の位置のまま（下へ押し出さない）', () => {
    const { g, v } = setup();
    setIncoming(g, 0, { reserved: 29, cur: 1, pending: 28 });
    cancelAt(g, 0, 12);
    const t0 = g.tick;
    v.syncEvents();
    const s = g.players[0].incoming;
    expect(s.nextPending).toBe(16);
    const pendingY = TOP + pendingGroupY(stockGroupHeight(29), null, null);
    const a0 = v.stockAfterimages(0, t0);
    expect(a0).toMatchObject([{ kind: 'counter', lines: 12, frame: 0, y: pendingY + stockGroupHeight(16) }]);
    expect(v.pendingCountLabel(0, t0)?.text).toBe('16');

    g.step([atk(0, 6)]); // 爆発中の追加受信（上限29：1＋16＋6＝23）
    v.syncEvents();
    expect(s.nextPending).toBe(22);
    expect(totalIncoming(s)).toBe(23);
    const a1 = v.stockAfterimages(0, g.tick);
    expect(a1).toHaveLength(1);
    expect(a1[0].y).toBe(a0[0].y); // 待機群の末尾へ配置し直さない
    expect(v.pendingCountLabel(0, g.tick)?.text).toBe('22'); // 消失対象を含めず、受信で即更新
    const plan = assertOnScreen(v, 0, g.tick);
    // 有効ストック（XDでない通常アイコン）は 1＋22、消失対象（XD）は12。消失対象は前面
    const icons = plan.entries.filter((e) => e.type === 'icon');
    const lines = (xs: typeof icons) => xs.reduce((n, e) => n + (e.type === 'icon' && e.size === 'large' ? 5 : 1), 0);
    expect(lines(icons.filter((e) => e.type === 'icon' && !e.vanish))).toBe(23);
    expect(lines(icons.filter((e) => e.type === 'icon' && e.vanish && e.xd))).toBe(12);
    const zNormal = Math.max(...plan.entries.filter((e) => e.type === 'icon' && !e.vanish).map((e) => e.z));
    expect(Math.min(...plan.entries.filter((e) => e.type === 'burst' || (e.type === 'icon' && e.vanish)).map((e) => e.z))).toBeGreaterThan(zNormal);
    // 旧実装（待機群の末尾＝22の下へ毎フレーム再配置）なら 250+80+40＝370 で画面外
    expect(pendingY + stockGroupHeight(22) + 40).toBeGreaterThan(360);
    // 160ms で終了、残像なし
    stepN(g, ms(g, 160));
    v.syncEvents();
    expect(v.stockAfterimages(0, g.tick)).toEqual([]);
    expect(v.stockDrawPlan(0, g.tick).entries.some((e) => e.type === 'burst' || (e.type === 'icon' && e.vanish))).toBe(false);
  });

  it('五月雨：0msの相殺Aと90msの相殺Bは独立に開始・終了（Aは160ms、Bは250ms。Bで再開始・延長しない）', () => {
    const { g, v } = setup();
    setIncoming(g, 0, { pending: 10 });
    cancelAt(g, 0, 3); // A
    const tA = g.tick;
    stepN(g, ms(g, 60));
    g.step([atk(0, 2)]); // 60ms 付近で追加受信
    stepN(g, ms(g, 90) - (g.tick - tA));
    cancelAt(g, 0, 4); // B（90ms）
    const tB = g.tick;
    v.syncEvents();
    expect(v.stockAfterimages(0, tB).map((a) => [a.lines, a.start])).toEqual([
      [3, tA],
      [4, tB],
    ]);
    const endA = tA + Math.ceil(160 / g.tickMs);
    const endB = tB + Math.ceil(160 / g.tickMs);
    expect(v.stockAfterimages(0, endA - 1).map((a) => a.lines)).toEqual([3, 4]);
    expect(v.stockAfterimages(0, endA).map((a) => a.lines)).toEqual([4]); // 160ms で A だけ除去
    expect(v.stockAfterimages(0, endB - 1).map((a) => a.lines)).toEqual([4]);
    expect(v.stockAfterimages(0, endB)).toEqual([]); // 250ms で B を除去
    expect(v.stockAfterimages(0, tB)[0].endMs - v.stockAfterimages(0, tB)[0].start * g.tickMs).toBe(160);
  });

  it('同じ座標の五月雨相殺：古い対象を上書きで失わず、両方を発生順（新しいほど前面）に描く', () => {
    const { g, v } = setup();
    setIncoming(g, 0, { pending: 10 });
    cancelAt(g, 0, 3); // 残7の下
    stepN(g, 2);
    g.step([atk(0, 3)]); // 50ms後に10へ
    cancelAt(g, 0, 3); // 再び残7の下（同じ座標）
    v.syncEvents();
    const a = v.stockAfterimages(0, g.tick);
    expect(a).toHaveLength(2);
    expect(a[0].y).toBe(a[1].y);
    const vanish = v.stockDrawPlan(0, g.tick).entries.filter((e) => e.type === 'burst' || (e.type === 'icon' && e.vanish));
    expect(vanish.filter((e) => e.type === 'burst').map((e) => (e as { frame: number }).frame)).toEqual([1, 1, 1, 0, 0, 0]); // 古い→新しい
  });

  it('爆発中のブロック開始：待機10のうち3を相殺 → 現ブロックは7、相殺した3の表示は即時打切り（数量は減らし直さない）', () => {
    const { g, v } = setup();
    setIncoming(g, 0, { pending: 10, nextBlockTick: FAR });
    cancelAt(g, 0, 3);
    const tc = g.tick;
    g.players[0].incoming.nextBlockTick = g.tick + ms(g, 60);
    stepN(g, ms(g, 60));
    v.syncEvents();
    const bs = g.events.filter((e) => e.type === 'blockStart' && e.player === 0);
    expect(bs).toHaveLength(1);
    expect(bs[0]).toMatchObject({ lines: 7 });
    expect(g.tick - tc).toBeLessThan(ms(g, 160)); // 爆発の途中
    expect(v.stockAfterimages(0, g.tick)).toEqual([]);
    // ブロック開始と同じtickで1段目を適用するので、表示中の残り＋適用済み＝7（相殺した3は含まない）
    const applied = g.events.filter((e) => e.type === 'attackRow' && e.player === 0).length;
    expect(v.stockView(0, g.tick)).toMatchObject({ blockLines: 7 - applied, pendingLines: 0, reservedPx: stockGroupHeight(7) });
    const plan = v.stockDrawPlan(0, g.tick);
    expect(plan.entries.filter((e) => e.type === 'icon' && e.xd)).toHaveLength(0);
    expect(plan.entries.filter((e) => e.type === 'frame')).toHaveLength(1);
    expect(g.players[0].incoming.stats.canceled).toBe(3);
    // 打ち切った演出は時間が進んでも復活しない
    for (let k = 0; k < ms(g, 200); k++) expect(v.stockAfterimages(0, g.tick + k)).toEqual([]);
  });

  it('相殺とブロック開始が同tick（実処理：宣言の相殺 → ブロック開始の順）：消失演出を残さず新ブロック表示を優先', () => {
    const run = (blockAt: number | null) => {
      const g = makeGame({ boards: { 0: rows(4), 1: EMPTY } });
      const v = new GameView(g, fakeAssets());
      toPlay(g);
      g.step([atk(0, 20)]); // 待機20（相殺で一部だけ消える量）
      setStock(g, 0, '1s', '2s', '3s', '4s');
      g.players[0].incoming.nextBlockTick = blockAt ?? FAR;
      g.step([{ player: 0, type: 'declare' }]);
      return { g, v };
    };
    // 1回目：相殺tickを調べる
    const a = run(null);
    stepN(a.g, 200);
    const c = a.g.events.find((e) => e.type === 'attackCancel' && e.player === 0)!;
    expect(c).toBeTruthy();
    // 2回目：同じtickでブロック開始
    const b = run(c.tick);
    stepN(b.g, c.tick - b.g.tick);
    b.v.syncEvents();
    const tickEvents = b.g.events.filter((e) => e.tick === c.tick && 'player' in e && e.player === 0).map((e) => e.type);
    expect(tickEvents.indexOf('attackCancel')).toBeGreaterThanOrEqual(0);
    expect(tickEvents.indexOf('blockStart')).toBeGreaterThan(tickEvents.indexOf('attackCancel'));
    const cb = b.g.events.find((e) => e.type === 'attackCancel' && e.player === 0) as Extract<GameEvent, { type: 'attackCancel' }>;
    const bs = b.g.events.find((e) => e.type === 'blockStart' && e.player === 0) as Extract<GameEvent, { type: 'blockStart' }>;
    expect(bs.lines).toBe(cb.pending); // 相殺後の有効な待機だけがブロックへ
    expect(b.v.stockAfterimages(0, c.tick)).toEqual([]);
    expect(b.v.stockDrawPlan(0, c.tick).entries.some((e) => e.type === 'burst' || (e.type === 'icon' && e.vanish))).toBe(false);
  });

  it('複数tickを1描画で取り込んでも、終了・打切り済みの演出を復活させない。相殺の位置は各イベント時点の数量', () => {
    const { g, v } = setup();
    setIncoming(g, 0, { pending: 20, nextBlockTick: FAR });
    cancelAt(g, 0, 5); // 残15の下
    const y1 = TOP + stockGroupHeight(15);
    stepN(g, 3);
    g.step([atk(0, 5)]); // 20
    cancelAt(g, 0, 2); // 残18の下
    const y2 = TOP + stockGroupHeight(18);
    g.players[0].incoming.nextBlockTick = g.tick + 2;
    stepN(g, 4); // ブロック開始（18）
    g.step([atk(0, 4)]); // 新しい待機群4
    cancelAt(g, 0, 1); // 新しい待機群の相殺（残3の下）
    stepN(g, 2);
    // ここまで一度も描画せず、まとめて取り込む
    v.syncEvents();
    const a = v.stockAfterimages(0, g.tick);
    expect(a).toHaveLength(1); // ブロック開始前の2件は打切り済み（復活しない）
    const sv = v.stockView(0, g.tick);
    expect(a[0]).toMatchObject({ lines: 1, y: sv.pendingY + stockGroupHeight(3) });
    expect([y1, y2]).not.toContain(a[0].y);
    expect(v.pendingCountLabel(0, g.tick)?.text).toBe('3');
  });

  it('ブロック終了・上詰め・追加受信の重なり：相殺の演出は待機群に追従し（位置は相殺時の相対位置）、破棄の残像は上詰めと重なるなら打切り', () => {
    const { g, v } = setup({ 0: rows(5), 1: EMPTY });
    g.step([atk(0, 3)]); // 待機3 → ブロック開始 → 2段で7段・残り1を破棄 → ブロック終了
    while (!g.events.some((e) => e.type === 'blockStart')) g.step();
    g.step([atk(0, 6)]); // 次の待機6（ブロック中に受信）
    stepN(g, 60);
    v.syncEvents();
    const d = g.events.find((e) => e.type === 'attackDiscard' && e.player === 0) as Extract<GameEvent, { type: 'attackDiscard' }>;
    const end = g.events.find((e) => e.type === 'blockEnd' && e.player === 0) as Extract<GameEvent, { type: 'blockEnd' }>;
    expect(d).toBeTruthy();
    expect(end.tick).toBe(d.tick);
    expect(end.pending).toBe(6);
    // 待機群が上詰めしてくるので、元ブロック位置の破棄残像は打切り
    expect(v.stockAfterimages(0, d.tick)).toEqual([]);

    // 上詰め中の相殺：相殺時の相対位置のまま待機群と一緒に動く
    const h = makeGame({ boards: { 0: EMPTY, 1: EMPTY } });
    const w = new GameView(h, fakeAssets());
    toPlay(h);
    h.step([atk(0, 2)]);
    while (!h.events.some((e) => e.type === 'blockStart')) h.step();
    h.step([atk(0, 8)]); // ブロック中に待機8
    while (!h.events.some((e) => e.type === 'blockEnd')) h.step(); // 2段適用でブロック終了 → 上詰め開始
    h.players[0].incoming.nextBlockTick = FAR;
    cancelAt(h, 0, 3);
    const tc = h.tick;
    h.step([atk(0, 4)]);
    w.syncEvents();
    const sv0 = w.stockView(0, tc);
    const sv1 = w.stockView(0, tc + 4);
    expect(sv1.pendingY).toBeLessThan(sv0.pendingY);
    expect(w.stockAfterimages(0, tc)[0].y - sv0.pendingY).toBe(stockGroupHeight(5));
    expect(w.stockAfterimages(0, tc + 4)[0].y - sv1.pendingY).toBe(stockGroupHeight(5));
    for (let k = 0; k < ms(h, 160); k++) assertOnScreen(w, 0, tc + k);
  });

  it('左右の演出を識別：2Pのブロック開始で1Pの相殺演出は消えない', () => {
    const { g, v } = setup();
    setIncoming(g, 0, { pending: 8, nextBlockTick: FAR });
    setIncoming(g, 1, { pending: 8, nextBlockTick: FAR });
    cancelAt(g, 0, 2);
    cancelAt(g, 1, 3);
    g.players[1].incoming.nextBlockTick = g.tick + 2;
    stepN(g, 3);
    v.syncEvents();
    expect(g.events.filter((e) => e.type === 'blockStart').map((e) => (e as { player: number }).player)).toEqual([1]);
    expect(v.stockAfterimages(0, g.tick).map((a) => a.lines)).toEqual([2]);
    expect(v.stockAfterimages(1, g.tick)).toEqual([]);
    // v3.1.0：2Pの列は中央エリアの右側（x=352〜）、ラベルは列の中央側（1Pは右、2Pは左）
    const p2 = v.stockDrawPlan(1, g.tick);
    expect(p2.entries.every((e) => e.x >= 340)).toBe(true);
    expect(v.pendingCountLabel(0, g.tick)).toMatchObject({ text: '6', align: 'left' });
    expect(v.pendingCountLabel(1, g.tick)).toBeNull(); // 待機0・相殺演出なし
  });

  it('ラウンド差し替え（新ラウンド・新試合・メニュー復帰で作り直し）で以前の消失演出をすべてクリア', () => {
    const { g, v } = setup();
    setIncoming(g, 0, { pending: 8 });
    cancelAt(g, 0, 2);
    v.syncEvents();
    expect(v.stockAfterimages(0, g.tick)).toHaveLength(1);
    const g2 = makeGame({ boards: { 0: EMPTY, 1: EMPTY } });
    v.reset(g2);
    toPlay(g2);
    v.syncEvents();
    expect(v.stockAfterimages(0, g2.tick)).toEqual([]);
    // ラウンド終了イベントでも打切り
    setIncoming(g2, 0, { pending: 8 });
    cancelAt(g2, 0, 2);
    (g2.events as GameEvent[]).push({ type: 'roundEnd', tick: g2.tick } as GameEvent);
    v.syncEvents();
    expect(v.stockAfterimages(0, g2.tick)).toEqual([]);
  });

  it('数量の不変条件：消失対象は上限29・相殺・消化に含めない（相殺直後の受信は有効な待機だけで上限を計算）', () => {
    const { g, v } = setup();
    setIncoming(g, 0, { reserved: 29, cur: 1, pending: 28 });
    cancelAt(g, 0, 12);
    g.step([atk(0, 20)]); // 空き＝29−(1+16)＝12 → 12受理・8超過
    v.syncEvents();
    const r = g.events.filter((e) => e.type === 'attackReceive').at(-1) as Extract<GameEvent, { type: 'attackReceive' }>;
    expect([r.accepted, r.overflow]).toEqual([12, 8]);
    expect(totalIncoming(g.players[0].incoming)).toBe(29);
    expect(v.pendingCountLabel(0, g.tick)?.text).toBe('28');
    assertOnScreen(v, 0, g.tick);
  });
});

describe('修正R5：相殺音', () => {
  function recordingBus() {
    const sfx: string[] = [];
    const bus = { playSfx: (id: string) => (sfx.push(id), true), playVoice: () => true, stopPlaySounds: () => undefined } as unknown as Bus;
    return { bus, sfx };
  }

  it('1相殺バッチ（攻撃1回）につき1回。表示の打切りで音を追加・遅延発火しない', () => {
    // V320-FIX-04：役導入1200msで処理が長くなるため、受攻撃ブロック開始前に攻撃処理が来るよう消去1ラインの盤面にする
    const g = makeGame({ boards: { 0: rows(1), 1: EMPTY } });
    toPlay(g);
    const r = recordingBus();
    const d = new SoundDirector(r.bus, g, ['kotaro', 'akane']);
    g.step([atk(0, 3)]);
    setStock(g, 0, '1s', '2s', '3s', '4s');
    g.step([{ player: 0, type: 'declare' }]);
    stepN(g, 400);
    d.sync();
    const attacks = g.events.filter((e) => e.type === 'attack' && e.player === 0 && e.counter.canceled > 0);
    expect(attacks).toHaveLength(1);
    expect(r.sfx.filter((s) => s === 'counter')).toHaveLength(1);
  });

  it('同一フレームの同種音（1P・2P同時の相殺）は全体1回へ統合', () => {
    const t = 1000;
    const bus = new AudioBus('./', DEFAULT_MIX, () => t);
    expect(bus.playSfx('counter')).toBe(true);
    expect(bus.playSfx('counter')).toBe(false);
    expect(bus.log.filter((e) => e.id === 'counter' && !e.skipped)).toHaveLength(1);
  });
});
