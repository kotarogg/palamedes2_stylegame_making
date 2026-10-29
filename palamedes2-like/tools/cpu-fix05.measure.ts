// V320-FIX-05 計測（実装依頼書 第8章）：npx vitest run --config tools/vitest.measure.config.ts tools/cpu-fix05.measure.ts
// MODE1 対戦のみ。上限180ゲーム秒（上限到達は未決着として件数を報告し、時間の統計は決着例のみ）。自然上昇は難易度の周期。
// 小規模比較：中級 × 3組 × seed1〜5 を「新ルール＋旧CPU設定（mode1Adjust なし）」「新ルール＋FIX-05 CPU設定」で各15。
// 全体：FIX-05 設定で3難易度 × 3組 × seed1〜10 ＝ 90（中級 seed1〜5 の15件は小規模比較と同一条件のため再利用）。
// CPU同士の机上計測であり、人間向けの難易度の合格を示すものではない。
import { mkdirSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import type { Character } from '../src/audio/audioMap';
import { DEFAULT_CONFIG, NATURAL_RISE_MS, type Difficulty } from '../src/core/config';
import { Game } from '../src/core/game';
import { CPU_CONFIG, CpuController, type CpuConfig } from '../src/input/cpu';

const OUT = new URL('../docs/v320f05/cpu/', import.meta.url);
const PAIRS: [Character, Character][] = [
  ['kotaro', 'akane'],
  ['akane', 'zunko'],
  ['zunko', 'kotaro'],
];
const CAP_MS = 180_000;
const TICK_MS = 1000 / 60;
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

interface Row {
  set: 'oldCpu' | 'fix05';
  level: Difficulty;
  left: Character;
  right: Character;
  seed: number;
  decided: boolean;
  gameSec: number;
  winner: string;
  launchOk: number;
  launchFail: number;
  maxStreak: number;
  streakCutMiss: number;
  streakCutTimeout: number;
  maxChain: number;
  chainBreaks: number;
  /** 宣言間（2連鎖目以降）に消費した役連鎖の猶予（秒）の平均 */
  chainUsedSecMean: number | null;
  attackPower: number;
  canceled: number;
  sent: number;
  pinches: number;
  pinchReleases: number;
  declares: number;
  perceptionRolls: number;
  misreadApplied: number;
  overlookApplied: number;
  misreadChosen: number;
  misreadLaunched: number;
  misreadLaunchFailed: number;
  mandatorySec: number;
}

function runOne(set: Row['set'], level: Difficulty, [a, b]: [Character, Character], seed: number): Row {
  const cfg: CpuConfig = JSON.parse(JSON.stringify(CPU_CONFIG));
  if (set === 'oldCpu') delete cfg.mode1Adjust;
  const g = new Game({ seed, config: { ...DEFAULT_CONFIG, naturalRiseIntervalMs: NATURAL_RISE_MS[level] } });
  const cpus = [new CpuController(0, level, seed * 3, a, cfg), new CpuController(1, level, seed * 5 + 1, b, cfg)];
  const limit = g.playStartTick + Math.round(CAP_MS / TICK_MS);
  const window = g.ticks(g.config.chainWindowMs);
  const prevChain = [0, 0];
  const prevCount = [0, 0];
  let chainBreaks = 0;
  const used: number[] = [];
  let cursor = 0;
  while (!g.result && g.tick < limit) {
    g.step([...cpus[0].poll(g), ...cpus[1].poll(g)]);
    for (; cursor < g.events.length; cursor++) {
      const e = g.events[cursor];
      if (e.type === 'declare' && e.chainCount >= 2) used.push(((window - prevChain[e.player]) * TICK_MS) / 1000);
    }
    for (const p of g.players) {
      if (prevChain[p.id] > 0 && p.chainRemaining === 0 && prevCount[p.id] > 0) chainBreaks++;
      prevChain[p.id] = p.chainRemaining;
      prevCount[p.id] = p.chainCount;
    }
  }
  const ev = g.events;
  const r = g.result;
  const sum = (f: (c: CpuController) => number) => f(cpus[0]) + f(cpus[1]);
  const misIds = new Set([...cpus[0].misreadLaunchIds, ...cpus[1].misreadLaunchIds]);
  return {
    set,
    level,
    left: a,
    right: b,
    seed,
    decided: !!r,
    gameSec: r2((((r?.tick ?? g.tick) - g.playStartTick) * TICK_MS) / 1000),
    winner: !r ? 'undecided' : r.winner === null ? 'draw' : r.winner === 0 ? 'left' : 'right',
    launchOk: ev.filter((e) => e.type === 'arrive' && e.success).length,
    launchFail: ev.filter((e) => e.type === 'arrive' && !e.success).length,
    maxStreak: Math.max(0, ...ev.map((e) => (e.type === 'arrive' ? e.streak : 0))),
    streakCutMiss: ev.filter((e) => e.type === 'streakCut' && e.state === 'ended' && e.reason === 'miss').length,
    streakCutTimeout: ev.filter((e) => e.type === 'streakCut' && e.state === 'ended' && e.reason === 'timeout').length,
    maxChain: Math.max(0, ...ev.map((e) => (e.type === 'declare' ? e.chainCount : 0))),
    chainBreaks,
    chainUsedSecMean: used.length ? r2(used.reduce((x, y) => x + y, 0) / used.length) : null,
    attackPower: ev.reduce((s, e) => s + (e.type === 'attack' ? e.breakdown.power : 0), 0),
    canceled: ev.reduce((s, e) => s + (e.type === 'attack' ? e.counter.canceled : 0), 0),
    sent: ev.reduce((s, e) => s + (e.type === 'attack' ? e.counter.sent : 0), 0),
    pinches: ev.filter((e) => e.type === 'pinchWarn' && e.state === 'start').length,
    pinchReleases: ev.filter((e) => e.type === 'pinchWarn' && e.state === 'end').length - (r && r.winner !== null ? 1 : 0),
    declares: ev.filter((e) => e.type === 'declare').length,
    perceptionRolls: sum((c) => c.stats.perceptionRolls),
    misreadApplied: sum((c) => c.stats.misreadApplied),
    overlookApplied: sum((c) => c.stats.overlookApplied),
    misreadChosen: sum((c) => c.stats.misreadChosen),
    misreadLaunched: sum((c) => c.stats.misreadLaunched),
    misreadLaunchFailed: ev.filter((e) => e.type === 'arrive' && !e.success && misIds.has(e.piece.id)).length,
    mandatorySec: r2(sum((c) => c.stats.mandatoryTicks) * TICK_MS / 1000),
  };
}

function group(rows: Row[]) {
  const done = rows.filter((r) => r.decided);
  const nums = (f: (r: Row) => number | null) => rows.map(f).filter((x): x is number => typeof x === 'number');
  const total = (f: (r: Row) => number) => rows.reduce((s, r) => s + f(r), 0);
  return {
    n: rows.length,
    decided: done.length,
    undecided: rows.length - done.length,
    /** 決着例のみ */
    gameSecDecidedOnly: summary(done.map((r) => r.gameSec)),
    winners: rows.reduce((o, r) => ((o[r.winner] = (o[r.winner] ?? 0) + 1), o), {} as Record<string, number>),
    launchOk: summary(nums((r) => r.launchOk)),
    launchFail: summary(nums((r) => r.launchFail)),
    failRate: r2((100 * total((r) => r.launchFail)) / Math.max(1, total((r) => r.launchOk + r.launchFail))),
    maxStreak: summary(nums((r) => r.maxStreak)),
    streakCutMiss: summary(nums((r) => r.streakCutMiss)),
    streakCutTimeoutTotal: total((r) => r.streakCutTimeout),
    maxChain: summary(nums((r) => r.maxChain)),
    chainBreaks: summary(nums((r) => r.chainBreaks)),
    chainUsedSec: summary(nums((r) => r.chainUsedSecMean)),
    declares: summary(nums((r) => r.declares)),
    attackPower: summary(nums((r) => r.attackPower)),
    canceled: summary(nums((r) => r.canceled)),
    sent: summary(nums((r) => r.sent)),
    pinches: summary(nums((r) => r.pinches)),
    pinchReleases: summary(nums((r) => r.pinchReleases)),
    perception: {
      rolls: total((r) => r.perceptionRolls),
      misreadApplied: total((r) => r.misreadApplied),
      overlookApplied: total((r) => r.overlookApplied),
      misreadChosen: total((r) => r.misreadChosen),
      misreadLaunched: total((r) => r.misreadLaunched),
      misreadLaunchFailed: total((r) => r.misreadLaunchFailed),
    },
    mandatorySec: summary(nums((r) => r.mandatorySec)),
  };
}

it('V320-FIX-05 CPU計測（MODE1）', () => {
  mkdirSync(OUT, { recursive: true });
  const t0 = Date.now();
  const rows: Row[] = [];
  for (const pr of PAIRS) for (let s = 1; s <= 5; s++) rows.push(runOne('oldCpu', 'normal', pr, s));
  for (const lv of ['easy', 'normal', 'hard'] as Difficulty[]) for (const pr of PAIRS) for (let s = 1; s <= 10; s++) rows.push(runOne('fix05', lv, pr, s));
  const out: Record<string, unknown> = {};
  const small = (set: Row['set']) => rows.filter((r) => r.set === set && r.level === 'normal' && r.seed <= 5);
  out['small.normal.oldCpu'] = group(small('oldCpu'));
  out['small.normal.fix05'] = group(small('fix05'));
  for (const lv of ['easy', 'normal', 'hard'] as Difficulty[]) {
    const rs = rows.filter((r) => r.set === 'fix05' && r.level === lv);
    out[`fix05.${lv}`] = group(rs);
    for (const pr of PAIRS) out[`fix05.${lv}.${pr.join('-')}`] = group(rs.filter((r) => r.left === pr[0] && r.right === pr[1]));
  }
  const cols = Object.keys(rows[0]) as (keyof Row)[];
  writeFileSync(new URL('runs.csv', OUT), [cols.join(','), ...rows.map((r) => cols.map((c) => r[c] ?? '').join(','))].join('\n') + '\n');
  writeFileSync(
    new URL('summary.json', OUT),
    JSON.stringify(
      {
        id: 'V320-FIX-05',
        cpu: { version: CPU_CONFIG.version, fix04: (CPU_CONFIG as { adjustment?: string }).adjustment, fix05: CPU_CONFIG.mode1Adjust?.adjustment },
        rules: { streakWindowMs: DEFAULT_CONFIG.streakWindowMs, chainWindowMs: DEFAULT_CONFIG.chainWindowMs },
        capSec: CAP_MS / 1000,
        note: '小規模比較の「新ルール＋FIX-05 設定」15件は全体90件の中級 seed1〜5 と同一条件（重複実行せず再利用）。時間の統計は決着例のみ。誤認の抽選率は打上失敗率ではない（misreadLaunchFailed が誤認候補の実際の失敗数）',
        wallSec: Math.round((Date.now() - t0) / 1000),
        groups: out,
      },
      null,
      1,
    ),
  );
});
