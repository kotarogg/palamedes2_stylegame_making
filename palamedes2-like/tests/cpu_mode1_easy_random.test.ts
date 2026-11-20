// V320-CPU-M1EASY-02：MODE1 初級のランダム打上げ（15%）・R1 列入替（適合2段目まで・同一エピソード最大1回）・QA-01（R1 計画の最新猶予での再評価）
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type GameConfig } from '../src/core/config';
import type { Command, Game, PlayerState } from '../src/core/game';
import { createSeededRng } from '../src/core/rng';
import { CPU_CONFIG, CpuController, type CpuConfig } from '../src/input/cpu';
import { EMPTY, makeGame, setStock, testConfig, toPlay } from './helpers';

/** 非公開の状態・処理へのアクセス（検証用） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const P = (c: CpuController) => c as unknown as Record<string, any>;
const clone = (): CpuConfig => JSON.parse(JSON.stringify(CPU_CONFIG));
/** ランダム打上げの確率・R1 の上限を変えた設定（検証用） */
function cfgWith(pct: number, rotate = 1, mut?: (c: CpuConfig) => void): CpuConfig {
  const c = clone();
  c.mode1Timing!.randomLaunchPct = { easy: pct };
  c.mode1Timing!.rotateLimit = { easy: rotate };
  mut?.(c);
  return c;
}
/** 判断待ち・停止・失念・手動上昇を外す（順序・選択だけを見る） */
const noWaits = (c: CpuConfig) => {
  c.mode1Timing!.mandatoryWait.easy = { normalMs: [0, 0, 0], pinchMs: [0, 0, 0] };
  for (const ch of ['kotaro', 'akane', 'zunko'] as const) {
    c.decisionStop.easy.pct[ch] = 0;
    c.forget.easy.normal[ch] = { pct: 0, ms: 0 };
    c.forget.easy.pinch[ch] = { pct: 0, ms: 0 };
    for (const r of ['rows0', 'rows1', 'rows2'] as const) c.manualRise.easy[r][ch] = 0;
  }
};
/** 手動上昇だけを外す（上昇で盤面が変わり、別の列が入替対象になるのを避ける） */
const noRise = (c: CpuConfig) => {
  for (const ch of ['kotaro', 'akane', 'zunko'] as const) for (const r of ['rows0', 'rows1', 'rows2'] as const) c.manualRise.easy[r][ch] = 0;
};
const B: Partial<GameConfig> = { timing: { ...DEFAULT_CONFIG.timing, launchMs: 200, packMs: 50 } };
const pieceSlot = (g: Game, code: string) => {
  const S: Record<string, 'spade' | 'heart' | 'diamond' | 'club'> = { s: 'spade', h: 'heart', d: 'diamond', c: 'club' };
  return { kind: 'piece' as const, piece: g.factory.make(Number(code[0]), S[code[1]]) };
};
/** 場3♠。適合：2・3・4 と♠。不適合の例：5h・6d・1c */
function board(cols: Record<number, string[]>, config: GameConfig = testConfig(), seed = 7): { g: Game; p: PlayerState } {
  // 指定しない列は空（makeGame は未指定の列に生成ピースを置くため明示する）
  const all: Record<number, string[]> = { ...EMPTY, ...cols };
  const g = makeGame({ base: '3s', boards: { 0: all, 1: EMPTY } }, config, seed);
  toPlay(g);
  g.players[0].selectedCol = 0; // 列1（0始まり）から始める
  return { g, p: g.players[0] };
}
function freshRngNext(seed: number, player = 0): number {
  return createSeededRng((Math.imul(seed, 2654435761) + Math.imul(player + 1, 1013904223)) >>> 0).next();
}

describe('設定（MODE1 初級だけ）', () => {
  it('ランダム打上げ15%・R1 上限1回は初級だけ。調整識別子 V320-CPU-M1EASY-02', () => {
    const m = CPU_CONFIG.mode1Timing!;
    expect(m.adjustment).toBe('V320-CPU-M1EASY-02');
    expect(m.randomLaunchPct).toEqual({ easy: 15 });
    expect(m.rotateLimit).toEqual({ easy: 1 });
  });
  it('MODE2・MODE1 中級／上級では無効（確率0・従来の打開）', () => {
    const g1 = board({ 0: ['5h'] }).g;
    for (const level of ['normal', 'hard'] as const) {
      const c = new CpuController(0, level, 1);
      expect([P(c).randomLaunchPct(g1), P(c).rotateLimit(g1)]).toEqual([0, 0]);
    }
    const e = new CpuController(0, 'easy', 1);
    expect([P(e).randomLaunchPct(g1), P(e).rotateLimit(g1)]).toEqual([15, 1]);
    expect([P(e).randomLaunchPct({ mode: 'mode2' }), P(e).rotateLimit({ mode: 'mode2' })]).toEqual([0, 0]);
  });
});

