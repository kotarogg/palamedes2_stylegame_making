import { describe, expect, it } from 'vitest';
import { computeAttack, resolveCounter } from '../src/core/attack';
import { NATURAL_RISE_MS } from '../src/core/config';
import type { Command, Game, GameEvent } from '../src/core/game';
import { Match } from '../src/core/match';
import type { PlayerId } from '../src/core/types';
import { allPieceIds, EMPTY, label, makeGame, rows, setStock, stepN, stepUntil, testConfig, toPlay, top } from './helpers';

type Act = Exclude<Command['type'], 'debugAttack'>;
const cmd = (player: PlayerId, type: Act): Command => ({ player, type });
const atk = (player: PlayerId, lines: number): Command => ({ player, type: 'debugAttack', lines });
const evs = <T extends GameEvent['type']>(events: GameEvent[], type: T) =>
  events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);
const since = (events: GameEvent[], n: number) => events.slice(n);
const of = (events: GameEvent[], p: PlayerId) => events.filter((e) => 'player' in e && e.player === p);

describe('共通基準への到達順序', () => {
  it('同一フレーム到達は1P優先で、2Pは更新後の基準で判定する（1♠ ← 1P:2♥, 2P:4♥ → 両者成功）', () => {
    const g = makeGame({ base: '1s', boards: { 0: { 2: ['2h', '5s'] }, 1: { 2: ['4h', '5s'] } } });
    toPlay(g);
    g.step([cmd(1, 'launch'), cmd(0, 'launch')]);
    stepN(g, g.ticks(g.config.timing.launchMs));
    const arrivals = evs(g.events, 'arrive');
    expect(arrivals.map((a) => [a.player, label(a.piece), a.success, label(a.baseBefore)])).toEqual([
      [0, '2h', true, '1s'],
      [1, '4h', true, '2h'],
    ]);
    expect(arrivals[0].tick).toBe(arrivals[1].tick);
    expect(label(g.base)).toBe('4h');
  });

  it('発射時に成功見込みでも、到達前に相手が基準を変えれば失敗する', () => {
    const g = makeGame({ base: '1s', boards: { 0: { 2: ['6d', '5s'] }, 1: { 2: ['2s', '5h'] } } });
    toPlay(g);
    g.step([cmd(1, 'launch')]);
    stepN(g, 3);
    g.step([cmd(0, 'launch')]);
    stepN(g, g.ticks(g.config.timing.launchMs) + 2);
    expect(evs(g.events, 'arrive').map((a) => [a.player, label(a.piece), a.success])).toEqual([
      [1, '2s', true],
      [0, '6d', false],
    ]);
  });

  it('発射時に不一致でも、到達時の基準に一致すれば成功する', () => {
    const g = makeGame({ base: '1s', boards: { 0: { 2: ['3h', '5s'] }, 1: { 2: ['2h', '5c'] } } });
    toPlay(g);
    g.step([cmd(1, 'launch')]);
    g.step([cmd(0, 'launch')]);
    stepN(g, g.ticks(g.config.timing.launchMs) + 2);
    expect(evs(g.events, 'arrive').map((a) => [label(a.piece), a.success])).toEqual([
      ['2h', true],
      ['3h', true],
    ]);
  });

  it('発射時には列を詰めず予約空白にし、成功到達で予約解除・上詰めする', () => {
    const g = makeGame({ base: '1s', boards: { 0: { 2: ['2s', '6h', '4d'] } } });
    toPlay(g);
    g.step([cmd(0, 'launch')]);
    expect(g.players[0].board.cols[2].map((s) => s.kind)).toEqual(['reserved', 'piece', 'piece']);
    stepN(g, g.ticks(g.config.timing.launchMs));
    expect(g.players[0].board.cols[2].map((s) => (s.kind === 'piece' ? label(s.piece) : 'R'))).toEqual(['6h', '4d']);
    expect(g.players[0].roleStock.map(label)).toEqual(['2s']);
  });
});

