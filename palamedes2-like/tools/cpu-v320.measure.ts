// v3.2.0 計測（指示書 第10章）：npm run measure:cpu -- tools/cpu-v320.measure.ts
// - MODE2 単独完走：3難易度 × 3キャラ × 盤面seed 10種 × CPU判断seed 3種 ＝ 270回。GO（入力可能）から最後の成功・クリアまでのゲーム内時間（上限180ゲーム秒）
// - MODE2 対戦：3難易度 × 異なるキャラ3組 × 盤面10種 × 左右交換2 ＝ 180ラウンド（同レベル同士）。単独とは別集計。勝者の決着時間を敗者の完走時間として扱わない
// - MODE1：3難易度 × 3組 × seed 10（1ラウンド・上限5分）。決着率・宣言間隔・攻撃量・役連鎖・手役数別のピンチ解除／敗北・7個目の判断
// - 判断停止の ms→tick 換算（設定平均と実tick平均の差）、先行入力2tickのフレームレート別の実時間窓
// CPU同士の結果であり、人間向けの強さ・難易度の合格を示すものではない。結果は test-results/cpu-v320/ へ（docs/v320/ へ写す）。
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { it } from 'vitest';
import type { Character } from '../src/audio/audioMap';
import { DEFAULT_CONFIG, NATURAL_RISE_MS, type Difficulty } from '../src/core/config';
import { FixedStepDriver } from '../src/core/driver';
import { Game } from '../src/core/game';
import { Mode2Game } from '../src/core/mode2';
import { CPU_CONFIG, CpuController, type CpuStats } from '../src/input/cpu';
import { KeyboardController } from '../src/input/controller';

const OUT = new URL('../test-results/cpu-v320/', import.meta.url);
const LEVELS: Difficulty[] = ['easy', 'normal', 'hard'];
const CHARS: Character[] = ['kotaro', 'akane', 'zunko'];
const PAIRS: [Character, Character][] = [
  ['kotaro', 'akane'],
  ['akane', 'zunko'],
  ['zunko', 'kotaro'],
];
const BOARD_SEEDS = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
const DECISION_SEEDS = [1, 2, 3];
const CAP_MS = 180_000;
const TICK_MS = 1000 / 60;

/** 分布の要約（完了例だけ。未完了は count に含めない） */
function summary(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return { n: 0 };
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const q = (p: number) => {
    const i = (n - 1) * p;
    const lo = Math.floor(i);
    return s[lo] + (s[Math.min(n - 1, lo + 1)] - s[lo]) * (i - lo);
  };
  const r = (v: number) => Math.round(v * 100) / 100;
  return { n, mean: r(mean), median: r(q(0.5)), sd: r(sd), min: r(s[0]), max: r(s[n - 1]), p10: r(q(0.1)), p90: r(q(0.9)) };
}

const addStats = (a: Partial<CpuStats>, b: CpuStats) => {
  for (const [k, v] of Object.entries(b)) (a as Record<string, number>)[k] = ((a as Record<string, number>)[k] ?? 0) + v;
  return a;
};

// ---------------------------------------------------------------- MODE2

interface M2Single {
  level: Difficulty;
  character: Character;
  boardSeed: number;
  decisionSeed: number;
  completed: boolean;
  gameSec: number;
  wallMs: number;
  launches: number;
  successes: number;
  fails: number;
  moves: number;
  refreshes: number;
  /** 詰まり検出から場の更新までの合計（ゲーム秒） */
  refreshWaitSec: number;
  stats: CpuStats;
}

function stuckWait(g: Mode2Game): number {
  let sum = 0;
  let from: number | null = null;
  for (const e of g.events) {
    if (e.type === 'stuck') from = e.tick;
    else if (e.type === 'cardRefresh' && from !== null) {
      sum += e.tick - from;
      from = null;
    }
  }
  return (sum * TICK_MS) / 1000;
}

