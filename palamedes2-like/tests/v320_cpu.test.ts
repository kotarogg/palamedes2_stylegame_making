// v3.2.0 CPU（指示書 第3・4章）：判断時の停止（機会ごとに1回・時間候補・ピンチ移行で残り半分）、失念の件数、7個目による改善
import { describe, expect, it } from 'vitest';
import type { Game } from '../src/core/game';
import { CPU_CONFIG, CpuController, type CpuConfig } from '../src/input/cpu';
import { EMPTY, makeGame, setStock, toPlay } from './helpers';

const clone = (): CpuConfig => JSON.parse(JSON.stringify(CPU_CONFIG));

function play(g: Game, cpu: CpuController, ticks: number, untilLaunch = false) {
  const cmds: { tick: number; type: string }[] = [];
  for (let i = 0; i < ticks && !g.result; i++) {
    const out = cpu.poll(g);
    for (const c of out) cmds.push({ tick: g.tick + 1, type: c.type });
    g.step(out);
    if (untilLaunch && out.some((c) => c.type === 'launch')) break;
  }
  return cmds;
}

describe('v3.2.0 判断時の停止', () => {
  it('判断の機会（取得目標／宣言か追加取得か）につき1回だけ抽選：操作（打ち上げ・宣言・入替・上昇）の間に停止抽選は最大1回。移動1列ごとには抽選しない', () => {
    for (const level of ['easy', 'normal', 'hard'] as const) {
      const g = makeGame({}, undefined, 11);
      toPlay(g);
      const cpu = new CpuController(0, level, 3, 'zunko');
      const cmds = play(g, cpu, 3000);
      const acts = cmds.filter((c) => c.type !== 'left' && c.type !== 'right').map((c) => c.tick);
      expect(acts.length).toBeGreaterThan(5);
      let prev = -1;
      for (const t of acts) {
        const n = cpu.log.filter((l) => l.kind === 'decisionStop' && l.tick > prev && l.tick <= t).length;
        expect(n, `${level} ${prev}..${t}`).toBeLessThanOrEqual(1);
        prev = t;
      }
      expect(cpu.stats.stopRolls).toBe(cpu.log.filter((l) => l.kind === 'decisionStop').length);
    }
  });

  it('停止時間は時間候補（短／標準／長）のどれか。ms→tick は既存の四捨五入', () => {
    const g = makeGame({}, undefined, 11);
    toPlay(g);
    const cpu = new CpuController(0, 'easy', 5, 'zunko');
    play(g, cpu, 3000);
    const hits = cpu.log.filter((l) => l.kind === 'decisionStop' && l.hit);
    expect(hits.length).toBeGreaterThan(3);
    for (const h of hits) expect(['normal 700ms', 'normal 1000ms', 'normal 1300ms', 'pinch 350ms', 'pinch 500ms', 'pinch 650ms']).toContain(h.detail);
    expect(cpu.stats.stopTicks).toBe(hits.reduce((a, h) => a + g.ticks(Number(/(\d+)ms/.exec(h.detail!)![1])), 0) - 0);
  });

  it('通常の停止中にピンチへ移ったら、その時点の残り停止時間を半分に（1回だけ・引き直さない）', () => {
    const cfg = clone();
    cfg.decisionStop.easy.pct.kotaro = 100;
    cfg.decisionStopWeights = [0, 100, 0]; // 1000ms ＝ 60tick
    const g = makeGame({ base: '1s', boards: { 0: { 0: ['2s'], 1: ['3d'], 2: ['3d'], 3: ['3d'], 4: ['3d'], 5: ['3d'] }, 1: EMPTY } });
    toPlay(g);
    const cpu = new CpuController(0, 'easy', 1, 'kotaro', cfg);
    expect(cpu.poll(g)).toEqual([]);
    const start = g.tick + 1;
    expect(cpu.stats.stopTicks).toBe(60);
    for (let i = 0; i < 10; i++) g.step(cpu.poll(g));
    // 残り 60−10＝50tick の時点でピンチ（盤面が低いので次の進行で解除されるが、停止は半分のまま）
    g.players[0].incoming.pinchRemaining = 240;
    expect(cpu.poll(g)).toEqual([]);
    expect(cpu.stats.stopHalved).toBe(1);
    expect(cpu.stats.stopTicks).toBe(35);
    let first = -1;
    for (let i = 0; i < 60 && first < 0; i++) {
      g.players[0].incoming.pinchRemaining = 240;
      const out = cpu.poll(g);
      if (out.length) first = g.tick + 1;
      g.step(out);
    }
    expect(first - start).toBe(35);
    expect(cpu.stats.stopHalved).toBe(1);
    // 停止は1回だけ（ピンチ／通常の変化で引き直さない）
    expect(cpu.log.filter((l) => l.kind === 'decisionStop')).toHaveLength(1);
  });
});