describe('発射・帰還・操作制限（確定）', () => {
  // 1P：列1=2♠(基準1♠に成功) 列2=4♦(失敗→帰還)
  function setup() {
    const g = makeGame({ base: '1s', boards: { 0: { 1: ['2s', '3d'], 2: ['4d', '6h'] }, 1: { 2: ['2d', '3s'] } } });
    toPlay(g);
    return g;
  }

  it('発射モーション＝操作硬直＝行きの飛行時間。発射中は左右移動・役宣言・手動上昇・Bを含め操作できない', () => {
    const g = setup();
    setStock(g, 0, '1s', '2s', '3s', '4s');
    g.step([cmd(0, 'launch')]);
    const L = g.ticks(g.config.timing.launchMs);
    const launch = evs(g.events, 'launch')[0];
    expect(launch.arriveTick - launch.tick).toBe(L);
    expect(g.players[0].lockUntil).toBe(launch.arriveTick);
    const n = g.events.length;
    for (let i = 1; i < L; i++) g.step([cmd(0, 'left'), cmd(0, 'declare'), cmd(0, 'manualRise'), cmd(0, 'rotate')]);
    expect(of(since(g.events, n), 0)).toEqual([]);
    expect(g.players[0].buffered).toBeNull(); // 硬直中の入力は保持しない
    // 硬直終了（到達tick）から操作可能
    g.step([cmd(0, 'left')]);
    expect(evs(since(g.events, n), 'move').map((e) => e.tick)).toEqual([launch.arriveTick]);
  });

  it('発射処理の終了後は、先のピースが帰還中でも予約のない別列を操作できる。帰還予約のある同じ列への発射・Bは禁止', () => {
    const g = setup();
    g.step([cmd(0, 'launch')]);
    stepN(g, g.ticks(g.config.timing.launchMs)); // 到達・失敗
    expect(g.flights[0].state).toBe('returning');
    const n = g.events.length;
    g.step([cmd(0, 'launch')]);
    g.step([cmd(0, 'rotate')]);
    expect(since(g.events, n)).toEqual([]);
    g.step([cmd(0, 'left')]);
    stepN(g, g.ticks(g.config.timing.charMoveMs));
    g.step([cmd(0, 'launch')]);
    expect(evs(g.events, 'launch').map((e) => e.col)).toEqual([2, 1]);
    expect(g.flights.map((f) => f.state)).toEqual(['returning', 'outbound']);
  });

  it('ピース帰還中は役宣言でき、成立時は帰還中ピースをすべて瞬間帰還させてから役処理へ進む', () => {
    const g = setup();
    setStock(g, 0, '1s', '2s', '3s', '4s');
    g.step([cmd(0, 'launch')]);
    stepN(g, g.ticks(g.config.timing.launchMs) + 20); // 山なり帰還中
    const flight = g.flights[0];
    expect(flight.state).toBe('returning');
    const n = g.events.length;
    g.step([cmd(0, 'declare')]);
    const after = since(g.events, n);
    expect(after.map((e) => e.type)).toEqual(['returned', 'declare']);
    expect(after[0]).toMatchObject({ instant: true, col: 2, piece: { id: flight.piece.id } });
    expect(g.flights).toHaveLength(0);
    expect(top(g, 0, 2)?.id).toBe(flight.piece.id);
    // 元の帰還完了tickに二重帰還しない
    stepN(g, 200);
    expect(evs(g.events, 'returned')).toHaveLength(1);
  });

  it('役不成立時は帰還中ピースの帰還を継続する', () => {
    const g = setup();
    setStock(g, 0, '1s', '1d', '2s', '4d');
    g.step([cmd(0, 'launch')]);
    stepN(g, g.ticks(g.config.timing.launchMs) + 20);
    const end = g.flights[0].returnEndTick;
    g.step([cmd(0, 'declare')]);
    expect(evs(g.events, 'declareFail')).toHaveLength(1);
    expect(g.flights).toHaveLength(1);
    stepUntil(g, end);
    expect(evs(g.events, 'returned').map((e) => [e.tick, e.instant])).toEqual([[end, false]]);
  });

  it('B入れ替え中・上詰め中は、そのプレイヤー全体の操作を短時間制限する（相手は継続）', () => {
    const g = setup();
    g.step([cmd(0, 'rotate')]);
    const R = g.ticks(g.config.timing.rotateMs);
    expect(g.players[0].lockUntil).toBe(g.tick + R);
    let n = g.events.length;
    for (let i = 1; i < R; i++) g.step([cmd(0, 'left'), cmd(1, 'right')]);
    const moved = evs(since(g.events, n), 'move').map((e) => e.player);
    expect(moved.filter((x) => x === 0)).toHaveLength(0);
    expect(moved.filter((x) => x === 1).length).toBeGreaterThan(0);
    g.step([cmd(0, 'left')]);
    expect(evs(since(g.events, n), 'move').filter((e) => e.player === 0)).toHaveLength(1);
    // 上詰め：列1の2♠を成功させる
    stepN(g, g.ticks(g.config.timing.charMoveMs));
    g.step([cmd(0, 'launch')]);
    stepN(g, g.ticks(g.config.timing.launchMs) - 1);
    n = g.events.length;
    g.step([cmd(0, 'right')]); // 到達tick：成功→上詰め開始
    const arrive = evs(since(g.events, n), 'arrive')[0];
    expect(arrive.success).toBe(true);
    expect(g.players[0].lockUntil).toBe(arrive.packEndTick);
    stepUntil(g, arrive.packEndTick - 1, () => [cmd(0, 'right')]);
    expect(evs(since(g.events, n), 'move')).toHaveLength(0);
    g.step([cmd(0, 'right')]);
    expect(evs(since(g.events, n), 'move')).toHaveLength(1);
  });

  it('空列への発射・B入れ替えは無効入力として無視し、ペナルティなし', () => {
    const g = makeGame({ boards: { 0: { 2: [] } } });
    toPlay(g);
    g.step([cmd(0, 'launch')]);
    g.step([cmd(0, 'rotate')]);
    expect(g.players[0].lockUntil).toBe(0);
    g.step([cmd(0, 'left')]);
    expect(evs(g.events, 'move')).toHaveLength(1);
    expect(evs(g.events, 'launch').length + evs(g.events, 'rotate').length).toBe(0);
  });
});

describe('左右移動中の入力保持（確定）', () => {
  it('移動中は 左右移動・役宣言・発射・入れ替え から1回分を保持し、最後の入力で上書きして移動終了時に実行', () => {
    const g = makeGame({ base: '1s', boards: { 0: { 1: ['2s', '3d'] } } });
    toPlay(g);
    g.step([cmd(0, 'left')]);
    const move = evs(g.events, 'move')[0];
    g.step([cmd(0, 'right')]);
    g.step([cmd(0, 'rotate')]);
    g.step([cmd(0, 'launch')]);
    expect(g.players[0].buffered).toBe('launch');
    stepUntil(g, move.endTick - 1);
    expect(evs(g.events, 'launch')).toHaveLength(0);
    g.step();
    expect(evs(g.events, 'launch').map((e) => [e.tick, e.col])).toEqual([[move.endTick, 1]]);
    expect(evs(g.events, 'move')).toHaveLength(1);
    expect(evs(g.events, 'rotate')).toHaveLength(0);
  });

  it('保持した役宣言・左右移動も移動終了時に実行される', () => {
    const g = makeGame();
    setStock(g, 0, '1s', '2s', '3s', '4s');
    toPlay(g);
    g.step([cmd(0, 'left')]);
    g.step([cmd(0, 'declare')]);
    stepN(g, g.ticks(g.config.timing.charMoveMs));
    expect(evs(g.events, 'declare')).toHaveLength(1);
    const h = makeGame();
    toPlay(h);
    h.step([cmd(0, 'left')]);
    h.step([cmd(0, 'left')]);
    stepN(h, g.ticks(g.config.timing.charMoveMs) * 2 + 1);
    expect(h.players[0].selectedCol).toBe(0);
  });

  it('手動上昇は保持対象外：移動中でも即時に実行（要確認事項の暫定扱い）', () => {
    const g = makeGame();
    toPlay(g);
    g.step([cmd(0, 'left')]);
    g.step([cmd(0, 'manualRise')]);
    expect(evs(g.events, 'rise').map((e) => e.kind)).toEqual(['manual']);
    expect(g.players[0].buffered).toBeNull();
  });
});