function runMode2Single(level: Difficulty, character: Character, boardSeed: number, decisionSeed: number): M2Single {
  const t0 = performance.now();
  const g = new Mode2Game({ seed: boardSeed, players: 1 });
  const cpu = new CpuController(0, level, decisionSeed, character);
  while (!g.result && !(g.playing && g.elapsedMs() >= CAP_MS)) g.step(cpu.poll(g));
  const ev = g.events;
  return {
    level,
    character,
    boardSeed,
    decisionSeed,
    completed: g.result?.outcome === 'clear',
    gameSec: g.elapsedMs() / 1000,
    wallMs: Math.round((performance.now() - t0) * 10) / 10,
    launches: ev.filter((e) => e.type === 'launch').length,
    successes: ev.filter((e) => e.type === 'arrive' && e.success).length,
    fails: ev.filter((e) => e.type === 'arrive' && !e.success).length,
    moves: ev.filter((e) => e.type === 'move').length,
    refreshes: g.refreshCount,
    refreshWaitSec: stuckWait(g),
    stats: { ...cpu.stats },
  };
}

interface M2Versus {
  level: Difficulty;
  left: Character;
  right: Character;
  boardSeed: number;
  outcome: string | null;
  winner: Character | null;
  /** 勝者（または引分け）の決着時間（ゲーム秒、GOから） */
  decideSec: number | null;
  loserRemaining: number | null;
  refreshes: number;
  refreshWaitSec: number;
  wallMs: number;
}

function runMode2Versus(level: Difficulty, left: Character, right: Character, boardSeed: number): M2Versus {
  const t0 = performance.now();
  const g = new Mode2Game({ seed: boardSeed, players: 2 });
  const cpus = [new CpuController(0, level, boardSeed * 7 + 1, left), new CpuController(1, level, boardSeed * 7 + 2, right)];
  while (!g.result && !(g.playing && (g.tick - g.playStartTick) * g.tickMs >= CAP_MS)) g.step([...cpus[0].poll(g), ...cpus[1].poll(g)]);
  const r = g.result;
  const w = r?.winner ?? null;
  return {
    level,
    left,
    right,
    boardSeed,
    outcome: r?.outcome ?? null,
    winner: w === null ? null : [left, right][w],
    decideSec: r ? ((r.tick - g.playStartTick) * g.tickMs) / 1000 : null,
    loserRemaining: w === null ? null : g.remaining(g.players[1 - w]),
    refreshes: g.refreshCount,
    refreshWaitSec: stuckWait(g),
    wallMs: Math.round((performance.now() - t0) * 10) / 10,
  };
}

// ---------------------------------------------------------------- MODE1

interface M1Row {
  level: Difficulty;
  chars: [Character, Character];
  seed: number;
  decided: boolean;
  gameSec: number;
  winner: Character | null;
  declares: number[];
  declareIntervalSec: (number | null)[];
  attackSent: number[];
  attackCanceled: number[];
  maxRoleChain: number[];
  sixRoles: number[];
  /** ピンチ開始時の手役数ごとの解除・敗北・未決着 */
  pinchByHand: Record<string, { release: number; defeat: number; open: number }>;
  stats: CpuStats[];
  rolls: Record<string, { n: number; hit: number }>;
  wallMs: number;
}

function runMode1(level: Difficulty, chars: [Character, Character], seed: number): M1Row {
  const t0 = performance.now();
  const config = { ...DEFAULT_CONFIG, naturalRiseIntervalMs: NATURAL_RISE_MS[level] };
  const g = new Game({ seed, config });
  const cpus = [new CpuController(0, level, seed * 3, chars[0]), new CpuController(1, level, seed * 5 + 1, chars[1])];
  const LIMIT = 60 * 60 * 5;
  const pinchOpen: (number | null)[] = [null, null];
  const pinchByHand: M1Row['pinchByHand'] = {};
  const slot = (h: number) => (pinchByHand[`hand${h}`] ??= { release: 0, defeat: 0, open: 0 });
  let cursor = 0;
  while (!g.result && g.tick < LIMIT) {
    g.step([...cpus[0].poll(g), ...cpus[1].poll(g)]);
    for (; cursor < g.events.length; cursor++) {
      const e = g.events[cursor];
      if (e.type !== 'pinchWarn') continue;
      if (e.state === 'start') pinchOpen[e.player] = g.players[e.player].roleStock.length;
      else if (e.state === 'end' && pinchOpen[e.player] !== null) {
        slot(pinchOpen[e.player]!)[g.players[e.player].defeated ? 'defeat' : 'release']++;
        pinchOpen[e.player] = null;
      }
    }
  }
  for (const h of pinchOpen) if (h !== null) slot(h).open++;
  const ev = g.events;
  const decl = [0, 1].map((p) => ev.filter((e) => e.type === 'declare' && e.player === p));
  const rolls: M1Row['rolls'] = {};
  for (const c of cpus)
    for (const l of c.log) {
      const r = (rolls[l.kind] ??= { n: 0, hit: 0 });
      r.n++;
      if (l.hit) r.hit++;
    }
  const w = g.result?.winner ?? null;
  return {
    level,
    chars,
    seed,
    decided: !!g.result,
    gameSec: Math.round(((g.result?.tick ?? g.tick) - g.playStartTick) * g.tickMs) / 1000,
    winner: w === null ? null : chars[w],
    declares: decl.map((d) => d.length),
    declareIntervalSec: decl.map((d) => (d.length >= 2 ? Math.round(((d[d.length - 1].tick - d[0].tick) / 60 / (d.length - 1)) * 100) / 100 : null)),
    attackSent: [0, 1].map((p) => ev.reduce((a, e) => a + (e.type === 'attack' && e.player === p ? e.counter.sent : 0), 0)),
    attackCanceled: [0, 1].map((p) => ev.reduce((a, e) => a + (e.type === 'attack' && e.player === p ? e.counter.canceled : 0), 0)),
    maxRoleChain: decl.map((d) => Math.max(0, ...d.map((e) => (e.type === 'declare' ? e.chainCount : 0)))),
    sixRoles: decl.map((d) => d.filter((e) => e.type === 'declare' && e.result.size === 6).length),
    pinchByHand,
    stats: cpus.map((c) => ({ ...c.stats })),
    rolls,
    wallMs: Math.round((performance.now() - t0) * 10) / 10,
  };
}