describe('ランダム打上げ', () => {
  // 列0 不適合・列1 空・列2 適合・列3 最上段が帰還予約・列4 不適合・列5 不適合（2段）
  const cols = { 0: ['5h'], 1: [], 2: ['4h'], 3: ['6d', '6d'], 4: ['6d'], 5: ['1c', '2s'] };
  const setup = () => {
    const r = board(cols);
    r.p.board.cols[3][0] = { kind: 'reserved', pieceId: 9999 };
    return r;
  };

  it('候補は発射可能な最上段のある列だけ（空列・最上段が予約の列は除く）。適合・不適合で選別せず一様', () => {
    const count: Record<number, number> = {};
    const n = 4000;
    for (let seed = 1; seed <= n; seed++) {
      const { g, p } = setup();
      const cpu = new CpuController(0, 'easy', seed, 'akane', cfgWith(100));
      const plan = P(cpu).rollRandomLaunch(g, p, g.tick + 1);
      count[plan.col] = (count[plan.col] ?? 0) + 1;
      expect(plan).toMatchObject({ action: 'launch', random: true });
    }
    expect(Object.keys(count).map(Number).sort()).toEqual([0, 2, 4, 5]);
    for (const c of [0, 2, 4, 5]) {
      expect(count[c] / n).toBeGreaterThan(0.22);
      expect(count[c] / n).toBeLessThan(0.28);
    }
  });

  it('当選率はおおむね設定どおり（15%）。外れは null（従来の取得判断へ）', () => {
    let hits = 0;
    const n = 4000;
    for (let seed = 1; seed <= n; seed++) {
      const { g, p } = setup();
      const cpu = new CpuController(0, 'easy', seed, 'akane');
      if (P(cpu).rollRandomLaunch(g, p, g.tick + 1)) hits++;
    }
    expect(hits / n).toBeGreaterThan(0.13);
    expect(hits / n).toBeLessThan(0.17);
  });

  it('同じ抽選機会（場・各列最上段・手役）では1回だけ。非移動操作の後・手役が変わったら次の機会', () => {
    const { g, p } = setup();
    const cpu = new CpuController(0, 'easy', 3, 'akane', cfgWith(15));
    P(cpu).rollRandomLaunch(g, p, 1);
    const pos = P(cpu).randomRng.next();
    // 同じ機会：抽選しない（専用乱数も使わない）
    const cpu2 = new CpuController(0, 'easy', 3, 'akane', cfgWith(15));
    P(cpu2).rollRandomLaunch(g, p, 1);
    expect(P(cpu2).rollRandomLaunch(g, p, 2)).toBeNull();
    expect(P(cpu2).stats.randomOpportunities).toBe(1);
    expect(P(cpu2).randomRng.next()).toBe(pos);
    // 手役が変わった：新しい機会
    const cpu3 = new CpuController(0, 'easy', 3, 'akane', cfgWith(15));
    P(cpu3).rollRandomLaunch(g, p, 1);
    setStock(g, 0, '5d');
    P(cpu3).rollRandomLaunch(g, p, 2);
    expect(P(cpu3).stats.randomOpportunities).toBe(2);
  });

  it('非移動操作（宣言・入替・上昇・発射）を出したら抽選機会をリセット（poll）', () => {
    const { g } = board({ 0: ['4h'] });
    const cpu = new CpuController(0, 'easy', 1, 'akane', cfgWith(0, 1, noWaits));
    let out: Command[] = [];
    for (let i = 0; i < 120 && !out.some((c) => c.type === 'launch'); i++) {
      out = cpu.poll(g);
      g.step(out);
    }
    expect(out.some((c) => c.type === 'launch')).toBe(true);
    expect(P(cpu).randomKey).toBe('');
  });

  it('0%：専用乱数を消費しない（抽選機会は数えるが乱数は使わない）', () => {
    const { g, p } = setup();
    const cpu = new CpuController(0, 'easy', 11, 'akane', cfgWith(0));
    for (let i = 0; i < 5; i++) {
      P(cpu).randomKey = '';
      expect(P(cpu).rollRandomLaunch(g, p, i)).toBeNull();
    }
    expect(P(cpu).stats.randomOpportunities).toBe(5);
    expect(P(cpu).randomRng.next()).toBe(freshRngNext(11));
  });

  it('候補なし（空列・予約だけ）：抽選しない（機会も数えない）', () => {
    const { g, p } = board({ 0: [], 1: [] });
    p.board.cols[2] = [{ kind: 'reserved', pieceId: 9999 }];
    const cpu = new CpuController(0, 'easy', 1, 'akane', cfgWith(100));
    expect(P(cpu).rollRandomLaunch(g, p, 1)).toBeNull();
    expect(P(cpu).stats.randomOpportunities).toBe(0);
    expect(P(cpu).randomKey).toBe('');
  });

  it('選んだ後は場が変わっても成否で取り消さない。物理的に発射できなくなったら取り消して通常の再判断', () => {
    const { g, p } = setup();
    const cpu = new CpuController(0, 'easy', 1, 'akane', cfgWith(100));
    P(cpu).randomRng = { next: () => 0 }; // 当選・候補の先頭（列0：不適合）
    const plan = P(cpu).rollRandomLaunch(g, p, 1);
    expect(plan.col).toBe(0);
    expect(P(cpu).planValid(g, p, plan)).toBe(true);
    g.base = g.factory.make(4, 'heart'); // 場が変わる
    expect(P(cpu).planValid(g, p, plan)).toBe(true);
    p.board.cols[0] = [{ kind: 'reserved', pieceId: 9999 }]; // 物理的に発射不能
    expect(P(cpu).planValid(g, p, plan)).toBe(false);
    P(cpu).plan = plan;
    P(cpu).thinkMode1(g, p, g.tick + 1);
    expect(P(cpu).stats.randomInvalid).toBe(1);
    // 通常の再判断へ戻る（新しい抽選機会。取り消した列0の計画は残らない）
    expect(P(cpu).plan?.col).not.toBe(0);
  });

  it('移動・失念停止を通っても選んだ列を保持し、実ゲームで発射（成否はゲームが判定）', () => {
    const { g, p } = board({ 0: ['4h'], 5: ['5h'] });
    const cfg = cfgWith(100, 1, (c) => {
      noWaits(c);
      c.forget.easy.normal.akane = { pct: 100, ms: 120 };
    });
    const cpu = new CpuController(0, 'easy', 1, 'akane', cfg);
    P(cpu).randomRng = { next: () => 0.99 }; // 当選・候補の最後（列5：不適合）
    for (let i = 0; i < 300 && !g.events.some((e) => e.type === 'arrive'); i++) g.step(cpu.poll(g));
    expect(P(cpu).stats.randomForgot).toBe(1);
    expect(P(cpu).stats.forgetStops).toBe(1);
    expect(cpu.randomLaunchLog.map((x) => x.col)).toEqual([5]);
    const launch = g.events.find((e) => e.type === 'launch' && e.player === 0)!;
    const arrive = g.events.find((e) => e.type === 'arrive' && e.player === 0)!;
    expect([launch.type === 'launch' && launch.col, arrive.type === 'arrive' && arrive.success]).toEqual([5, false]);
    expect(p.selectedCol).toBe(5);
  });

  it('7個目の追加取得の判断でもランダム打上げ（当選すれば取得先より優先）。外れは取得先', () => {
    for (const [pct, expectRandom] of [
      [100, true],
      [0, false],
    ] as const) {
      const { g, p } = setup();
      const cpu = new CpuController(0, 'easy', 1, 'akane', cfgWith(pct));
      P(cpu).randomRng = { next: () => 0.99 };
      P(cpu).role = { key: 'k', declare: false, goal: 'any', targetCol: 2 };
      P(cpu).destination(g, p, 'normal', g.tick + 1);
      expect(!!P(cpu).plan?.random, `pct ${pct}`).toBe(expectRandom);
      expect(P(cpu).plan.col).toBe(expectRandom ? 5 : 2);
    }
  });

  it('宣言の判断を先に行う（成立役の宣言はランダム打上げの抽選より先）', () => {
    const { g } = board({ 0: ['5h'], 1: ['6d'] });
    setStock(g, 0, '1s', '2s', '3s', '4s', '5s');
    const cpu = new CpuController(0, 'easy', 1, 'akane', cfgWith(100, 1, noWaits));
    let out: Command[] = [];
    for (let i = 0; i < 30 && out.length === 0; i++) {
      out = cpu.poll(g);
      g.step(out);
    }
    expect(out.map((c) => c.type)).toEqual(['declare']);
    expect(P(cpu).stats.randomOpportunities).toBe(0);
  });

  it('既存の手動上昇の選択を先に行う', () => {
    const { g } = board({ 0: ['5h'], 1: ['6d'] });
    const cfg = cfgWith(100, 1, (c) => {
      noWaits(c);
      c.manualRise.easy.rows1.akane = 100;
    });
    const cpu = new CpuController(0, 'easy', 1, 'akane', cfg);
    let out: Command[] = [];
    for (let i = 0; i < 30 && out.length === 0; i++) {
      out = cpu.poll(g);
      g.step(out);
    }
    expect(out.map((c) => c.type)).toEqual(['manualRise']);
    expect(P(cpu).stats.randomOpportunities).toBe(0);
  });

  it('ラウンド境界（reset）：抽選機会・計画・R1 履歴を初期化、専用乱数は続ける', () => {
    const { g, p } = setup();
    const cpu = new CpuController(0, 'easy', 5, 'akane', cfgWith(100));
    P(cpu).rollRandomLaunch(g, p, 1);
    P(cpu).r1Count = 1;
    P(cpu).r1Seen.add('x');
    cpu.reset();
    expect([P(cpu).randomKey, P(cpu).r1Episode, P(cpu).r1Count, P(cpu).r1Seen.size, P(cpu).plan]).toEqual(['', '', 0, 0, null]);
    expect(P(cpu).randomRng.next()).not.toBe(freshRngNext(5));
  });
});