describe('不成立宣言（確定）', () => {
  it('不成立：失敗イベント・約0.5秒の操作硬直・役ストック維持。硬直後は操作できる', () => {
    const g = makeGame();
    setStock(g, 0, '1s', '1d', '2s', '4d');
    toPlay(g);
    g.step([cmd(0, 'declare')]);
    const f = evs(g.events, 'declareFail')[0];
    expect(f).toMatchObject({ reason: 'no_role', lockEnd: g.tick + g.ticks(500) });
    expect(g.players[0].roleStock).toHaveLength(4);
    const n = g.events.length;
    stepUntil(g, f.lockEnd - 1, () => [cmd(0, 'left'), cmd(0, 'declare')]);
    expect(of(since(g.events, n), 0)).toEqual([]);
    g.step([cmd(0, 'left')]);
    expect(evs(since(g.events, n), 'move')).toHaveLength(1);
  });

  it('不成立ペナルティ中も自然上昇・連続取得・役連鎖の時間は継続する', () => {
    const g = makeGame({}, testConfig({ naturalRiseIntervalMs: 1000 }));
    setStock(g, 0, '1s', '1d', '2s', '4d');
    toPlay(g);
    const p = g.players[0];
    p.chainCount = 1;
    p.chainRemaining = 100;
    p.streakCount = 2;
    p.streakRemaining = 1000;
    stepUntil(g, g.playStartTick + 50);
    const riseDue = g.tick + p.riseCountdown;
    g.step([cmd(0, 'declare')]);
    const chain0 = p.chainRemaining;
    p.streakRemaining = 10; // 連続取得の受付があと10tick
    stepN(g, 20);
    expect(p.chainRemaining).toBe(chain0 - 20);
    expect(g.isLocked(p)).toBe(true);
    expect(g.streakActive(p)).toBe(false); // 2秒の受付時間はペナルティ中も経過
    stepUntil(g, riseDue);
    expect(evs(g.events, 'rise').filter((e) => e.player === 0).map((e) => e.tick)).toEqual([riseDue]);
  });

  it('宣言を連打しても時間は止まらず、硬直が延長されることもない', () => {
    const run = (spam: boolean) => {
      const g = makeGame({}, testConfig({ naturalRiseIntervalMs: 700 }), 3);
      setStock(g, 0, '1s', '1d', '2s', '4d');
      toPlay(g);
      let maxLock = 0;
      for (let i = 0; i < 300; i++) {
        g.step(spam ? [cmd(0, 'declare')] : []);
        maxLock = Math.max(maxLock, g.players[0].lockUntil - g.tick);
      }
      return { rises: evs(g.events, 'rise').filter((e) => e.player === 0).map((e) => e.tick), maxLock, fails: evs(g.events, 'declareFail').length };
    };
    const quiet = run(false);
    const spam = run(true);
    expect(spam.rises).toEqual(quiet.rises);
    expect(spam.rises.length).toBeGreaterThan(3);
    expect(spam.maxLock).toBeLessThanOrEqual(30);
    expect(spam.fails).toBe(10); // 300tick ÷ 30tick
  });

  it('4個未満の宣言：既定は不成立扱い。設定で無視に切替可能（要確認事項）', () => {
    const g = makeGame();
    setStock(g, 0, '1s', '2s');
    toPlay(g);
    g.step([cmd(0, 'declare')]);
    expect(evs(g.events, 'declareFail').map((e) => e.reason)).toEqual(['too_few']);
    const h = makeGame({}, testConfig({ declareBelowMinIsFailure: false }));
    setStock(h, 0, '1s', '2s');
    toPlay(h);
    h.step([cmd(0, 'declare')]);
    expect(evs(h.events, 'declareFail')).toHaveLength(0);
    expect(h.isLocked(h.players[0])).toBe(false);
  });
});