describe('v3.2.0 失念の件数', () => {
  it('抽選対象・当選・実停止を分けて数える（隣接移動は当選しても実停止の機会がない）', () => {
    const cfg = clone();
    cfg.decisionStop.easy.pct.kotaro = 0;
    cfg.forget.easy.normal.kotaro = { pct: 100, ms: 180 };
    for (const r of ['rows0', 'rows1', 'rows2'] as const) cfg.manualRise.easy[r].kotaro = 0; // 低い盤面で手動上昇を挟まない
    // 隣接（1歩）：当選しても到着後は打ち上げなので実停止なし
    const g = makeGame({ base: '1s', boards: { 0: { 0: ['3d'], 1: ['3d'], 2: ['2s'], 3: ['3d'], 4: ['3d'], 5: ['3d'] }, 1: EMPTY } });
    toPlay(g);
    g.players[0].selectedCol = 3;
    const cpu = new CpuController(0, 'easy', 1, 'kotaro', cfg);
    play(g, cpu, 40, true);
    expect(cpu.stats).toMatchObject({ forgetRolls: 1, forgetHits: 1, forgetStops: 0 });
    // 3歩：移動開始後・到着前に1回止まる
    const h = makeGame({ base: '1s', boards: { 0: { 0: ['2s'], 1: ['3d'], 2: ['3d'], 3: ['3d'], 4: ['3d'], 5: ['3d'] }, 1: EMPTY } });
    toPlay(h);
    h.players[0].selectedCol = 3;
    const c2 = new CpuController(0, 'easy', 1, 'kotaro', cfg);
    play(h, c2, 80, true);
    expect(c2.stats).toMatchObject({ forgetRolls: 1, forgetHits: 1, forgetStops: 1, forgetTicks: 11 });
  });

  it('上級ピンチは失念0%', () => {
    expect(['kotaro', 'akane', 'zunko'].map((c) => CPU_CONFIG.forget.hard.pinch[c as 'kotaro'].pct)).toEqual([0, 0, 0]);
  });
});

describe('v3.2.0 7個目による改善（手役6個）', () => {
  /** 手役 1♥5♦1♠2♠3♠4♠（ストレートフラッシュ＝4ライン）。列0の5♠を取ると 5♦1♠2♠3♠4♠5♠ でハイストレートフラッシュ＝5ライン */
  function setup(level: 'easy' | 'normal' | 'hard', pct: number, pinch: number | null = null) {
    const cfg = clone();
    cfg.decisionStop[level].pct.kotaro = 0;
    cfg.forget[level].normal.kotaro = { pct: 0, ms: 0 };
    cfg.seventhImprove[level].normal.kotaro = pct;
    cfg.seventhImprove[level].pinch.kotaro = pct;
    const g = makeGame({ base: '4s', boards: { 0: { 0: ['5s', '1h'], 1: ['6s', '1h'], 2: ['1h'], 3: ['3h'], 4: ['1h'], 5: ['1h'] }, 1: EMPTY } });
    toPlay(g);
    setStock(g, 0, '1h', '5d', '1s', '2s', '3s', '4s');
    g.players[0].selectedCol = 2;
    g.players[0].incoming.pinchRemaining = pinch;
    return { g, cpu: new CpuController(0, level, 1, 'kotaro', cfg) };
  }

  it('改善候補（消去ライン数が厳密に増える）があれば抽選。当たれば通常の操作で取得し、改善したら宣言（8個目へ連鎖しない）', () => {
    const { g, cpu } = setup('hard', 100);
    play(g, cpu, 200);
    const d = g.events.find((e) => e.type === 'declare');
    expect(d && d.type === 'declare' ? d.result.han : null).toBe(5);
    // 6♠（列1）は 6個全体の役（スーパーストレート3ライン）が優先され改善にならないので候補外
    expect(cpu.log.filter((l) => l.kind === 'seventhImprove')).toMatchObject([{ hit: true, pct: 100, detail: 'normal +1' }]);
    expect(cpu.stats).toMatchObject({ seventhConsidered: 1, seventhExecuted: 1, seventhImproved: 1, seventhAborted: 0 });
  });

  it('外れたら現役を宣言（取得しない）', () => {
    const { g, cpu } = setup('hard', 0);
    expect(cpu.poll(g).map((c) => c.type)).toEqual(['declare']);
    expect(cpu.stats).toMatchObject({ seventhConsidered: 1, seventhExecuted: 0 });
  });

  it('改善候補が無ければ抽選せず宣言（同点で役名だけ変わる場合も追わない）', () => {
    const { g, cpu } = setup('hard', 100);
    g.players[0].board.cols[0].shift(); // 5♠を除く：残る 6♠ は改善にならない
    expect(cpu.poll(g).map((c) => c.type)).toEqual(['declare']);
    expect(cpu.log.filter((l) => l.kind === 'seventhImprove')).toHaveLength(0);
  });

  it('ピンチ：見積り上の余裕があれば抽選、余裕不足は抽選せず宣言', () => {
    // 2歩＋発射＋上詰め ＋判断停止・失念の期待値（ここでは0）＋宣言受理1tick＋安全余裕200ms。これより長い残り猶予なら抽選
    const g0 = setup('hard', 100).g;
    const t = g0.config.timing;
    const need = 2 * t.charMoveMs + t.launchMs + t.packMs + g0.tickMs + 200;
    const edge = Math.floor(need / g0.tickMs); // この tick 数では足りない
    const a = setup('hard', 100, edge + 1);
    expect(a.cpu.poll(a.g).map((c) => c.type)).toEqual(['left']);
    const b = setup('hard', 100, edge);
    expect(b.cpu.poll(b.g).map((c) => c.type)).toEqual(['declare']);
    expect(b.cpu.stats).toMatchObject({ seventhConsidered: 1, seventhNoMargin: 1, seventhExecuted: 0 });
    expect(b.cpu.log.filter((l) => l.kind === 'seventhImprove')).toHaveLength(0);
  });

  it('挑戦中に場が変わって改善候補が無くなれば、再抽選せず中止して宣言', () => {
    const { g, cpu } = setup('hard', 100);
    const out = cpu.poll(g);
    expect(out.map((c) => c.type)).toEqual(['left']);
    g.step(out);
    while (g.isMoving(g.players[0])) g.step();
    g.players[0].board.cols[0].shift(); // 目標の5♠が無くなった
    expect(cpu.poll(g).map((c) => c.type)).toEqual(['declare']);
    expect(cpu.stats).toMatchObject({ seventhExecuted: 1, seventhAborted: 1, seventhImproved: 0 });
    expect(cpu.log.filter((l) => l.kind === 'seventhImprove')).toHaveLength(1);
  });
});