// ---------------------------------------------------------------- 換算・入力

function stopTickTable() {
  const w = CPU_CONFIG.decisionStopWeights;
  const tot = w[0] + w[1] + w[2];
  const ticks = (ms: number) => Math.max(1, Math.round((ms * 60) / 1000));
  const out: Record<string, unknown> = {};
  for (const lv of LEVELS)
    for (const sit of ['normal', 'pinch'] as const) {
      const ms = sit === 'pinch' ? CPU_CONFIG.decisionStop[lv].pinchMs : CPU_CONFIG.decisionStop[lv].normalMs;
      const cfgMean = (ms[0] * w[0] + ms[1] * w[1] + ms[2] * w[2]) / tot;
      const tk = ms.map(ticks);
      const tickMean = ((tk[0] * w[0] + tk[1] * w[1] + tk[2] * w[2]) / tot) * TICK_MS;
      out[`${lv}.${sit}`] = { ms, ticks: tk, configMeanMs: Math.round(cfgMean * 10) / 10, tickMeanMs: Math.round(tickMean * 10) / 10, diffMs: Math.round((tickMean - cfgMean) * 10) / 10 };
    }
  for (const lv of LEVELS)
    for (const sit of ['normal', 'pinch'] as const)
      for (const c of CHARS) {
        const f = CPU_CONFIG.forget[lv][sit][c];
        if (f.pct > 0) out[`forget.${lv}.${sit}.${c}`] = { ms: f.ms, ticks: ticks(f.ms), tickMs: Math.round(ticks(f.ms) * TICK_MS * 10) / 10 };
      }
  return out;
}

/** 先行入力2tick：移動終了（次に移動できるtick E）の何ms前までの押下なら E に実行されるか（フレームレート別、押下時刻を0.5ms刻みで走査） */
function inputWindow() {
  const out: Record<string, unknown> = {};
  for (const fps of [15, 30, 60, 120, 144]) {
    let executedMax = -1;
    let expiredMin = Infinity;
    const executed: number[] = [];
    for (let lead = 0; lead <= 120; lead += 0.5) {
      let res = 0;
      // フレームの位相もずらして最悪・最良を見る
      for (const phase of [0, 0.25, 0.5, 0.75]) {
        const g = new Game({ seed: 3 });
        while (!g.playing) g.step();
        const kb = new KeyboardController(0);
        const frame = 1000 / fps;
        g.step([{ player: 0, type: 'right' }]);
        const E = g.players[0].charMoveEndTick;
        const driver = new FixedStepDriver({ tickMs: TICK_MS, step: () => g.step(kb.poll()) });
        driver.advance(phase * frame);
        const t0 = phase * frame;
        const pressAt = (E - (g.tick + 1)) * TICK_MS - lead + TICK_MS * 0; // E の tick 開始の lead ms 前（現在時刻 t0 を基準）
        let t = t0;
        let pressed = false;
        const col = g.players[0].selectedCol;
        while (t < t0 + 400) {
          if (!pressed && t + frame > t0 + pressAt) {
            kb.handleKey('KeyD', false);
            pressed = true;
          }
          driver.advance(frame);
          t += frame;
        }
        const moved = g.players[0].selectedCol - col;
        if (moved !== 1 && moved !== 0) throw new Error(`moved ${moved}`);
        res += moved;
      }
      executed.push(res);
      if (res === 4) executedMax = lead;
      if (res === 0) expiredMin = Math.min(expiredMin, lead);
    }
    out[`${fps}fps`] = {
      /** どのフレーム位相でも実行される押下の最大リード（ms） */
      alwaysExecutedUpToMs: executedMax,
      /** どの位相でも期限切れになる最小リード（ms） */
      alwaysExpiredFromMs: expiredMin === Infinity ? null : expiredMin,
    };
  }
  return out;
}

