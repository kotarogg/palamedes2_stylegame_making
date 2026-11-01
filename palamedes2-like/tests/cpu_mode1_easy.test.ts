// V320-CPU-M1EASY-01：MODE1 初級（easy）だけの待ち時間（必須判断待ち・判断停止の時間候補を1.35倍）。
// - 実際の待ち処理（decisionStop）と所要時間見積り（expectedMandatoryMs・expectedStopMs）で指定値になること
// - MODE2・MODE1 中級／上級は、同じ seed・入力で変更前（MODE1 初級の設定なし）と挙動・乱数消費が一致すること
import { describe, expect, it } from 'vitest';
import type { Difficulty } from '../src/core/config';
import type { Game } from '../src/core/game';
import { Match, type AnyGame } from '../src/core/match';
import { CPU_CONFIG, CpuController, type CpuConfig } from '../src/input/cpu';
import type { Character } from '../src/audio/audioMap';
import { profileConfig } from '../src/measure/profile';
import { EMPTY, makeGame, toPlay } from './helpers';

/** 変更前と同じ設定（MODE1 初級の待ち時間なし＝共有の FIX-04 表と mode1Adjust だけ） */
const BEFORE: CpuConfig = { ...CPU_CONFIG, mode1Timing: undefined };

type Priv = {
  rng: { next(): number };
  stopUntil: number;
  mandatoryUntil: number;
  decisionStop(game: AnyGame, sit: 'normal' | 'pinch', tick: number): boolean;
  expectedMandatoryMs(sit: 'normal' | 'pinch'): number;
  expectedStopMs(sit: 'normal' | 'pinch'): number;
};
const priv = (c: CpuController) => c as unknown as Priv;

/** 乱数を固定値の列に差し替える（必須待ちの選択 → 停止の抽選 → 停止時間の選択） */
function stubRng(c: CpuController, values: number[]) {
  const it = values[Symbol.iterator]();
  priv(c).rng = { next: () => it.next().value ?? 0.5 };
}

function fakeGame(mode: 'mode1' | 'mode2'): AnyGame {
  const m = new Match({ firstTo: 1, difficulty: 'easy', seed: 1, mode });
  return m.game;
}

describe('MODE1 初級の待ち時間（V320-CPU-M1EASY-01）', () => {
  const NEW = { mandatory: { normal: [405, 540, 675], pinch: [203, 270, 338] }, stop: { normal: [945, 1350, 1755], pinch: [473, 675, 878] } };
  const OLD = { mandatory: { normal: [300, 400, 500], pinch: [150, 200, 250] }, stop: { normal: [700, 1000, 1300], pinch: [350, 500, 650] } };

  it('設定：MODE1 初級の表は指定値。共有の初級設定（MODE2 が使う）と停止確率・抽選重みは変更なし', () => {
    expect(CPU_CONFIG.mode1Timing?.mandatoryWait.easy).toEqual({ normalMs: NEW.mandatory.normal, pinchMs: NEW.mandatory.pinch });
    expect(CPU_CONFIG.mode1Timing?.decisionStopMs.easy).toEqual({ normalMs: NEW.stop.normal, pinchMs: NEW.stop.pinch });
    expect(Object.keys(CPU_CONFIG.mode1Timing!.mandatoryWait)).toEqual(['easy']);
    expect(Object.keys(CPU_CONFIG.mode1Timing!.decisionStopMs)).toEqual(['easy']);
    expect(CPU_CONFIG.mandatoryWait?.easy).toEqual({ normalMs: OLD.mandatory.normal, pinchMs: OLD.mandatory.pinch });
    expect(CPU_CONFIG.decisionStop.easy).toEqual({ pct: { kotaro: 45, akane: 50, zunko: 55 }, normalMs: OLD.stop.normal, pinchMs: OLD.stop.pinch });
    expect(CPU_CONFIG.decisionStopWeights).toEqual([25, 50, 25]);
    expect(CPU_CONFIG.mandatoryWaitWeights ?? [25, 50, 25]).toEqual([25, 50, 25]);
  });

  // 乱数 0.1／0.5／0.9 → 短／標準／長（重み 25／50／25）
  const pick = [0.1, 0.5, 0.9];
  it.each(['normal', 'pinch'] as const)('実際の待ち（%s）：MODE1 初級は指定値、tick 換算は game.ticks（既存の換算）。必須待ちの後に停止が続く', (sit) => {
    const g = fakeGame('mode1');
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const c = new CpuController(1, 'easy', 1, 'akane');
        stubRng(c, [pick[i], 0, pick[j]]); // 停止は当たり（0 < 50%）
        const tick = 100;
        expect(priv(c).decisionStop(g, sit, tick)).toBe(true);
        const m = NEW.mandatory[sit][i];
        const s = NEW.stop[sit][j];
        expect(priv(c).mandatoryUntil, `${m}`).toBe(tick + g.ticks(m));
        expect(priv(c).stopUntil, `${m}+${s}`).toBe(tick + g.ticks(m) + g.ticks(s));
      }
    }
  });

  it('MODE2 の初級・MODE1 の中級は、変わらず従来の値', () => {
    const g2 = fakeGame('mode2');
    const c2 = new CpuController(1, 'easy', 1, 'akane');
    stubRng(c2, [0.5, 0, 0.5]);
    priv(c2).decisionStop(g2, 'normal', 100);
    expect(priv(c2).stopUntil).toBe(100 + g2.ticks(400) + g2.ticks(1000));
    const g1 = fakeGame('mode1');
    const cn = new CpuController(1, 'normal', 1, 'akane');
    const before = new CpuController(1, 'normal', 1, 'akane', BEFORE);
    stubRng(cn, [0.5, 0, 0.5]);
    stubRng(before, [0.5, 0, 0.5]);
    priv(cn).decisionStop(g1, 'normal', 100);
    priv(before).decisionStop(g1, 'normal', 100);
    expect(priv(cn).stopUntil).toBe(priv(before).stopUntil);
  });

  it('所要時間の見積り（MODE1 のピンチ判定）：必須待ち・停止の期待値も指定値から計算', () => {
    const w = (a: number[]) => (a[0] * 25 + a[1] * 50 + a[2] * 25) / 100;
    for (const ch of ['kotaro', 'akane', 'zunko'] as Character[]) {
      const c = new CpuController(1, 'easy', 1, ch);
      const pct = CPU_CONFIG.decisionStop.easy.pct[ch] / 100;
      for (const sit of ['normal', 'pinch'] as const) {
        expect(priv(c).expectedMandatoryMs(sit)).toBeCloseTo(w(NEW.mandatory[sit]), 9);
        expect(priv(c).expectedStopMs(sit)).toBeCloseTo(pct * w(NEW.stop[sit]), 9);
      }
    }
    // 例：あかね・ピンチ＝0.5 ×（473×0.25＋675×0.5＋878×0.25）＝337.625ms、必須待ち＝270.25ms
    const a = new CpuController(1, 'easy', 1, 'akane');
    expect(priv(a).expectedStopMs('pinch')).toBeCloseTo(337.625, 9);
    expect(priv(a).expectedMandatoryMs('pinch')).toBeCloseTo(270.25, 9);
  });
});