describe('R1 列入替', () => {
  const r1 = (cols: Record<number, string[]>, config?: GameConfig) => {
    const { g, p } = board(cols, config);
    const cpu = new CpuController(0, 'easy', 1, 'akane', cfgWith(0));
    return { g, p, cpu };
  };

  it('場に適合する2段目がある列（2段以上・予約なし）だけ。1段の列・予約のある列・3段目だけ適合の列は対象外', () => {
    const a = r1({ 0: ['5h'], 1: ['6d', '5h'], 2: ['5h', '4h'], 3: ['6d'] });
    expect(P(a.cpu).recoverR1(a.g, a.p)).toEqual(['right']);
    expect(P(a.cpu).plan).toMatchObject({ col: 2, depth: 1, r1: true, action: 'rotate' });
    const b = r1({ 0: ['5h'], 2: ['5h', '4h'], 3: ['6d', '6d', '4h'] });
    b.p.board.cols[2].push({ kind: 'reserved', pieceId: 9999 });
    expect(P(b.cpu).recoverR1(b.g, b.p)).toEqual(['manualRise']); // 適合入替なし → 従来の合法な手動上昇
  });

  it('選択順位：予想時間の短い列（同値は近い列、さらに同値は列番号順）', () => {
    const a = r1({ 0: ['6d', '4h'], 2: ['5h'], 4: ['6d', '4h'] });
    a.p.selectedCol = 2;
    P(a.cpu).recoverR1(a.g, a.p);
    expect(P(a.cpu).plan.col).toBe(0); // 距離2同士：列番号の小さい方
    const b = r1({ 0: ['6d', '4h'], 2: ['5h'], 3: ['6d', '4h'] });
    b.p.selectedCol = 2;
    P(b.cpu).recoverR1(b.g, b.p);
    expect(P(b.cpu).plan.col).toBe(3); // 近い列
  });

  it('同じエピソード（場・各列ピース集合・手役）では1回まで。盤面・場・手役が変わったら新しいエピソード', () => {
    const a = r1({ 0: ['5h', '4h'] });
    expect(P(a.cpu).recoverR1(a.g, a.p)).toEqual(['rotate']);
    expect(P(a.cpu).r1Count).toBe(1);
    // 同じピース集合（入替で順序だけが変わった）→ 同じエピソード：2回目はしない
    a.p.board.cols[0].reverse();
    expect(P(a.cpu).recoverR1(a.g, a.p)).toEqual(['manualRise']);
    // 手役が変わった → 新しいエピソード
    setStock(a.g, 0, '6d');
    a.p.board.cols[0].reverse();
    expect(P(a.cpu).recoverR1(a.g, a.p)).toEqual(['rotate']);
  });

  it('既訪問盤面へ戻る入替はしない（循環の禁止）', () => {
    const a = r1({ 0: ['5h', '4h'] });
    P(a.cpu).r1EpisodeOf(a.g, a.p);
    const c = a.p.board.cols[0];
    const next = [c[1], c[0]].map((s) => (s.kind === 'piece' ? s.piece.id : '')).join('.');
    P(a.cpu).r1Seen.add([next, '', '', '', '', ''].join('/'));
    expect(P(a.cpu).recoverR1(a.g, a.p)).toEqual(['manualRise']);
  });

  it('計画の取消：場が変わった・予約ができた・通常取得候補が復活した・対象の2段目が不適合になった', () => {
    const mk = () => {
      const a = r1({ 0: ['5h'], 3: ['5h', '4h'] });
      P(a.cpu).recoverR1(a.g, a.p);
      return { ...a, plan: P(a.cpu).plan };
    };
    let a = mk();
    expect(P(a.cpu).planValid(a.g, a.p, a.plan)).toBe(true);
    a.g.base = a.g.factory.make(3, 'spade'); // 同じ数・柄でも別ピース（場IDが変わる）
    expect(P(a.cpu).planValid(a.g, a.p, a.plan)).toBe(false);
    a = mk();
    a.p.board.cols[3].push({ kind: 'reserved', pieceId: 9999 });
    expect(P(a.cpu).planValid(a.g, a.p, a.plan)).toBe(false);
    a = mk();
    a.p.board.cols[1] = [pieceSlot(a.g, '2s')]; // 通常取得候補が復活
    expect(P(a.cpu).planValid(a.g, a.p, a.plan)).toBe(false);
    a = mk();
    a.p.board.cols[3][1] = pieceSlot(a.g, '6d'); // 2段目が不適合
    expect(P(a.cpu).planValid(a.g, a.p, a.plan)).toBe(false);
  });
});