describe('v3.2.0 7個目：挑戦中に通常からピンチへ移った場合', () => {
  function committed(pinchTicks: number) {
    const cfg = clone();
    cfg.decisionStop.hard.pct.kotaro = 0;
    cfg.forget.hard.normal.kotaro = { pct: 0, ms: 0 };
    cfg.seventhImprove.hard.normal.kotaro = 100;
    cfg.seventhImprove.hard.pinch.kotaro = 0; // ピンチで再抽選していれば宣言へ変わる
    const g = makeGame({ base: '4s', boards: { 0: { 0: ['5s', '1h'], 1: ['6s', '1h'], 2: ['1h'], 3: ['3h'], 4: ['1h'], 5: ['1h'] }, 1: EMPTY } });
    toPlay(g);
    setStock(g, 0, '1h', '5d', '1s', '2s', '3s', '4s');
    g.players[0].selectedCol = 2;
    const cpu = new CpuController(0, 'hard', 1, 'kotaro', cfg);
    const out = cpu.poll(g);
    expect(out.map((c) => c.type)).toEqual(['left']);
    g.step(out);
    while (g.isMoving(g.players[0])) g.step();
    g.players[0].incoming.pinchRemaining = pinchTicks;
    return { g, cpu };
  }

  it('手役が同じなら取得済みと誤認しない：余裕があれば再抽選せず継続、無ければ中止して宣言', () => {
    const a = committed(240);
    expect(a.cpu.poll(a.g).map((c) => c.type)).toEqual(['left']);
    expect(a.cpu.log.filter((l) => l.kind === 'seventhImprove')).toHaveLength(1);
    expect(a.cpu.stats).toMatchObject({ seventhExecuted: 1, seventhAborted: 0, seventhNoGain: 0 });
    const b = committed(10);
    expect(b.cpu.poll(b.g).map((c) => c.type)).toEqual(['declare']);
    expect(b.cpu.stats).toMatchObject({ seventhExecuted: 1, seventhAborted: 1, seventhNoGain: 0, seventhImproved: 0 });
  });
});

describe('v3.2.0 初期設定', () => {
  it('新規設定の CPU 難易度は初級', async () => {
    const { defaultSettings, parseSettings } = await import('../src/input/settings');
    expect(defaultSettings().npcLevel).toBe('easy');
    // 保存済みの設定は上書きしない
    expect(parseSettings(JSON.stringify({ npcLevel: 'hard' })).npcLevel).toBe('hard');
  });
});