describe('役宣言の処理フェーズ（確定）', () => {
  const fiveRows = () => {
    const b: Record<number, string[]> = {};
    for (let c = 0; c < 6; c++) b[c] = ['1h', '2h', '3h', '4h', '5h'].map((x) => `${x[0]}${'dcsh'[c % 4]}`);
    return b;
  };

  it('宣言→役名・モーション→（1ライン消去→処理→段数TWEEN→残数確認）×合計翻数→攻撃→モーション戻し→終了', () => {
    const g = makeGame({ boards: { 0: fiveRows() } });
    setStock(g, 0, '1s', '2s', '3s', '4s'); // ストレート1＋フラッシュ3＝4翻 → 4ライン
    toPlay(g);
    g.step([cmd(0, 'declare')]);
    const T = g.config.timing;
    const d = evs(g.events, 'declare')[0];
    expect(d.result.han).toBe(4);
    expect(d.logos).toEqual([13]); // ストレートフラッシュは専用ロゴのみ
    stepN(g, 400);
    const seq = of(g.events, 0).filter((e) => ['declare', 'lineClear', 'attack', 'roleEnd'].includes(e.type));
    expect(seq.map((e) => e.type)).toEqual(['declare', 'lineClear', 'lineClear', 'lineClear', 'lineClear', 'attack', 'roleEnd']);
    const lc = evs(g.events, 'lineClear');
    const per = g.ticks(T.lineClearMs) + g.ticks(T.lineShiftMs);
    expect(lc[0].tick).toBe(d.tick + g.ticks(T.roleIntroMs));
    for (let i = 1; i < 4; i++) expect(lc[i].tick - lc[i - 1].tick).toBe(per);
    expect(lc.map((e) => [e.heightBefore, e.heightAfter])).toEqual([
      [5, 4],
      [4, 3],
      [3, 2],
      [2, 1],
    ]);
    // 上側の横1ライン（各列の最上段）から順に消える
    expect(lc[0].removed.map((r) => label(r.piece))).toEqual(['1d', '1c', '1s', '1h', '1d', '1c']);
    expect(lc[3].removed.map((r) => r.piece.n)).toEqual([4, 4, 4, 4, 4, 4]);
    expect(lc[0].shiftEnd - lc[0].clearEnd).toBe(g.ticks(T.lineShiftMs));
    const a = evs(g.events, 'attack')[0];
    expect(a.tick).toBe(lc[3].tick + per);
    expect(evs(g.events, 'roleEnd')[0].tick).toBe(a.tick + g.ticks(T.roleOutroMs));
    expect(g.players[0].board.height()).toBe(1);
  });

  it('各列の個数[4,5,4,4,3,5]で2ライン消去すると[2,3,2,2,1,3]（共有ノート12・13）', () => {
    const counts = [4, 5, 4, 4, 3, 5];
    const b: Record<number, string[]> = {};
    counts.forEach((n, c) => (b[c] = Array.from({ length: n }, () => '5c')));
    const g = makeGame({ boards: { 0: b } });
    toPlay(g);
    setStock(g, 0, '1s', '1c', '1s', '1c'); // フォーカード1＋同色統一1＝2翻 → 2ライン
    g.step([cmd(0, 'declare')]);
    stepN(g, 300);
    expect(evs(g.events, 'lineClear')).toHaveLength(2);
    expect(g.players[0].board.cols.map((c) => c.length)).toEqual([2, 3, 2, 2, 1, 3]);
  });

  it('盤面が空になったら消去を打ち切って後続へ進み、基本攻撃量は減らさない', () => {
    const g = makeGame({ boards: { 0: rows(1) } });
    setStock(g, 0, '1s', '2s', '3s', '4s');
    toPlay(g);
    g.step([cmd(0, 'declare')]);
    stepN(g, 200);
    expect(evs(g.events, 'lineClear')).toHaveLength(1);
    const a = evs(g.events, 'attack')[0];
    expect(a.linesCleared).toBe(1);
    expect(a.breakdown).toMatchObject({ base: 3, power: 3 });
    expect(evs(g.events, 'attackStock').filter((e) => e.player === 1 && e.cause === 'receive').map((e) => e.delta)).toEqual([3]);
  });

  it('宣言者だけ操作不能・自然上昇停止。相手は継続し、終了後に残り時間から自然上昇を再開', () => {
    const g = makeGame({ boards: { 0: fiveRows() } }, testConfig({ naturalRiseIntervalMs: 3000 }));
    setStock(g, 0, '1s', '2s', '3s', '4s');
    toPlay(g);
    stepN(g, g.ticks(3000) - 30);
    g.step([cmd(0, 'declare')]);
    const remaining = g.players[0].riseCountdown;
    let n = g.events.length;
    g.step([cmd(0, 'right'), cmd(1, 'right')]);
    expect(evs(since(g.events, n), 'move').map((e) => e.player)).toEqual([1]);
    n = g.events.length;
    stepN(g, 400);
    const end = evs(g.events, 'roleEnd')[0].tick;
    const nat = (p: PlayerId) => evs(since(g.events, n), 'rise').filter((e) => e.kind === 'natural' && e.player === p);
    expect(nat(1).length).toBeGreaterThan(0);
    expect(nat(1)[0].tick).toBeLessThan(end);
    expect(nat(0)[0].tick).toBe(end + remaining - 1);
  });
});