describe('MODE1 初級の実プレイでの待ち（既定の設定。MODE1 のゲーム）', () => {
  it('必須判断待ち・判断停止はすべて指定値の候補から選ばれ、tick 合計は既存の換算（game.ticks）の和。候補の選択比はおおむね 25／50／25', () => {
    const mand = new Set(['normal 405ms', 'normal 540ms', 'normal 675ms', 'pinch 203ms', 'pinch 270ms', 'pinch 338ms']);
    const stop = new Set(['normal 945ms', 'normal 1350ms', 'normal 1755ms', 'pinch 473ms', 'pinch 675ms', 'pinch 878ms']);
    const idx: Record<string, number> = { '405': 0, '540': 1, '675': 2, '203': 0, '270': 1, '338': 2 };
    const share = [0, 0, 0];
    for (let seed = 1; seed <= 12; seed++) {
      for (const ch of ['kotaro', 'akane', 'zunko'] as Character[]) {
        const g = makeGame({}, undefined, seed);
        toPlay(g);
        const cpu = new CpuController(0, 'easy', seed, ch);
        for (let i = 0; i < 2400 && !g.result; i++) g.step(cpu.poll(g));
        const ms = cpu.log.filter((l) => l.kind === 'mandatoryWait');
        const hits = cpu.log.filter((l) => l.kind === 'decisionStop' && l.hit);
        for (const l of ms) {
          expect(mand.has(l.detail!), l.detail).toBe(true);
          share[idx[/(\d+)ms/.exec(l.detail!)![1]]]++;
        }
        for (const h of hits) expect(stop.has(h.detail!), h.detail).toBe(true);
        if (cpu.stats.mandatoryHalved === 0) expect(cpu.stats.mandatoryTicks).toBe(ms.reduce((a, l) => a + g.ticks(Number(/(\d+)ms/.exec(l.detail!)![1])), 0));
        if (cpu.stats.stopHalved === 0) expect(cpu.stats.stopTicks).toBe(hits.reduce((a, l) => a + g.ticks(Number(/(\d+)ms/.exec(l.detail!)![1])), 0));
      }
    }
    const n = share[0] + share[1] + share[2];
    expect(n).toBeGreaterThan(300);
    expect(share[0] / n).toBeGreaterThan(0.17);
    expect(share[0] / n).toBeLessThan(0.33);
    expect(share[1] / n).toBeGreaterThan(0.4);
    expect(share[1] / n).toBeLessThan(0.6);
  });

  it('順序とピンチ移行の半減（既存の処理）：必須待ち540ms＝32tick→判断停止1350ms＝81tick。10tick後にピンチへ移ると残り22→11・81→41（各1回）', () => {
    const cfg = JSON.parse(JSON.stringify(CPU_CONFIG)) as CpuConfig;
    cfg.decisionStop.easy.pct.kotaro = 100; // 停止確率は共有設定から（MODE1 初級でも同じ）
    cfg.decisionStopWeights = [0, 100, 0];
    cfg.mandatoryWaitWeights = [0, 100, 0];
    const g = makeGame({ base: '1s', boards: { 0: { 0: ['2s'], 1: ['3d'], 2: ['3d'], 3: ['3d'], 4: ['3d'], 5: ['3d'] }, 1: EMPTY } });
    toPlay(g);
    const cpu = new CpuController(0, 'easy', 1, 'kotaro', cfg);
    expect(cpu.poll(g)).toEqual([]);
    const start = g.tick + 1;
    expect([cpu.stats.mandatoryTicks, cpu.stats.stopTicks]).toEqual([g.ticks(540), g.ticks(1350)]);
    expect([g.ticks(540), g.ticks(1350)]).toEqual([32, 81]);
    expect(cpu.log.slice(0, 2).map((l) => l.kind)).toEqual(['mandatoryWait', 'decisionStop']);
    for (let i = 0; i < 10; i++) g.step(cpu.poll(g));
    g.players[0].incoming.pinchRemaining = 240;
    expect(cpu.poll(g)).toEqual([]);
    expect([cpu.stats.mandatoryHalved, cpu.stats.stopHalved]).toEqual([1, 1]);
    expect([cpu.stats.mandatoryTicks, cpu.stats.stopTicks]).toEqual([32 - 11, 81 - 40]);
    let first = -1;
    for (let i = 0; i < 120 && first < 0; i++) {
      g.players[0].incoming.pinchRemaining = 240;
      const out = cpu.poll(g);
      if (out.length) first = g.tick + 1;
      g.step(out);
    }
    expect(first - start).toBe(10 + 11 + 41);
    expect(cpu.log.filter((l) => l.kind === 'mandatoryWait')).toHaveLength(1);
  });
});

