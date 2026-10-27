// v3.1.0 CPU（v3.2.0 の設定値・判断停止へ更新）：設定の参照、抽選のタイミングと回数、seed 再現、停止と失念の重ね掛けなし、ピンチ時の6ピース役判断、MODE2
import { describe, expect, it } from 'vitest';
import type { Game } from '../src/core/game';
import { Mode2Game } from '../src/core/mode2';
import { CPU_CONFIG, CpuController, type CpuConfig } from '../src/input/cpu';
import { shortestPaths, simCols } from '../src/input/cpuPlan';
import { EMPTY, kind, makeGame, setStock, toPlay } from './helpers';

const K = (o: Record<string, unknown>) => ['kotaro', 'akane', 'zunko'].map((c) => o[c]);
const clone = (): CpuConfig => JSON.parse(JSON.stringify(CPU_CONFIG));
/** 判断停止を0%に（他の判断だけを見る） */
const noStop = (cfg: CpuConfig, level: 'easy' | 'normal' | 'hard', ch: 'kotaro' | 'akane' | 'zunko' = 'kotaro') => {
  cfg.decisionStop[level].pct[ch] = 0;
};

describe('v3.2.0 CPU 設定ファイル（初期採用値）', () => {
  it('確率・停止時間・判断余裕は設定ファイルにあり、指示の表どおり（列順 コタロー／アカネ／ずん子）', () => {
    const c = CPU_CONFIG;
    expect(c.version).toBe('cpu-v3.2.0-initial');
    const pm = (o: Record<string, { pct: number; ms: number }>) => K(o).map((x) => `${(x as { pct: number }).pct}/${(x as { ms: number }).ms}`);
    expect(c.decisionStopWeights).toEqual([25, 50, 25]);
    expect(K(c.decisionStop.easy.pct)).toEqual([45, 50, 55]);
    expect(K(c.decisionStop.normal.pct)).toEqual([25, 20, 25]);
    expect(K(c.decisionStop.hard.pct)).toEqual([12, 10, 12]);
    expect([c.decisionStop.easy.normalMs, c.decisionStop.normal.normalMs, c.decisionStop.hard.normalMs]).toEqual([[700, 1000, 1300], [460, 660, 860], [140, 220, 300]]);
    expect([c.decisionStop.easy.pinchMs, c.decisionStop.normal.pinchMs, c.decisionStop.hard.pinchMs]).toEqual([[350, 500, 650], [230, 330, 430], [70, 110, 150]]);
    expect([c.bestPick.easy, c.bestPick.normal, c.bestPick.hard].flatMap((x) => [K(x.normal), K(x.pinch)])).toEqual([
      [50, 48, 54],
      [56, 54, 60],
      [75, 73, 77],
      [80, 78, 82],
      [80, 85, 90],
      [99, 99, 100],
    ]);
    expect(pm(c.forget.easy.normal)).toEqual(['20/180', '24/160', '16/200']);
    expect(pm(c.forget.easy.pinch)).toEqual(['10/120', '12/100', '8/120']);
    expect(pm(c.forget.normal.normal)).toEqual(['14/120', '16/100', '12/140']);
    expect(pm(c.forget.normal.pinch)).toEqual(['8/80', '10/70', '6/90']);
    expect(pm(c.forget.hard.normal)).toEqual(['10/70', '12/60', '8/80']);
    expect(K(c.forget.hard.pinch).map((x) => (x as { pct: number }).pct)).toEqual([0, 0, 0]);
    expect([c.seventhImprove.easy, c.seventhImprove.normal, c.seventhImprove.hard].flatMap((x) => [K(x.normal), K(x.pinch)])).toEqual([
      [10, 15, 8],
      [0, 0, 0],
      [30, 40, 25],
      [8, 12, 6],
      [50, 60, 45],
      [20, 30, 15],
    ]);
    const six = (d: 'easy' | 'normal' | 'hard', s: 'normal' | 'pinch') => [K(c.sixChallenge[d][s].hand3), K(c.sixChallenge[d][s].hand4Role), K(c.sixChallenge[d][s].hand5Role4)];
    expect(six('easy', 'normal')).toEqual([[30, 40, 25], [25, 35, 20], [65, 75, 60]]);
    expect(six('normal', 'normal')).toEqual([[55, 65, 45], [45, 60, 35], [85, 92, 80]]);
    expect(six('hard', 'normal')).toEqual([[75, 85, 65], [65, 80, 55], [96, 99, 93]]);
    expect(six('easy', 'pinch')).toEqual([[15, 25, 10], [15, 25, 10], [55, 65, 50]]);
    expect(six('normal', 'pinch')).toEqual([[45, 55, 35], [40, 50, 30], [80, 88, 75]]);
    expect(six('hard', 'pinch')).toEqual([[75, 85, 65], [70, 80, 60], [95, 98, 92]]);
    expect([K(c.declareFour.easy.normal), K(c.declareFour.normal.normal), K(c.declareFour.hard.normal)]).toEqual([[90, 85, 95], [95, 90, 98], [98, 95, 100]]);
    for (const d of ['easy', 'normal', 'hard'] as const) {
      expect(K(c.declareFour[d].pinch)).toEqual([100, 100, 100]);
      expect([...K(c.declareSix[d].normal), ...K(c.declareSix[d].pinch)]).toEqual([100, 100, 100, 100, 100, 100]);
    }
    const rise = (d: 'easy' | 'normal' | 'hard') => [K(c.manualRise[d].rows0), K(c.manualRise[d].rows1), K(c.manualRise[d].rows2)];
    expect(rise('easy')).toEqual([[100, 100, 100], [80, 90, 70], [35, 50, 25]]);
    expect(rise('normal')).toEqual([[100, 100, 100], [90, 95, 85], [50, 65, 40]]);
    expect(rise('hard')).toEqual([[100, 100, 100], [95, 100, 90], [65, 80, 55]]);
    expect(c.pinchMarginMs).toEqual({ easy: 500, normal: 350, hard: 200 });
    expect([K(c.mode2BestPick.easy), K(c.mode2BestPick.normal), K(c.mode2BestPick.hard)]).toEqual([[50, 48, 54], [75, 73, 77], [98, 97, 99]]);
    expect(c.actionGapMs).toBe(0);
  });
});

