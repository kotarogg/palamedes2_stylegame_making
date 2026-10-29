// V320-FIX-04 計測（実装依頼書 第14章）：npx vitest run --config tools/vitest.measure.config.ts tools/cpu-fix04.measure.ts
// 同じ seed 群 1〜20 で、3難易度 × 3キャラ（または同レベルの3組）を比較する。
// - MODE2 単独完走：3難易度 × 3キャラ × seed 20 ＝ 180走（上限120ゲーム秒。詰まり・場の更新の時間を含む）
// - MODE2 対戦：同レベルの3組 × 3難易度 × seed 20 ＝ 180ラウンド
// - MODE1 対戦：同レベルの3組 × 3難易度 × seed 20 ＝ 180ラウンド（上限300ゲーム秒。自然上昇は難易度の周期。未決着は平均から除外し件数を明示）
// 環境変数 MEASURE_LEVELS（例 easy）で難易度を絞り、MEASURE_OUT で出力先を変える（旧版の初級の同条件再計測に使う）。
// CPU同士の机上計測であり、人間向けの難易度の合格を示すものではない。
import { mkdirSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import type { Character } from '../src/audio/audioMap';
import { DEFAULT_CONFIG, NATURAL_RISE_MS, type Difficulty } from '../src/core/config';
import { Game, type GameEvent } from '../src/core/game';
import { Mode2Game } from '../src/core/mode2';
import { CPU_CONFIG, CpuController } from '../src/input/cpu';

const OUT = new URL(process.env.MEASURE_OUT ?? '../docs/v320f04/cpu/', import.meta.url);
const LEVELS = (process.env.MEASURE_LEVELS?.split(',') ?? ['easy', 'normal', 'hard']) as Difficulty[];
const CHARS: Character[] = ['kotaro', 'akane', 'zunko'];
const PAIRS: [Character, Character][] = [
  ['kotaro', 'akane'],
  ['akane', 'zunko'],
  ['zunko', 'kotaro'],
];
const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);
const TICK_MS = 1000 / 60;
const M2_CAP_MS = 120_000;
const M1_CAP_MS = 300_000;

const r2 = (v: number) => Math.round(v * 100) / 100;
function summary(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return { n: 0 };
  const q = (p: number) => {
    const i = (n - 1) * p;
    const lo = Math.floor(i);
    return s[lo] + (s[Math.min(n - 1, lo + 1)] - s[lo]) * (i - lo);
  };
  return { n, mean: r2(s.reduce((a, b) => a + b, 0) / n), median: r2(q(0.5)), p10: r2(q(0.1)), p90: r2(q(0.9)), min: r2(s[0]), max: r2(s[n - 1]) };
}
const sec = (ticks: number) => r2((ticks * TICK_MS) / 1000);
const stat = (c: CpuController, k: string): number => (c.stats as unknown as Record<string, number>)[k] ?? 0;

/** 1体のCPUの待ち時間（ゲーム秒）：必須待ち・追加停止・失念 */
const waits = (c: CpuController) => ({ mandatorySec: sec(stat(c, 'mandatoryTicks')), mandatoryN: stat(c, 'mandatoryCount'), extraStopSec: sec(stat(c, 'stopTicks')), extraStopN: stat(c, 'stopHits'), forgetSec: sec(stat(c, 'forgetTicks')), forgetN: stat(c, 'forgetStops') });

/** 成功打上の間隔（秒）・宣言の間隔（秒） */
function intervals(events: readonly { type: string; tick: number }[], p: number, type: 'arrive' | 'declare'): number[] {
  const ts = events.filter((e) => e.type === type && (e as unknown as { player: number }).player === p && (type !== 'arrive' || (e as unknown as { success: boolean }).success)).map((e) => e.tick);
  return ts.slice(1).map((t, i) => sec(t - ts[i]));
}

interface Row {
  mode: 'mode2Single' | 'mode2Versus' | 'mode1';
  level: Difficulty;
  left: Character;
  right: Character | '';
  seed: number;
  completed: boolean;
  gameSec: number;
  winner: string;
  refreshes: number;
  refreshWaitSec: number;
  launchIntervalMean: number | null;
  declareIntervalMean: number | null;
  mandatorySec: number;
  extraStopSec: number;
  forgetSec: number;
  // MODE1
  attackPower?: number;
  canceled?: number;
  sent?: number;
  received?: number;
  overflow?: number;
  pinches?: number;
  pinchReleases?: number;
  defeatCause?: string;
  declares?: number;
}