describe('QA-01：R1 の所要時間と最新猶予での再評価（候補選定・移動の途中・到着時・入替直前で同じ計算）', () => {
  const pinchCase = (config: GameConfig, restTicks: number) => {
    const { g, p } = board({ 0: ['5h', '4h'], 1: ['6d'] }, config);
    p.incoming.pinchRemaining = restTicks;
    const cpu = new CpuController(0, 'easy', 1, 'akane', cfgWith(0));
    const need = P(cpu).pinchNeedMs(g, P(cpu).r1OpsMs(g, p, 0, 1), 1);
    return { out: P(cpu).recoverR1(g, p), need };
  };

  it('候補選定（同じ列・未消化の待ち0）：B は1545.9167ms（93tick 採用／92tick 除外）、DEFAULT は1715.9167ms（103／102tick）', () => {
    const b93 = pinchCase(testConfig(B), 93);
    expect(b93.need).toBeCloseTo(1545.9167, 3);
    expect(b93.out).toEqual(['rotate']);
    expect(pinchCase(testConfig(B), 92).out).toEqual(['manualRise']);
    const d = pinchCase(testConfig(), 103);
    expect(d.need).toBeCloseTo(1715.9167, 3);
    expect(d.out).toEqual(['rotate']);
    expect(pinchCase(testConfig(), 102).out).toEqual(['manualRise']);
  });

  it('計算の内訳：判断待ち（必須待ち＋判断停止の期待値）・失念期待・1tick・安全余裕を各1回（判断待ちを二重に加えない）', () => {
    const { g, p } = board({ 0: ['5h', '4h'] }, testConfig(B));
    const cpu = new CpuController(0, 'easy', 1, 'akane');
    const ops = P(cpu).r1OpsMs(g, p, 0, 1);
    expect(ops).toBe(200 + 50 + 220);
    const wait = P(cpu).expectedMandatoryMs('pinch') + P(cpu).expectedStopMs('pinch');
    expect(wait).toBeCloseTo(547.25, 9);
    expect(P(cpu).pinchNeedMs(g, ops, 1)).toBeCloseTo(ops + wait + 0.12 * 100 + g.tickMs + 500, 9);
  });

  /**
   * 通常時に別の列（列6）の R1 を選び、移動する。条件の tick（列 atCol に着いて操作できる時）からピンチの残り restTicks を与え続ける。
   * 戻り値：入替を出したか・取消回数・入替の tick・判断時点の必要時間
   */
  function moving(config: GameConfig, atCol: number, restTicks: number | 'need+' | 'need-' | null) {
    const { g, p } = board({ 0: ['5h'], 1: ['6d'], 2: ['6d'], 3: ['6d'], 4: ['6d'], 5: ['5h', '4h'] }, config);
    const cpu = new CpuController(0, 'easy', 1, 'akane', cfgWith(0, 1, noRise));
    let rotateTick: number | null = null;
    let pinch: number | null = null;
    let need: number | null = null;
    let sawPlan = false;
    let after = 0; // ピンチを与えてからの tick（取消後も120tick 続け、元の列6で入替を出さないことを確かめる）
    let planAfterCancel: unknown = undefined;
    /** ピンチを与えた最初の判断（その tick の入替／取消） */
    let first: { rotate: boolean; cancel: boolean } | null = null;
    for (let i = 0; i < 900 && rotateTick === null && after < 120; i++) {
      if (pinch !== null) after++;
      if (P(cpu).plan?.r1) sawPlan = true;
      const ready = !g.isMoving(p) && !g.isLocked(p);
      if (pinch === null && restTicks !== null && p.selectedCol === atCol && ready && P(cpu).plan?.r1) {
        const n: number = P(cpu).pinchNeedMs(g, P(cpu).r1OpsMs(g, p, 5, 1), 1);
        need = n;
        const boundary = Math.floor(n / g.tickMs) + 1; // 必要時間を超える最小の tick
        pinch = restTicks === 'need+' ? boundary : restTicks === 'need-' ? boundary - 1 : restTicks;
      }
      if (pinch !== null) p.incoming.pinchRemaining = pinch;
      const before = P(cpu).stats.r1PinchCancels;
      const out = cpu.poll(g);
      if (P(cpu).stats.r1PinchCancels > before) planAfterCancel = P(cpu).plan;
      if (pinch !== null && first === null) first = { rotate: out.some((c) => c.type === 'rotate'), cancel: P(cpu).stats.r1PinchCancels > before };
      // 元の計画（列6）の入替だけを数える（取消後の通常判断で別の列を入替えるのは対象外）
      if (out.some((c) => c.type === 'rotate') && p.selectedCol === 5) rotateTick = g.tick + 1;
      g.step(out);
    }
    return { sawPlan, rotateTick, cancels: P(cpu).stats.r1PinchCancels, need, pinch, plan: planAfterCancel, tickMs: g.tickMs, first };
  }

  it('通常時に選んだ入替でも、到着時に B・残り1500ms なら入替を出さず計画を取り消して通常判断へ（上昇を強制しない）', () => {
    const r = moving(testConfig(B), 5, 90);
    expect(r.sawPlan).toBe(true);
    expect(r.rotateTick).toBeNull();
    expect(r.cancels).toBe(1);
    // 取り消した後は列6の入替計画が残らない（通常判断へ戻る）
    expect((r.plan as { col?: number; r1?: boolean } | null)?.r1 && (r.plan as { col: number }).col === 5).toBeFalsy();
  });

  it('移動の途中でピンチ入り（列3で残り1500ms）：その時点で取り消す', () => {
    const r = moving(testConfig(B), 2, 90);
    expect(r.sawPlan).toBe(true);
    expect(r.rotateTick).toBeNull();
    expect(r.cancels).toBe(1);
  });

  it('到着時の境界：必要時間を超える最小の tick は入替、1tick 少ないと取消（同じ計算・既に済んだ移動は数えない）', () => {
    const up = moving(testConfig(B), 5, 'need+');
    const down = moving(testConfig(B), 5, 'need-');
    expect(up.need).toBeCloseTo(down.need!, 9);
    // 到着時は移動0：操作時間は入替＋取得（470ms）。未消化の待ち（移動開始間隔の残り）だけが加わる
    expect(up.need! - 470 - 547.25 - 12 - up.tickMs - 500).toBeGreaterThanOrEqual(-1e-9);
    // 判断の tick：上側は入替、下側は入替を出さず取消（その後、未消化の待ちが減って間に合うようになれば改めて選ばれるのは正常）
    expect(up.first).toEqual({ rotate: true, cancel: false });
    expect(up.cancels).toBe(0);
    expect(down.first).toEqual({ rotate: false, cancel: true });
  });

  it('猶予が十分なら、ピンチ入りでも余計な再抽選・待ちを加えずに入替（ピンチなしと同じ tick）', () => {
    const base = moving(testConfig(B), 5, null);
    const ok = moving(testConfig(B), 5, 600);
    expect(base.rotateTick).not.toBeNull();
    expect(ok.rotateTick).toBe(base.rotateTick);
    expect(ok.cancels).toBe(0);
  });
});