/** CPU とゲームを一緒に進める */
function play(g: Game | Mode2Game, cpu: CpuController, ticks: number) {
  const cmds: string[] = [];
  for (let i = 0; i < ticks && !g.result; i++) {
    const out = cpu.poll(g);
    for (const c of out) cmds.push(`${g.tick}:${c.type}`);
    g.step(out);
  }
  return cmds;
}

describe('v3.1.0 CPU 抽選のタイミング・回数・再現', () => {
  it('同じ seed・同じ盤面なら同じ判断（操作列と抽選記録が一致）。seed が違えば抽選結果が変わり得る', () => {
    const run = (seed: number) => {
      const g = makeGame({}, undefined, 11);
      toPlay(g);
      const cpu = new CpuController(0, 'easy', seed, 'akane');
      return { cmds: play(g, cpu, 900), log: cpu.log.map((l) => `${l.tick}:${l.kind}:${l.hit}`) };
    };
    expect(run(5)).toEqual(run(5));
    expect(run(5).log.length).toBeGreaterThan(10);
  });

  it('毎フレーム再抽選しない：同じtickに同じ種類の抽選は1回まで。停止中は抽選しない', () => {
    const g = makeGame({}, undefined, 11);
    toPlay(g);
    const cpu = new CpuController(0, 'easy', 3, 'kotaro');
    play(g, cpu, 1500);
    const seen = new Set<string>();
    for (const l of cpu.log) {
      const k = `${l.tick}:${l.kind}`;
      if (l.kind === 'bestPick' || l.kind === 'decisionStop' || l.kind === 'forget') {
        expect(seen.has(k), k).toBe(false);
        seen.add(k);
      }
    }
    // 判断の機会ごとに停止抽選1回：停止が当たった直後の次の抽選は判断そのもの（再度の停止抽選ではない）
    const ix = cpu.log.findIndex((l) => l.kind === 'decisionStop' && l.hit);
    expect(ix).toBeGreaterThanOrEqual(0);
    const next = cpu.log.slice(ix + 1).find((l) => l.kind !== 'sixChallenge' && l.kind !== 'declareFour' && l.kind !== 'manualRise' && l.kind !== 'declareSix' && l.kind !== 'seventhImprove');
    expect(next?.kind).not.toBe('decisionStop');
  });

  it('失念：移動計画につき1回だけ抽選し、当たれば停止後に再判断（同じ移動機会で再失念しない・目的地なしの停止を重ねない）', () => {
    const cfg = clone();
    cfg.forget.easy.normal.kotaro = { pct: 100, ms: 200 };
    noStop(cfg, 'easy');
    const g = makeGame({ base: '1s', boards: { 0: { 0: ['2s', '3d'], 1: ['3d'], 2: ['3d'], 3: ['3d'], 4: ['3d'], 5: ['3d'] }, 1: EMPTY } });
    toPlay(g);
    g.players[0].selectedCol = 5;
    const cpu = new CpuController(0, 'easy', 1, 'kotaro', cfg);
    const cmds = play(g, cpu, 120);
    const forget = cpu.log.filter((l) => l.kind === 'forget');
    expect(forget[0].hit).toBe(true);
    // 失念は最初の移動計画で1回。再判断後の同じ移動機会（最初の打ち上げまで）では抽選しない
    const firstLaunch = g.events.find((e) => e.type === 'launch')!.tick;
    expect(forget.filter((l) => l.tick <= firstLaunch)).toHaveLength(1);
    const stopAfter = cpu.log.filter((l) => l.kind === 'decisionStop' && l.tick > forget[0].tick && l.tick < forget[0].tick + 30);
    expect(stopAfter).toHaveLength(0);
    expect(cpu.stats.forgetRolls).toBeGreaterThanOrEqual(1);
    expect(cpu.stats.forgetStops).toBeGreaterThanOrEqual(1);
    // 最初の1歩 → 失念停止（約200ms）→ 再判断して移動を続け、打ち上げる
    const moves = cmds.filter((c) => c.endsWith(':left'));
    expect(moves.length).toBeGreaterThanOrEqual(5);
    const t1 = Number(moves[0].split(':')[0]);
    const t2 = Number(moves[1].split(':')[0]);
    expect(t2 - t1).toBeGreaterThanOrEqual(g.ticks(200));
    expect(cmds.some((c) => c.endsWith(':launch'))).toBe(true);
  });

  it('存在しない・取得不能な候補を選ばない：最上段が帰還予約の列や不成功の列へ打ち上げない（意図的なミスなし）', () => {
    const g = makeGame({ base: '1s', boards: { 0: { 0: ['4d', '5h'], 1: ['5d'], 2: ['2s', '6h'], 3: ['4h'], 4: ['3h'], 5: ['4c'] }, 1: EMPTY } });
    toPlay(g);
    const cpu = new CpuController(0, 'easy', 9, 'akane');
    for (let i = 0; i < 40; i++) {
      const out = cpu.poll(g);
      if (out.some((c) => c.type === 'launch')) {
        const top = g.players[0].board.top(g.players[0].selectedCol);
        expect(top && top.kind === 'piece' ? `${top.piece.n}${top.piece.suit}` : 'none').toBe('2spade');
        break;
      }
      g.step(out);
    }
  });
});