const mean = (xs: number[]) => (xs.length ? r2(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const refreshWait = (g: Mode2Game) => {
  let sum = 0;
  let from: number | null = null;
  for (const e of g.events) {
    if (e.type === 'stuck') from = e.tick;
    else if (e.type === 'cardRefresh' && from !== null) {
      sum += e.tick - from;
      from = null;
    }
  }
  return sec(sum);
};

function mode2Single(level: Difficulty, ch: Character, seed: number): Row {
  const g = new Mode2Game({ seed, players: 1 });
  const cpu = new CpuController(0, level, seed, ch);
  while (!g.result && !(g.playing && (g.tick - g.playStartTick) * TICK_MS >= M2_CAP_MS)) g.step(cpu.poll(g));
  const w = waits(cpu);
  return {
    mode: 'mode2Single',
    level,
    left: ch,
    right: '',
    seed,
    completed: g.result?.outcome === 'clear',
    gameSec: r2(g.elapsedMs() / 1000),
    winner: '',
    refreshes: g.refreshCount,
    refreshWaitSec: refreshWait(g),
    launchIntervalMean: mean(intervals(g.events, 0, 'arrive')),
    declareIntervalMean: null,
    mandatorySec: w.mandatorySec,
    extraStopSec: w.extraStopSec,
    forgetSec: w.forgetSec,
  };
}

function mode2Versus(level: Difficulty, [a, b]: [Character, Character], seed: number): Row[] {
  const g = new Mode2Game({ seed, players: 2 });
  const cpus = [new CpuController(0, level, seed * 7 + 1, a), new CpuController(1, level, seed * 7 + 2, b)];
  while (!g.result && !(g.playing && (g.tick - g.playStartTick) * TICK_MS >= M2_CAP_MS)) g.step([...cpus[0].poll(g), ...cpus[1].poll(g)]);
  const r = g.result;
  const ws = cpus.map(waits);
  return [
    {
      mode: 'mode2Versus',
      level,
      left: a,
      right: b,
      seed,
      completed: !!r,
      gameSec: r ? sec(r.tick - g.playStartTick) : sec(g.tick - g.playStartTick),
      winner: !r ? 'undecided' : r.winner === null ? 'draw' : r.winner === 0 ? 'left' : 'right',
      refreshes: g.refreshCount,
      refreshWaitSec: refreshWait(g),
      launchIntervalMean: mean([...intervals(g.events, 0, 'arrive'), ...intervals(g.events, 1, 'arrive')]),
      declareIntervalMean: null,
      mandatorySec: r2(ws[0].mandatorySec + ws[1].mandatorySec),
      extraStopSec: r2(ws[0].extraStopSec + ws[1].extraStopSec),
      forgetSec: r2(ws[0].forgetSec + ws[1].forgetSec),
    },
  ];
}

function mode1(level: Difficulty, [a, b]: [Character, Character], seed: number): Row {
  const g = new Game({ seed, config: { ...DEFAULT_CONFIG, naturalRiseIntervalMs: NATURAL_RISE_MS[level] } });
  const cpus = [new CpuController(0, level, seed * 3, a), new CpuController(1, level, seed * 5 + 1, b)];
  const limit = g.playStartTick + Math.round(M1_CAP_MS / TICK_MS);
  while (!g.result && g.tick < limit) g.step([...cpus[0].poll(g), ...cpus[1].poll(g)]);
  const ev = g.events;
  const r = g.result;
  const ws = cpus.map(waits);
  const sum = <T extends GameEvent['type']>(type: T, f: (e: Extract<GameEvent, { type: T }>) => number) => ev.reduce((s, e) => s + (e.type === type ? f(e as Extract<GameEvent, { type: T }>) : 0), 0);
  let cause = '';
  if (r && r.winner !== null) {
    const loser = 1 - r.winner;
    const d = [...ev].reverse().find((e) => (e.type === 'danger' || e.type === 'attackPinch') && e.player === loser && e.state === 'defeat');
    cause = d ? (d.type === 'danger' ? 'natural_rise_pinch' : 'attack_pinch') : r.outcome;
  } else cause = r ? r.outcome : 'undecided';
  return {
    mode: 'mode1',
    level,
    left: a,
    right: b,
    seed,
    completed: !!r,
    gameSec: sec((r?.tick ?? g.tick) - g.playStartTick),
    winner: !r ? 'undecided' : r.winner === null ? 'draw' : r.winner === 0 ? 'left' : 'right',
    refreshes: 0,
    refreshWaitSec: 0,
    launchIntervalMean: mean([...intervals(ev, 0, 'arrive'), ...intervals(ev, 1, 'arrive')]),
    declareIntervalMean: mean([...intervals(ev, 0, 'declare'), ...intervals(ev, 1, 'declare')]),
    mandatorySec: r2(ws[0].mandatorySec + ws[1].mandatorySec),
    extraStopSec: r2(ws[0].extraStopSec + ws[1].extraStopSec),
    forgetSec: r2(ws[0].forgetSec + ws[1].forgetSec),
    attackPower: sum('attack', (e) => e.breakdown.power),
    canceled: sum('attack', (e) => e.counter.canceled),
    sent: sum('attack', (e) => e.counter.sent),
    received: sum('attackReceive', (e) => (e.cause === 'receive' ? e.accepted : 0)),
    overflow: sum('attackReceive', (e) => e.overflow),
    pinches: ev.filter((e) => e.type === 'pinchWarn' && e.state === 'start').length,
    pinchReleases: ev.filter((e) => e.type === 'pinchWarn' && e.state === 'end').length - (r && r.winner !== null ? 1 : 0),
    defeatCause: cause,
    declares: ev.filter((e) => e.type === 'declare').length,
  };
}

function group(rows: Row[]) {
  const done = rows.filter((r) => r.completed);
  const nums = (f: (r: Row) => number | null | undefined) => rows.map(f).filter((x): x is number => typeof x === 'number');
  const count = (f: (r: Row) => string) => rows.reduce((o, r) => ((o[f(r)] = (o[f(r)] ?? 0) + 1), o), {} as Record<string, number>);
  const base = {
    n: rows.length,
    completed: done.length,
    unfinished: rows.length - done.length,
    /** 完了例だけ（未完了は除外し件数を unfinished に明示） */
    gameSecCompleted: summary(done.map((r) => r.gameSec)),
    winners: count((r) => r.winner || '-'),
    launchIntervalSec: summary(nums((r) => r.launchIntervalMean)),
    declareIntervalSec: summary(nums((r) => r.declareIntervalMean)),
    mandatorySecPerRun: summary(nums((r) => r.mandatorySec)),
    extraStopSecPerRun: summary(nums((r) => r.extraStopSec)),
    forgetSecPerRun: summary(nums((r) => r.forgetSec)),
    refreshes: summary(nums((r) => r.refreshes)),
    refreshWaitSec: summary(nums((r) => r.refreshWaitSec)),
  };
  if (rows[0]?.mode !== 'mode1') return base;
  return {
    ...base,
    attackPower: summary(nums((r) => r.attackPower)),
    canceled: summary(nums((r) => r.canceled)),
    sent: summary(nums((r) => r.sent)),
    received: summary(nums((r) => r.received)),
    overflow: summary(nums((r) => r.overflow)),
    pinches: summary(nums((r) => r.pinches)),
    pinchReleases: summary(nums((r) => r.pinchReleases)),
    declares: summary(nums((r) => r.declares)),
    defeatCause: count((r) => r.defeatCause ?? ''),
  };
}

it('V320-FIX-04 CPU計測', () => {
  mkdirSync(OUT, { recursive: true });
  const t0 = Date.now();
  const rows: Row[] = [];
  for (const lv of LEVELS) for (const ch of CHARS) for (const s of SEEDS) rows.push(mode2Single(lv, ch, s));
  for (const lv of LEVELS) for (const pr of PAIRS) for (const s of SEEDS) rows.push(...mode2Versus(lv, pr, s));
  for (const lv of LEVELS) for (const pr of PAIRS) for (const s of SEEDS) rows.push(mode1(lv, pr, s));
  const out: Record<string, unknown> = {};
  for (const mode of ['mode2Single', 'mode2Versus', 'mode1'] as const)
    for (const lv of LEVELS) {
      const rs = rows.filter((r) => r.mode === mode && r.level === lv);
      out[`${mode}.${lv}`] = group(rs);
      const keys = mode === 'mode2Single' ? CHARS.map((c) => [c, (r: Row) => r.left === c] as const) : PAIRS.map((p) => [p.join('-'), (r: Row) => r.left === p[0] && r.right === p[1]] as const);
      for (const [k, f] of keys) out[`${mode}.${lv}.${k}`] = group(rs.filter(f));
    }
  const cols: (keyof Row)[] = ['mode', 'level', 'left', 'right', 'seed', 'completed', 'gameSec', 'winner', 'refreshes', 'refreshWaitSec', 'launchIntervalMean', 'declareIntervalMean', 'mandatorySec', 'extraStopSec', 'forgetSec', 'attackPower', 'canceled', 'sent', 'received', 'overflow', 'pinches', 'pinchReleases', 'defeatCause', 'declares'];
  writeFileSync(new URL('runs.csv', OUT), [cols.join(','), ...rows.map((r) => cols.map((c) => r[c] ?? '').join(','))].join('\n') + '\n');
  writeFileSync(
    new URL('summary.json', OUT),
    JSON.stringify(
      {
        id: 'V320-FIX-04',
        cpuConfig: { version: CPU_CONFIG.version, adjustment: (CPU_CONFIG as { adjustment?: string }).adjustment ?? null },
        seeds: '1〜20',
        caps: { mode2Sec: M2_CAP_MS / 1000, mode1Sec: M1_CAP_MS / 1000 },
        levels: LEVELS,
        note: 'CPU同士の机上計測（ゲーム内時間は60tick/秒換算）。人間向けの難易度の合格を示すものではない。未完了は平均から除外し unfinished に件数を明示',
        wallSec: Math.round((Date.now() - t0) / 1000),
        groups: out,
      },
      null,
      1,
    ),
  );
});