describe('攻撃計算・相殺・送信（確定）', () => {
  it('基本攻撃量×連続取得の攻撃倍率→切捨て→役連鎖加算（連鎖分には倍率を掛けない）', () => {
    expect(computeAttack(1, 100, 1).power).toBe(0);
    expect(computeAttack(4, 100, 1)).toMatchObject({ base: 3, multiplied: 3, chainBonus: 0, power: 3 });
    expect(computeAttack(4, 125, 1).power).toBe(3); // 3.75 → 3
    expect(computeAttack(4, 150, 1).power).toBe(4); // 4.5 → 4
    expect(computeAttack(6, 175, 1).power).toBe(8); // 8.75 → 8
    expect([1, 2, 3, 4, 5, 9].map((c) => computeAttack(4, 100, c).chainBonus)).toEqual([0, 1, 2, 3, 4, 4]);
    expect(computeAttack(1, 175, 3).power).toBe(2); // 基本0、連鎖+2はそのまま
  });

  it('相殺：通常攻撃力1で待機2まで。使わなかった攻撃力は送信、使用分の余剰相殺力は破棄', () => {
    expect(resolveCounter(3, 1)).toEqual({ usedPower: 1, canceled: 1, sent: 2, discarded: 1 });
    expect(resolveCounter(3, 0)).toEqual({ usedPower: 0, canceled: 0, sent: 3, discarded: 0 });
    expect(resolveCounter(1, 5)).toEqual({ usedPower: 1, canceled: 2, sent: 0, discarded: 0 });
    expect(resolveCounter(2, 3)).toEqual({ usedPower: 2, canceled: 3, sent: 0, discarded: 1 });
    expect(resolveCounter(4, 4)).toEqual({ usedPower: 2, canceled: 4, sent: 2, discarded: 0 });
  });

  it('相殺は攻撃処理フェーズで行い、役処理の途中へ割り込ませない。処理中の受信も即加算され、相殺対象になる', () => {
    const g = makeGame({ boards: { 0: rows(4) } });
    setStock(g, 0, '1s', '2s', '3s', '4s');
    toPlay(g);
    g.step([atk(0, 1)]);
    g.step([cmd(0, 'declare')]);
    stepN(g, 50);
    g.step([atk(0, 1)]); // 役処理中の受信：即加算
    expect(g.players[0].attackStock).toBe(2);
    const a0 = evs(g.events, 'attack');
    expect(a0).toHaveLength(0);
    stepN(g, 200);
    const a = evs(g.events, 'attack')[0];
    expect(a.counter).toEqual({ usedPower: 1, canceled: 2, sent: 2, discarded: 0 });
    expect(g.players[0].attackStock).toBe(0);
    expect(evs(g.events, 'attackStock').filter((e) => e.player === 1 && e.cause === 'receive').map((e) => [e.tick, e.delta])).toEqual([[a.tick, 2]]);
    const st = evs(g.events, 'attackStock').filter((e) => e.cause === 'counter');
    expect(st.map((e) => e.tick)).toEqual([a.tick]);
  });

  it('連続取得：成功取得から2秒以内の成功で継続し、宣言時の倍率に反映（5個×1.5）。受付時間切れは×1.0', () => {
    const run = (waitTicks: number) => {
      const g = makeGame({ base: '1s', boards: { 0: { 2: ['2s', '3s', '4s', '5s', '6s', '1d'] }, 1: EMPTY } });
      toPlay(g);
      const T = g.config.timing;
      for (let i = 0; i < 5; i++) {
        g.step([cmd(0, 'launch')]);
        stepN(g, g.ticks(T.launchMs) + g.ticks(T.packMs));
      }
      expect(evs(g.events, 'arrive').map((e) => e.streak)).toEqual([1, 2, 3, 4, 5]);
      stepN(g, waitTicks);
      g.step([cmd(0, 'declare')]);
      stepN(g, 400);
      return { d: evs(g.events, 'declare')[0], a: evs(g.events, 'attack')[0], g };
    };
    const fast = run(0);
    expect(fast.d.result.han).toBe(5); // 2345♠ ハイストレートフラッシュ
    expect(fast.d.streakPercent).toBe(150);
    expect(fast.a.breakdown).toMatchObject({ base: 4, multiplied: 6, power: 6 });
    const slow = run(130);
    expect(slow.d.streakPercent).toBe(100);
    expect(slow.a.breakdown.power).toBe(4);
  });

  it('連続取得の受付時間は自分の成立役の処理中は停止し、宣言で連続取得状態をリセットしない（共有ノート17）', () => {
    const g = makeGame({ boards: { 0: rows(6), 1: EMPTY } });
    setStock(g, 0, '1s', '2s', '3s', '4s');
    toPlay(g);
    const p = g.players[0];
    p.streakCount = 4;
    p.streakRemaining = 30;
    g.step([cmd(0, 'declare')]);
    expect(evs(g.events, 'declare')[0]).toMatchObject({ streak: 4, streakPercent: 125 });
    stepN(g, 100); // 役処理中（30tickを超えても切れない）
    expect(p.role).not.toBeNull();
    expect([p.streakCount, p.streakRemaining]).toEqual([4, 30]); // 宣言tickから停止
    while (p.role) g.step();
    stepN(g, 28);
    expect(g.streakActive(p)).toBe(true);
    stepN(g, 2);
    expect(g.streakActive(p)).toBe(false);
  });

  it('計算順の例（共有ノート18）：基本3×1.5→4、3連鎖目+2で攻撃力6。待機1なら1を相殺に使い5を送る', () => {
    const b = computeAttack(4, 150, 3);
    expect(b.power).toBe(6);
    expect(resolveCounter(b.power, 1)).toMatchObject({ usedPower: 1, sent: 5 });
    // 共有ノート16の表（A=3）
    expect([0, 1, 2, 3, 6, 7].map((r) => {
      const c = resolveCounter(3, r);
      return [c.usedPower, c.canceled, r - c.canceled, c.sent];
    })).toEqual([
      [0, 0, 0, 3],
      [1, 1, 0, 2],
      [1, 2, 0, 2],
      [2, 3, 0, 1],
      [3, 6, 0, 0],
      [3, 6, 1, 0],
    ]);
  });

  it('役連鎖：成立ごとに8秒の受付を更新、処理中は停止。2連鎖目+1。不成立は更新・加算しない', () => {
    const g = makeGame({ boards: { 0: rows(7), 1: EMPTY } });
    setStock(g, 0, '1s', '2s', '3s', '4s');
    toPlay(g);
    const p = g.players[0];
    g.step([cmd(0, 'declare')]);
    const window = g.ticks(8000);
    expect(p.chainRemaining).toBe(window);
    stepN(g, 50);
    expect(p.chainRemaining).toBe(window); // 自分の成立役の処理中は停止
    while (p.role) g.step();
    // 不成立宣言：連鎖の受付更新・加算なし（時間は継続）
    setStock(g, 0, '1s', '1d', '2s', '4d');
    g.step([cmd(0, 'declare')]);
    stepN(g, 40);
    expect(p.chainRemaining).toBeLessThan(window - 40);
    expect(p.chainCount).toBe(1);
    setStock(g, 0, '1s', '2s', '3s', '4s');
    g.step([cmd(0, 'declare')]);
    stepN(g, 400);
    const atks = evs(g.events, 'attack');
    expect(atks.map((a) => a.breakdown.chainBonus)).toEqual([0, 1]);
    expect(atks[1].breakdown.power).toBe(4);
    // 受付時間切れ後は1連鎖目に戻る
    stepN(g, window + 5);
    setStock(g, 0, '1s', '2s', '3s', '4s');
    g.step([cmd(0, 'declare')]);
    stepN(g, 400);
    expect(evs(g.events, 'attack').map((a) => a.breakdown.chainBonus)).toEqual([0, 1, 0]);
  });

  it('同一tickの双方送信：双方とも送信反映前の待機ストックで相殺し、その後に双方の送信を反映（処理順の有利不利なし）', () => {
    const g = makeGame({ boards: { 0: rows(4), 1: rows(4) } });
    setStock(g, 0, '1s', '2s', '3s', '4s');
    setStock(g, 1, '1s', '2s', '3s', '4s');
    toPlay(g);
    g.step([atk(0, 1), atk(1, 1)]);
    g.step([cmd(0, 'declare'), cmd(1, 'declare')]);
    stepN(g, 300);
    const a = evs(g.events, 'attack');
    expect(a[0].tick).toBe(a[1].tick);
    expect(a.map((x) => x.counter)).toEqual([
      { usedPower: 1, canceled: 1, sent: 2, discarded: 1 },
      { usedPower: 1, canceled: 1, sent: 2, discarded: 1 },
    ]);
    const recv = evs(g.events, 'attackStock').filter((e) => e.cause === 'receive');
    expect(recv.map((e) => [e.player, e.delta, e.stock, e.tick === a[0].tick])).toEqual([
      [1, 2, 2, true],
      [0, 2, 2, true],
    ]);
  });
});