describe('v3.1.0 CPU 役の判断（6ピース役への挑戦、ピンチの期限）', () => {
  /** 手元 1♠2♠3♠4♠（4ピース役成立）、盤面に 5♠・6♠（6ピース役への経路） */
  function setup(level: 'easy' | 'normal' | 'hard', pinchTicks: number | null, cfg: CpuConfig) {
    const g = makeGame({ base: '4s', boards: { 0: { 0: ['5s', '1h'], 1: ['6s', '1h'], 2: ['1h'], 3: ['1h'], 4: ['1h'], 5: ['1h'] }, 1: EMPTY } });
    toPlay(g);
    setStock(g, 0, '1s', '2s', '3s', '4s');
    g.players[0].incoming.pinchRemaining = pinchTicks;
    return { g, cpu: new CpuController(0, level, 1, 'kotaro', cfg) };
  }

  it('経路の確認：手元4から 5♠→6♠ の2取得でスーパーストレート＋フラッシュ（6ピース役）', () => {
    const { g } = setup('hard', null, CPU_CONFIG);
    const p = g.players[0];
    const t = g.config.timing;
    const paths = shortestPaths(simCols(p.board), g.base, p.roleStock, p.selectedCol, 6, 2, { charMoveMs: t.charMoveMs, launchMs: t.launchMs, packMs: t.packMs });
    expect(paths.get(0)).toMatchObject({ steps: 2, ms: 2 * 90 + 420 + 90 + 420 });
  });

  it('ピンチ・手元4で役成立：期限内の経路があれば挑戦率で抽選（100%で挑戦→移動）。期限外なら抽選せず宣言', () => {
    const cfg = clone();
    cfg.sixChallenge.hard.pinch.hand4Role.kotaro = 100;
    noStop(cfg, 'hard');
    // v3.2.0 見積り：最短経路1020ms＋判断停止・失念の期待値（ここでは0）＋宣言受理1tick＋安全余裕200ms ≒ 1236.7ms（導入700msは加えない）
    const a = setup('hard', 240, cfg);
    const outA = a.cpu.poll(a.g);
    expect(outA.map((c) => c.type)).toEqual(['left']);
    expect(a.cpu.log.filter((l) => l.kind === 'sixChallenge')).toMatchObject([{ hit: true, pct: 100 }]);
    // 残り1167ms（70tick）：間に合わない → 抽選せず、今の成立役で宣言
    const b = setup('hard', 70, cfg);
    expect(b.cpu.poll(b.g).map((c) => c.type)).toEqual(['declare']);
    expect(b.cpu.log.filter((l) => l.kind === 'sixChallenge')).toHaveLength(0);
    // 境界：残り1233ms（74tick）は宣言、1250ms（75tick）は挑戦
    const c = setup('hard', 74, cfg);
    expect(c.cpu.poll(c.g).map((x) => x.type)).toEqual(['declare']);
    const d = setup('hard', 75, cfg);
    expect(d.cpu.poll(d.g).map((x) => x.type)).toEqual(['left']);
  });

  it('ピンチの見積りに判断停止の期待値を含める（停止確率×時間候補の加重平均）', () => {
    // 盤面が低いので1tick進めるとピンチが解除される：停止に外れた seed で、最初の判断だけを見る
    const firstMiss = (pinchTicks: number, cfg: CpuConfig) => {
      for (let seed = 1; seed < 60; seed++) {
        const x = setup('hard', pinchTicks, cfg);
        const cpu = new CpuController(0, 'hard', seed, 'kotaro', cfg);
        const out = cpu.poll(x.g);
        if (out.length) return out.map((c) => c.type);
      }
      throw new Error('no miss');
    };
    const cfg = clone();
    cfg.sixChallenge.hard.pinch.hand4Role.kotaro = 100;
    // 停止50%・候補2000ms → 期待値1000ms／取得 × 2取得 ＝ 2000ms：必要 ≒ 1020＋2000＋16.7＋200 ＝ 3236.7ms
    cfg.decisionStop.hard.pct.kotaro = 50;
    cfg.decisionStop.hard.pinchMs = [2000, 2000, 2000];
    expect(firstMiss(195, cfg)).toEqual(['left']); // 3250ms
    expect(firstMiss(194, cfg)).toEqual(['declare']); // 3233ms
    // 停止0%なら 1236.7ms で足りる
    noStop(cfg, 'hard');
    expect(firstMiss(75, cfg)).toEqual(['left']);
  });

  it('挑戦中は同じ計画が有効な間に再抽選しない。取得で経路が残れば継続、6ピース役完成で宣言100%', () => {
    const cfg = clone();
    cfg.sixChallenge.hard.normal.hand4Role.kotaro = 100;
    cfg.sixChallenge.hard.normal.hand5Role4.kotaro = 0; // 取得後に再抽選していれば宣言へ変わる
    noStop(cfg, 'hard');
    cfg.forget.hard.normal.kotaro = { pct: 0, ms: 0 };
    cfg.bestPick.hard.normal.kotaro = 100;
    const { g, cpu } = setup('hard', null, cfg);
    const cmds = play(g, cpu, 300);
    const d = g.events.find((e) => e.type === 'declare');
    // 宣言までの挑戦抽選は手元4での1回だけ（手元5へ進んでも再抽選しない）
    const six = cpu.log.filter((l) => l.kind === 'sixChallenge' && l.tick <= d!.tick);
    expect(six).toHaveLength(1);
    expect(d && d.type === 'declare' ? d.result.size : null).toBe(6);
    expect(cmds.filter((c) => c.endsWith(':declare')).length).toBeGreaterThanOrEqual(1);
  });

  it('通常・4ピース役成立で6ピース役への経路なし：宣言率で1回抽選。外れたら役を維持する1取得の後に再評価', () => {
    const cfg = clone();
    cfg.declareFour.hard.normal.kotaro = 0;
    noStop(cfg, 'hard');
    const g = makeGame({ base: '4s', boards: { 0: { 0: ['4h', '1h'], 1: ['1h'], 2: ['1h'], 3: ['1h'], 4: ['1h'], 5: ['1h'] }, 1: EMPTY } });
    toPlay(g);
    setStock(g, 0, '1s', '2s', '3s', '4s');
    const cpu = new CpuController(0, 'hard', 1, 'kotaro', cfg);
    play(g, cpu, 20);
    expect(cpu.log.filter((l) => l.kind === 'declareFour')).toHaveLength(1);
    play(g, cpu, 200);
    // 1取得後（手元5・経路なし）は宣言
    expect(g.players[0].roleStock.length === 0 || g.events.some((e) => e.type === 'declare')).toBe(true);
    expect(cpu.log.filter((l) => l.kind === 'declareFour')).toHaveLength(1);
  });

  it('手動上昇：残り段数（最長列の段数）0段は100%。見送ったら盤面・手元が変わるまで再抽選しない', () => {
    const cfg = clone();
    cfg.manualRise.easy.rows2.kotaro = 0;
    const g = makeGame({ base: '1s', boards: { 0: { 0: ['4d', '5h'], 1: [], 2: [], 3: ['4h'], 4: [], 5: [] }, 1: EMPTY } });
    toPlay(g);
    const cpu = new CpuController(0, 'easy', 1, 'kotaro', cfg);
    for (let i = 0; i < 30; i++) g.step(cpu.poll(g));
    expect(cpu.log.filter((l) => l.kind === 'manualRise')).toHaveLength(1);
    const e = makeGame({ base: '1s', boards: { 0: EMPTY, 1: EMPTY } });
    toPlay(e);
    const c2 = new CpuController(0, 'easy', 1, 'kotaro', cfg);
    const out = play(e, c2, 30);
    expect(out.some((c) => c.endsWith(':manualRise'))).toBe(true);
  });
});