it('v3.2.0 計測', () => {
  mkdirSync(OUT, { recursive: true });
  const tAll = performance.now();

  // MODE2 単独 270
  const singles: M2Single[] = [];
  for (const lv of LEVELS) for (const ch of CHARS) for (const b of BOARD_SEEDS) for (const d of DECISION_SEEDS) singles.push(runMode2Single(lv, ch, b, d));
  const m2Summary: Record<string, unknown> = {};
  const group = (rows: M2Single[]) => {
    const done = rows.filter((r) => r.completed);
    const st = rows.reduce((a, r) => addStats(a, r.stats), {} as Partial<CpuStats>);
    const sum = (f: (r: M2Single) => number) => rows.reduce((a, r) => a + f(r), 0);
    return {
      runs: rows.length,
      completed: done.length,
      incompleteRate: Math.round(((rows.length - done.length) / rows.length) * 1000) / 10,
      /** 完了例だけの分布（未完了は含めない） */
      clearSecCompletedOnly: summary(done.map((r) => r.gameSec)),
      perRunMean: {
        launches: sum((r) => r.launches) / rows.length,
        fails: sum((r) => r.fails) / rows.length,
        moves: sum((r) => r.moves) / rows.length,
        refreshes: sum((r) => r.refreshes) / rows.length,
        refreshWaitSec: Math.round((sum((r) => r.refreshWaitSec) / rows.length) * 100) / 100,
        stopRolls: (st.stopRolls ?? 0) / rows.length,
        stopHits: (st.stopHits ?? 0) / rows.length,
        stopSec: Math.round((((st.stopTicks ?? 0) * TICK_MS) / 1000 / rows.length) * 100) / 100,
        forgetRolls: (st.forgetRolls ?? 0) / rows.length,
        forgetHits: (st.forgetHits ?? 0) / rows.length,
        forgetStops: (st.forgetStops ?? 0) / rows.length,
        forgetSec: Math.round((((st.forgetTicks ?? 0) * TICK_MS) / 1000 / rows.length) * 100) / 100,
      },
      noResetClears: done.filter((r) => r.refreshes === 0).length,
      wallMsTotal: Math.round(sum((r) => r.wallMs)),
    };
  };
  for (const lv of LEVELS) {
    m2Summary[lv] = group(singles.filter((r) => r.level === lv));
    for (const ch of CHARS) m2Summary[`${lv}.${ch}`] = group(singles.filter((r) => r.level === lv && r.character === ch));
  }

  // MODE2 対戦 180
  const versus: M2Versus[] = [];
  for (const lv of LEVELS)
    for (const [a, b] of PAIRS)
      for (const s of BOARD_SEEDS) {
        versus.push(runMode2Versus(lv, a, b, s));
        versus.push(runMode2Versus(lv, b, a, s));
      }
  const vSummary: Record<string, unknown> = {};
  for (const lv of LEVELS) {
    const rows = versus.filter((r) => r.level === lv);
    const wins: Record<string, number> = {};
    for (const r of rows) wins[r.winner ?? (r.outcome ?? 'undecided')] = (wins[r.winner ?? (r.outcome ?? 'undecided')] ?? 0) + 1;
    vSummary[lv] = {
      rounds: rows.length,
      decided: rows.filter((r) => r.outcome === 'win').length,
      draws: rows.filter((r) => r.outcome === 'draw').length,
      undecided: rows.filter((r) => r.outcome === null).length,
      /** 勝者の決着時間（GOから。敗者の完走時間ではない） */
      winnerDecideSec: summary(rows.filter((r) => r.outcome === 'win').map((r) => r.decideSec!)),
      loserRemainingMean: Math.round((rows.filter((r) => r.loserRemaining !== null).reduce((a, r) => a + r.loserRemaining!, 0) / Math.max(1, rows.filter((r) => r.loserRemaining !== null).length)) * 100) / 100,
      leftWins: rows.filter((r) => r.outcome === 'win' && r.winner === r.left).length,
      winsByCharacter: wins,
      refreshesMean: rows.reduce((a, r) => a + r.refreshes, 0) / rows.length,
    };
  }

  // MODE1
  const m1: M1Row[] = [];
  for (const lv of LEVELS) for (const pair of PAIRS) for (let s = 1; s <= 10; s++) m1.push(runMode1(lv, pair, s));
  const m1Summary: Record<string, unknown> = {};
  for (const lv of LEVELS) {
    const rows = m1.filter((r) => r.level === lv);
    const st = rows.reduce((a, r) => addStats(addStats(a, r.stats[0]), r.stats[1]), {} as Partial<CpuStats>);
    const rolls: Record<string, { n: number; hit: number; rate?: number }> = {};
    for (const r of rows)
      for (const [k, v] of Object.entries(r.rolls)) {
        const x = (rolls[k] ??= { n: 0, hit: 0 });
        x.n += v.n;
        x.hit += v.hit;
      }
    for (const v of Object.values(rolls)) v.rate = Math.round((v.hit / v.n) * 1000) / 10;
    const pinch: Record<string, { release: number; defeat: number; open: number }> = {};
    for (const r of rows)
      for (const [h, v] of Object.entries(r.pinchByHand)) {
        const x = (pinch[h] ??= { release: 0, defeat: 0, open: 0 });
        x.release += v.release;
        x.defeat += v.defeat;
        x.open += v.open;
      }
    const flat = (f: (r: M1Row) => (number | null)[]) => rows.flatMap(f).filter((x): x is number => x !== null);
    m1Summary[lv] = {
      matches: rows.length,
      decided: rows.filter((r) => r.decided).length,
      decideSec: summary(rows.filter((r) => r.decided).map((r) => r.gameSec)),
      declaresPerPlayer: summary(flat((r) => r.declares)),
      declareIntervalSec: summary(flat((r) => r.declareIntervalSec)),
      attackSentPerPlayer: summary(flat((r) => r.attackSent)),
      attackCanceledPerPlayer: summary(flat((r) => r.attackCanceled)),
      maxRoleChain: summary(flat((r) => r.maxRoleChain)),
      sixRolesPerPlayer: summary(flat((r) => r.sixRoles)),
      pinchByHand: pinch,
      seventh: { considered: st.seventhConsidered, noMargin: st.seventhNoMargin, executed: st.seventhExecuted, improved: st.seventhImproved, aborted: st.seventhAborted, lost: st.seventhLost, noGain: st.seventhNoGain },
      decisionStop: { rolls: st.stopRolls, hits: st.stopHits, halved: st.stopHalved, sec: Math.round((((st.stopTicks ?? 0) * TICK_MS) / 1000) * 10) / 10 },
      forget: { rolls: st.forgetRolls, hits: st.forgetHits, stops: st.forgetStops, sec: Math.round((((st.forgetTicks ?? 0) * TICK_MS) / 1000) * 10) / 10 },
      rolls,
      wallMsTotal: Math.round(rows.reduce((a, r) => a + r.wallMs, 0)),
    };
  }

  const result = {
    generatedAt: new Date().toISOString(),
    cpuConfigVersion: CPU_CONFIG.version,
    note: 'CPU同士の机上計測（ゲーム内時間は60tick/秒で換算、実行PCの処理時間 wallMs とは別）。人間向けの強さ・難易度の合格を示すものではない',
    mode2Single: m2Summary,
    mode2Versus: vSummary,
    mode1: m1Summary,
    stopTicks: stopTickTable(),
    inputWindow: inputWindow(),
    wallMsTotal: Math.round(performance.now() - tAll),
  };
  writeFileSync(new URL('summary.json', OUT), JSON.stringify(result, null, 1));
  writeFileSync(new URL('mode2_single_runs.json', OUT), JSON.stringify(singles));
  writeFileSync(new URL('mode2_versus_rounds.json', OUT), JSON.stringify(versus));
  writeFileSync(new URL('mode1_matches.json', OUT), JSON.stringify(m1));
});