describe('攻撃の受信・攻撃波（2026-10-20確定：1段ずつ0/200/400ms）', () => {
  const attackRises = (g: Game, p: PlayerId) => evs(g.events, 'rise').filter((e) => e.kind === 'attack' && e.player === p);
  const rowsOf = (g: Game, p: PlayerId) => evs(g.events, 'attackRow').filter((e) => e.player === p);

  it('最初の受信から2秒後に第1波、以後2秒間隔。追加受信で待ち時間を延ばさない。1段目0ms・2段目200ms・3段目400msで1段ずつSNAP', () => {
    const g = makeGame({ boards: { 0: EMPTY } });
    toPlay(g);
    g.step([atk(0, 2)]);
    const t0 = g.tick;
    stepN(g, 60);
    g.step([atk(0, 3)]);
    stepN(g, 300);
    const step = g.ticks(200);
    expect(attackRises(g, 0).map((w) => [w.tick - t0, w.rows])).toEqual([
      [120, 1],
      [120 + step, 1],
      [120 + 2 * step, 1],
      [240, 1],
      [240 + step, 1],
    ]);
    expect(attackRises(g, 0).every((w) => w.endTick === w.tick)).toBe(true);
    // 波の開始時にその波の分だけ予約し、待機ストックから引く
    expect(evs(g.events, 'waveStart').map((w) => [w.tick - t0, w.lines])).toEqual([
      [120, 3],
      [240, 2],
    ]);
  });

  it('各段で容量を再確認し、6段に達した後の段は破棄（着弾なし）。後続波の分は破棄せず保持。ストック上限29', () => {
    const g = makeGame({ boards: { 0: rows(4) } });
    toPlay(g);
    g.step([atk(0, 5)]);
    const t0 = g.tick;
    stepN(g, 150);
    // 第1波：4段→5→6、3段目は6段のため破棄
    expect(rowsOf(g, 0).map((r) => [r.tick - t0, r.step, r.applied, r.firstApplied])).toEqual([
      [120, 0, true, true],
      [132, 1, true, false],
      [144, 2, false, false],
    ]);
    expect(g.players[0].board.height()).toBe(6);
    expect(g.players[0].attackStock).toBe(2); // 後続波の分は保持
    stepN(g, 140);
    expect(rowsOf(g, 0).slice(3).map((r) => r.applied)).toEqual([false, false]);
    expect(g.players[0].attackStock).toBe(0);
    expect(g.players[0].board.height()).toBe(6);
    g.step([atk(1, 25)]);
    g.step([atk(1, 10)]);
    expect(g.players[1].attackStock).toBe(29);
  });

  it('自分の役処理中も待ち時間は経過し、波の開始は処理終了まで待機。終了時に予約して1段ずつ適用', () => {
    const g = makeGame({ boards: { 0: rows(5), 1: EMPTY } });
    setStock(g, 0, '1s', '2s', '3s', '4s');
    toPlay(g);
    g.step([atk(0, 10)]);
    const due = g.tick + 120;
    g.step([cmd(0, 'declare')]);
    stepN(g, 400);
    const end = evs(g.events, 'roleEnd')[0].tick;
    expect(end).toBeGreaterThan(due);
    // 相殺：攻撃力3で待機6を相殺 → 残4。消去4ラインで盤面1段 → 3段を0/200/400msで適用
    const step = g.ticks(200);
    expect(attackRises(g, 0).map((w) => w.tick - end)).toEqual([0, step, 2 * step, g.ticks(2000)]);
    // 第2波は第1波の開始から2秒後（残り1段）
    expect(g.players[0].board.height()).toBe(5);
    expect(g.players[0].attackStock).toBe(0);
  });

  it('開始済みの波の途中で役処理が始まったら次段を保留し、終了後に200ms以上の間隔で再開（同一tickへ詰め込まない）', () => {
    const g = makeGame({ boards: { 0: rows(2), 1: EMPTY } });
    toPlay(g);
    g.step([atk(0, 3)]);
    stepN(g, 120); // 第1波の1段目が適用された直後
    expect(rowsOf(g, 0)).toHaveLength(1);
    setStock(g, 0, '1s', '2s', '3s', '4s');
    g.step([cmd(0, 'declare')]);
    stepN(g, 500);
    const end = evs(g.events, 'roleEnd')[0].tick;
    const rws = rowsOf(g, 0);
    expect(rws).toHaveLength(3);
    expect(rws[1].tick).toBeGreaterThanOrEqual(end);
    expect(rws[2].tick - rws[1].tick).toBe(g.ticks(200));
    expect(rws[1].tick - rws[0].tick).toBeGreaterThanOrEqual(g.ticks(200));
    // 被攻撃の初段フラグは波につき1回
    expect(rws.filter((r) => r.firstApplied)).toHaveLength(1);
  });

  it('波の予約後に受信した攻撃は相殺の対象（予約済みの段は相殺しない）。既存の計算順を変えない', () => {
    const g = makeGame({ boards: { 0: rows(1), 1: EMPTY } });
    toPlay(g);
    g.step([atk(0, 4)]);
    stepN(g, 120); // 第1波開始：3段予約、待機1
    expect(g.players[0].attackStock).toBe(1);
    expect(g.players[0].wave?.remaining).toBe(2);
    setStock(g, 0, '1s', '2s', '3s', '4s');
    g.step([cmd(0, 'declare')]);
    stepN(g, 300);
    const a = evs(g.events, 'attack')[0];
    expect(a.counter).toEqual({ usedPower: 1, canceled: 1, sent: 2, discarded: 1 });
    // 予約済みの残り2段は役処理後に適用される
    expect(rowsOf(g, 0)).toHaveLength(3);
  });

  it('勝敗確定後は予約中の段・波を進めない。次のラウンドへ前ラウンドの攻撃は持ち越さない', () => {
    const quick = { naturalRiseIntervalMs: 1000, dangerGraceMs: 200 };
    const m = new Match({ firstTo: 2, difficulty: 'normal', seed: 5, config: quick });
    const g0 = m.game as Game;
    for (let i = 0; i < 300; i++) m.step(g0.playing && i === 80 ? [atk(1, 9)] : []);
    for (let i = 0; i < 3000 && m.state === 'round'; i++) m.step(g0.playing ? [cmd(0, 'manualRise')] : []);
    expect(m.state).toBe('roundResult');
    const n = g0.events.length;
    for (let i = 0; i < 200; i++) m.step([]);
    expect(g0.events.length).toBe(n);
    for (let i = 0; i < 60; i++) m.step([], true);
    const g1 = m.game as Game;
    expect(g1).not.toBe(g0);
    expect(g1.players.map((p) => [p.attackStock, p.wave])).toEqual([
      [0, null],
      [0, null],
    ]);
  });

  it('低FPS・大きいtick刻みでも段の順序と時刻は変わらない（固定ステップ）', () => {
    const run = () => {
      const g = makeGame({ boards: { 0: rows(2) } });
      toPlay(g);
      g.step([atk(0, 7)]);
      stepN(g, 600);
      return rowsOf(g, 0).map((r) => [r.tick, r.step, r.applied]);
    };
    expect(run()).toEqual(run());
  });
});