describe('v3.1.0 CPU MODE2', () => {
  it('役・宣言・手動上昇の判断をしない（操作は移動・打ち上げのみ）。場の変化で目的地が出せなくなれば再判断', () => {
    const g = new Mode2Game({ seed: 4 });
    const cpu = new CpuController(1, 'normal', 2, 'zunko');
    const cmds = play(g, cpu, 2400);
    expect(cmds.length).toBeGreaterThan(10);
    expect(cmds.every((c) => /:(left|right|launch)$/.test(c))).toBe(true);
    expect(cpu.log.every((l) => ['decisionStop', 'bestPick', 'forget'].includes(l.kind))).toBe(true);
  });

  it('最適：移動と打ち上げが最短の候補（100%で最短の列）。候補が1つならそれを選ぶ', () => {
    const cfg = clone();
    cfg.mode2BestPick.hard.kotaro = 100;
    noStop(cfg, 'hard');
    const g = new Mode2Game({ seed: 4 });
    while (!g.playing) g.step();
    const p = g.players[0];
    g.base = { id: 9999, ...kind('1s') };
    for (let c = 0; c < 6; c++) p.board.cols[c] = [];
    p.board.cols[0] = [{ kind: 'piece', piece: { id: 9001, ...kind('2s') } }];
    p.board.cols[4] = [{ kind: 'piece', piece: { id: 9002, ...kind('2d') } }];
    p.selectedCol = 3;
    const cpu = new CpuController(0, 'hard', 1, 'kotaro', cfg);
    expect(cpu.poll(g).map((c) => c.type)).toEqual(['right']);
  });
});