/** CPU 同士の試合を進め、盤面・イベント・CPU の判断記録・統計・乱数の位置を返す */
function runCpuMatch(mode: 'mode1' | 'mode2', level: Difficulty, seed: number, cfg: CpuConfig, ticks = 60 * 90) {
  const m = new Match({ firstTo: 2, difficulty: level, seed, mode, ...(mode === 'mode1' ? { config: profileConfig('B') } : {}) });
  const cpus = [new CpuController(0, level, seed, 'kotaro', cfg), new CpuController(1, level, seed + 1, 'zunko', cfg)];
  for (let i = 0; i < ticks && m.state !== 'matchResult'; i++) {
    const g = m.game;
    const cmds = cpus.flatMap((c) => c.poll(g));
    const before = m.game;
    m.step(cmds, m.state === 'roundResult');
    if (m.game !== before) cpus.forEach((c) => c.reset());
  }
  const g = m.game as Game;
  return {
    state: JSON.stringify({ wins: m.wins, round: m.round, tick: g.tick, snap: 'snapshot' in g ? (g as Game).snapshot() : null }),
    events: JSON.stringify(g.events),
    logs: cpus.map((c) => JSON.stringify(c.log)),
    stats: cpus.map((c) => JSON.stringify(c.stats)),
    rngNext: cpus.map((c) => priv(c).rng.next()), // 乱数の消費位置（同じなら次の値が一致）
  };
}

describe('変更前後の一致（MODE2・MODE1 中級／上級は同じ seed・入力で挙動と乱数消費が変わらない）', () => {
  const cases: ['mode1' | 'mode2', Difficulty, number][] = [
    ['mode2', 'easy', 3],
    ['mode2', 'easy', 17],
    ['mode2', 'normal', 5],
    ['mode2', 'hard', 7],
    ['mode1', 'normal', 3],
    ['mode1', 'normal', 19],
    ['mode1', 'hard', 5],
    ['mode1', 'hard', 23],
  ];
  it.each(cases)('%s・%s・seed %i：盤面・イベント・判断記録・統計・乱数の位置が一致', (mode, level, seed) => {
    const after = runCpuMatch(mode, level, seed, CPU_CONFIG);
    const before = runCpuMatch(mode, level, seed, BEFORE);
    expect(after).toEqual(before);
    expect(after.logs.some((l) => l.length > 2)).toBe(true); // 判断が実際に行われている
  });

  it('MODE1 初級は変わる（対照）：待ちが長くなり、乱数の消費回数は同じ（設定の選択で乱数を使わない）', () => {
    const after = runCpuMatch('mode1', 'easy', 3, CPU_CONFIG, 60 * 20);
    const before = runCpuMatch('mode1', 'easy', 3, BEFORE, 60 * 20);
    expect(after.state).not.toBe(before.state);
    // 最初の判断（必須待ち）の抽選は同じ乱数で行われ、時間だけが1.35倍
    const first = (l: string) => (JSON.parse(l) as { kind: string; detail?: string }[]).find((x) => x.kind === 'mandatoryWait')!.detail;
    const a = first(after.logs[0])!;
    const b = first(before.logs[0])!;
    expect(`${a} / ${b}`).toMatch(/^normal (405|540|675)ms \/ normal (300|400|500)ms$/);
    expect([...a.matchAll(/\d+/g)].map(Number)[0]).toBe({ 300: 405, 400: 540, 500: 675 }[[...b.matchAll(/\d+/g)].map(Number)[0] as 300 | 400 | 500]);
  });
});