describe('自然上昇・手動上昇（確定）', () => {
  it('難易度別の自然上昇周期：初級7秒・中級5秒・上級3秒', () => {
    for (const [d, ms] of Object.entries(NATURAL_RISE_MS)) {
      const m = new Match({ firstTo: 2, difficulty: d as 'easy', seed: 1 });
      expect((m.game as Game).config.naturalRiseIntervalMs).toBe(ms);
      stepUntil((m.game as Game), (m.game as Game).playStartTick + (m.game as Game).ticks(ms) + 1);
      const r = evs((m.game as Game).events, 'rise').filter((e) => e.kind === 'natural');
      expect(r.map((e) => e.tick - (m.game as Game).playStartTick + 1)).toEqual([(m.game as Game).ticks(ms), (m.game as Game).ticks(ms)]);
    }
  });

  it('手動上昇しても自然上昇を通常周期へリセットしない', () => {
    const g = makeGame({}, testConfig({ naturalRiseIntervalMs: 1000 }));
    toPlay(g);
    stepN(g, 20);
    g.step([cmd(0, 'manualRise')]);
    stepN(g, 100);
    const nat = (p: PlayerId) => evs(g.events, 'rise').filter((e) => e.kind === 'natural' && e.player === p)[0].tick;
    expect(nat(0)).toBe(nat(1));
  });

  it('手動上昇中は自然上昇を待機し、完了時に残り時間を max(残り, 最低間隔0.2秒) へ補正。重ねて実行しない', () => {
    const g = makeGame({}, testConfig({ naturalRiseIntervalMs: 1000 }));
    toPlay(g);
    const p = g.players[0];
    stepUntil(g, g.tick + p.riseCountdown - 5); // 自然上昇の5tick前
    g.step([cmd(0, 'manualRise')]);
    const manualEnd = p.manualRiseEndTick;
    stepN(g, 80);
    const r = evs(g.events, 'rise').filter((e) => e.player === 0);
    expect(r.map((e) => e.kind)).toEqual(['manual', 'natural']);
    expect(r[1].tick).toBe(manualEnd + g.ticks(200));
  });

  it('同時要求時は手動上昇を先に処理し、自然上昇を重ねて実行しない', () => {
    const g = makeGame({}, testConfig({ naturalRiseIntervalMs: 1000 }));
    toPlay(g);
    const p = g.players[0];
    stepUntil(g, g.tick + p.riseCountdown - 1);
    g.step([cmd(0, 'manualRise')]); // このtickが自然上昇の予定tick
    const r = evs(g.events, 'rise').filter((e) => e.player === 0);
    expect(r.map((e) => e.kind)).toEqual(['manual']);
    stepN(g, 40);
    const r2 = evs(g.events, 'rise').filter((e) => e.player === 0);
    expect(r2.map((e) => e.kind)).toEqual(['manual', 'natural']);
    expect(r2[1].tick).toBe(p.manualRiseEndTick + g.ticks(200));
  });

  it('手動上昇は7段を超えない', () => {
    const g = makeGame();
    toPlay(g);
    for (let i = 0; i < 200; i++) g.step([cmd(0, 'manualRise')]);
    expect(g.players[0].board.height()).toBe(7);
    expect(evs(g.events, 'rise').filter((e) => e.kind === 'manual')).toHaveLength(4);
  });
});

describe('危険状態・敗北（確定）', () => {
  const dangerGame = (over = {}) => {
    const g = makeGame({ boards: { 0: rows(7), 1: EMPTY } }, testConfig({ naturalRiseIntervalMs: 500, ...over }));
    g.players[1].riseCountdown = Number.POSITIVE_INFINITY;
    toPlay(g);
    return g;
  };

  it('7段のまま自然上昇時刻：上昇を保留し3秒の猶予。猶予終了時も7段なら8段目の追加直前に敗北', () => {
    const g = dangerGame();
    stepN(g, g.ticks(500));
    const grace = evs(g.events, 'danger')[0];
    expect(grace.state).toBe('grace');
    expect(grace.graceEnd - grace.tick).toBe(g.ticks(3000));
    stepUntil(g, grace.graceEnd + 10);
    const dz = evs(g.events, 'danger');
    expect(dz.map((e) => [e.state, e.tick])).toEqual([
      ['grace', grace.tick],
      ['defeat', grace.graceEnd],
    ]);
    expect(evs(g.events, 'rise').filter((e) => e.player === 0)).toHaveLength(0);
    expect(g.players[0].board.height()).toBe(7);
    expect(g.result).toEqual({ winner: 1, tick: grace.graceEnd, outcome: 'win' });
    expect(evs(g.events, 'roundEnd')).toHaveLength(1);
  });

  it('猶予中に6段以下になれば解除。成立役の処理中は猶予を停止し、消去で解除（保留分の上昇は終了後に実行）', () => {
    const g = dangerGame();
    setStock(g, 0, '1s', '2s', '3s', '4s');
    stepN(g, g.ticks(500) + 30);
    const p = g.players[0];
    expect(p.graceRemaining).not.toBeNull();
    g.step([cmd(0, 'declare')]);
    const left = p.graceRemaining;
    stepN(g, 20);
    expect(p.graceRemaining).toBe(left); // 処理中は停止
    stepN(g, 30);
    const rel = evs(g.events, 'danger').find((e) => e.state === 'release')!;
    expect(rel.tick).toBe(evs(g.events, 'lineClear')[0].tick);
    stepN(g, 300);
    const end = evs(g.events, 'roleEnd')[0].tick;
    const nat = evs(g.events, 'rise').filter((e) => e.player === 0 && e.kind === 'natural');
    expect(nat[0].tick).toBe(end);
    expect(g.result).toBeNull();
  });

  it('不成立ペナルティ中は危険猶予を継続する', () => {
    const g = dangerGame();
    setStock(g, 0, '1s', '1d', '2s', '4d');
    stepN(g, g.ticks(500) + 5);
    const p = g.players[0];
    const left = p.graceRemaining!;
    g.step([cmd(0, 'declare')]);
    stepN(g, 20);
    expect(p.graceRemaining).toBe(left - 21);
  });

  it('解除後に再び7段となり、次の自然上昇時刻を迎えたら改めて3秒の猶予を開始', () => {
    const g = dangerGame({ releaseExecutesHeldRise: false });
    stepN(g, g.ticks(500) + 10);
    // 1列だけ短くして6段へ（成功打ち上げの代わりに盤面を直接操作）
    for (const c of g.players[0].board.cols) c.shift();
    stepN(g, 2);
    expect(evs(g.events, 'danger').map((e) => e.state)).toEqual(['grace', 'release']);
    stepN(g, g.ticks(500) * 2 + 5);
    expect(evs(g.events, 'danger').map((e) => e.state)).toEqual(['grace', 'release', 'grace']);
  });

  it('同じロジックtickで両者が敗北した場合は引分け', () => {
    const g = makeGame({ boards: { 0: rows(7), 1: rows(7) } }, testConfig({ naturalRiseIntervalMs: 500 }));
    toPlay(g);
    stepN(g, 400);
    expect(g.result?.winner).toBeNull();
    expect(evs(g.events, 'danger').filter((e) => e.state === 'defeat').map((e) => e.player)).toEqual([0, 1]);
  });
});

describe('試合進行（確定）', () => {
  const quick = { naturalRiseIntervalMs: 1000, dangerGraceMs: 200 };

  it('2本先取（初期値）。ラウンド間は 勝敗表示→決定入力→READY→GO、決定入力は誤入力防止時間後のみ', () => {
    const m = new Match({ firstTo: 2, difficulty: 'normal', seed: 5, config: quick });
    const playRound = (loser: PlayerId) => {
      for (let i = 0; i < 2000 && m.state === 'round'; i++) m.step((m.game as Game).playing ? [cmd(loser, 'manualRise')] : []);
    };
    playRound(0);
    expect(m.state).toBe('roundResult');
    expect(m.wins).toEqual([0, 1]);
    m.step([], true); // 早すぎる決定入力は無視
    expect(m.state).toBe('roundResult');
    for (let i = 0; i < 60; i++) m.step([]);
    m.step([], true);
    expect(m.state).toBe('round');
    expect(m.round).toBe(2);
    expect((m.game as Game).playing).toBe(false); // READY から
    playRound(0);
    expect(m.state).toBe('matchResult');
    expect(m.matchWinner).toBe(1);
    // 試合結果では決定入力で勝手に再開しない（再戦／メニューを画面で選ぶ）
    for (let i = 0; i < 60; i++) m.step([], true);
    expect(m.state).toBe('matchResult');
    m.rematch();
    expect(m.wins).toEqual([0, 0]);
    expect(m.round).toBe(1);
    expect(m.state).toBe('round');
  });

  it('引分けは勝利数を増やさず同じラウンドを再試行。1本先取も選択可', () => {
    const m = new Match({ firstTo: 1, difficulty: 'normal', seed: 5, config: quick });
    for (let i = 0; i < 2000 && m.state === 'round'; i++) m.step([]);
    expect((m.game as Game).result?.winner).toBeNull();
    expect(m.state).toBe('roundResult');
    expect(m.wins).toEqual([0, 0]);
    for (let i = 0; i < 60; i++) m.step([]);
    m.step([], true);
    expect([m.round, m.attempt]).toEqual([1, 1]);
    for (let i = 0; i < 2000 && m.state === 'round'; i++) m.step((m.game as Game).playing ? [cmd(1, 'manualRise')] : []);
    expect(m.state).toBe('matchResult');
    expect(m.matchWinner).toBe(0);
  });
});

describe('初期配置・ID', () => {
  it('MATCH：各プレイヤー6列×下側3段＝18個、READY中は入力を受け付けない', () => {
    const g = makeGame({}, testConfig(), 99);
    for (const p of g.players) {
      expect(p.board.cols.every((c) => c.length === 3)).toBe(true);
      expect(p.board.allIds()).toHaveLength(18);
    }
    g.step([cmd(0, 'launch')]);
    expect(evs(g.events, 'launch')).toHaveLength(0);
  });

  it('帰還中に上昇・攻撃SNAPが重なっても、帰還完了tickは固定でピースIDは一意', () => {
    const g = makeGame({ base: '1s', boards: { 0: { 2: ['4d', '6h'] } } });
    toPlay(g);
    g.step([cmd(0, 'launch')]);
    stepN(g, g.ticks(g.config.timing.launchMs));
    const arrive = evs(g.events, 'arrive')[0];
    stepUntil(g, arrive.arcEndTick + 2);
    g.step([cmd(0, 'manualRise'), atk(0, 2)]);
    stepUntil(g, arrive.returnEndTick);
    expect(evs(g.events, 'returned')[0].tick).toBe(arrive.returnEndTick);
    const ids = allPieceIds(g);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
