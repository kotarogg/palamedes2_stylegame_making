// V320-FIX-06 計測（実装依頼書 第10.2・10.3節、第7.3節の表示時間記録）：
//   npx vitest run --config tools/vitest.measure.config.ts tools/cpu-fix06.measure.ts
// MODE1：各難易度 × 同難易度の3組（コタロー対アカネ／アカネ対ずん子／ずん子対コタロー）× seed1〜5 ＝45ラウンド。1ラウンド180ゲーム秒上限。
// MODE2：各難易度 × 各キャラクター × seed1〜5 のシングル ＝45回（同じ seed は同じ初期盤面・場。識別情報を記録）。測定用の必勝処理なし。
// 遊び方：全説明項目の開始・実演完了・最低表示時間・次項目への移行（ms）とパネルごとの表示時間。
// CPU同士の机上計測であり、人間の勝率・遊びやすさを示すものではない。
import { mkdirSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import type { Character } from '../src/audio/audioMap';
import { AudioBus } from '../src/audio/audioBus';
import { DEFAULT_CONFIG, NATURAL_RISE_MS, type Difficulty } from '../src/core/config';
import { Game } from '../src/core/game';
import { measureRound, RoundRecorder } from '../src/core/metrics';
import { Mode2Game } from '../src/core/mode2';
import { pieceLabel } from '../src/core/pieces';
import { countTextChars, LESSON_BASIC, LESSON_CRACK, LESSON_M1_SINGLE, LESSON_M1_VERSUS, LESSON_PINCH, pageText, rolesLesson, type ItemRecord, type LessonDef } from '../src/demo/lesson';
import { LessonStage, Mode2Stage, roleDisplayName, type PacedStage } from '../src/demo/stages';
import { CPU_CONFIG, CpuController } from '../src/input/cpu';
import { fakeAssets } from '../tests/helpers';

void measureRound;
const OUT = new URL('../docs/v320f06/measure/', import.meta.url);
const LEVELS: Difficulty[] = ['easy', 'normal', 'hard'];
const PAIRS: [Character, Character][] = [
  ['kotaro', 'akane'],
  ['akane', 'zunko'],
  ['zunko', 'kotaro'],
];
const CHARS: Character[] = ['kotaro', 'akane', 'zunko'];
const SEEDS = [1, 2, 3, 4, 5];
const CAP_MS = 180_000;
const M2_CAP_MS = 600_000;
const TICK_MS = 1000 / 60;
const r2 = (v: number) => Math.round(v * 100) / 100;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function summary(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return { n: 0 };
  const q = (p: number) => {
    const i = (n - 1) * p;
    const lo = Math.floor(i);
    return s[lo] + (s[Math.min(n - 1, lo + 1)] - s[lo]) * (i - lo);
  };
  const m = s.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - m) ** 2, 0) / n);
  return { n, mean: r2(m), median: r2(q(0.5)), sd: r2(sd), min: r2(s[0]), max: r2(s[n - 1]) };
}

const csv = (rows: Record<string, unknown>[]) => {
  const keys = Object.keys(rows[0]);
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [keys.join(','), ...rows.map((r) => keys.map((k) => cell(r[k])).join(','))].join('\n') + '\n';
};

/** CPU の実移動・打上の間隔（speedLog）：連続する移動開始の間隔、最終移動完了→打上、打上→打上 */
function speedStats(cpus: CpuController[]) {
  const moveGaps: number[] = [];
  const afterMove: number[] = [];
  const launchGaps: number[] = [];
  for (const c of cpus) {
    const log = c.speedLog;
    let lastMove: (typeof log)[number] | null = null;
    let lastLaunch: (typeof log)[number] | null = null;
    let movedSinceLaunch = false;
    for (const x of log) {
      if (x.kind === 'move') {
        if (lastMove && movedSinceLaunch) moveGaps.push(x.tick - lastMove.tick);
        lastMove = x;
        movedSinceLaunch = true;
      } else {
        if (movedSinceLaunch) afterMove.push(x.tick - x.moveEndTick);
        if (lastLaunch) launchGaps.push(x.tick - lastLaunch.tick);
        lastLaunch = x;
        movedSinceLaunch = false;
      }
    }
  }
  return {
    moveGapMinTick: moveGaps.length ? Math.min(...moveGaps) : null,
    moveGapMeanTick: mean(moveGaps) === null ? null : r2(mean(moveGaps)!),
    afterMoveMinTick: afterMove.length ? Math.min(...afterMove) : null,
    afterMoveMeanTick: mean(afterMove) === null ? null : r2(mean(afterMove)!),
    launchGapMeanMs: mean(launchGaps) === null ? null : r2(mean(launchGaps)! * TICK_MS),
    moves: cpus.reduce((s, c) => s + c.speedLog.filter((x) => x.kind === 'move').length, 0),
    launches: cpus.reduce((s, c) => s + c.speedLog.filter((x) => x.kind === 'launch').length, 0),
  };
}

// ---------------------------------------------------------------- MODE1（45ラウンド）

function mode1(level: Difficulty, [a, b]: [Character, Character], seed: number) {
  const g = new Game({ seed, config: { ...DEFAULT_CONFIG, naturalRiseIntervalMs: NATURAL_RISE_MS[level] } });
  const cpus = [new CpuController(0, level, seed * 3, a), new CpuController(1, level, seed * 5 + 1, b)];
  const rec = new RoundRecorder(g);
  const limit = g.playStartTick + Math.round(CAP_MS / TICK_MS);
  while (!g.result && g.tick < limit) {
    g.step([...cpus[0].poll(g), ...cpus[1].poll(g)]);
    rec.sample();
  }
  const m = rec.finish();
  const ev = g.events;
  const r = g.result;
  const roles: Record<string, number> = {};
  for (const e of ev) if (e.type === 'declare') roles[roleDisplayName(e.logos)] = (roles[roleDisplayName(e.logos)] ?? 0) + 1;
  const sum = <T extends (typeof ev)[number]['type']>(type: T, f: (e: Extract<(typeof ev)[number], { type: T }>) => number) =>
    ev.reduce((s, e) => s + (e.type === type ? f(e as Extract<(typeof ev)[number], { type: T }>) : 0), 0);
  const sp = speedStats(cpus);
  return {
    level,
    left: a,
    right: b,
    seed,
    decided: !!r,
    gameSec: r2((((r?.tick ?? g.tick) - g.playStartTick) * TICK_MS) / 1000),
    winner: !r ? 'undecided' : r.winner === null ? 'draw' : r.winner === 0 ? `left(${a})` : `right(${b})`,
    cause: !r ? 'undecided' : m.causes.join('+'),
    declares: ev.filter((e) => e.type === 'declare').length,
    declareIntervalSecMean: r2(mean(m.players.map((p) => p.declareIntervalSec).filter((x): x is number => x !== null)) ?? 0),
    roles,
    maxStreak: Math.max(0, ...ev.map((e) => (e.type === 'arrive' ? e.streak : 0))),
    maxChain: Math.max(0, ...ev.map((e) => (e.type === 'declare' ? e.chainCount : 0))),
    baseAttack: sum('attack', (e) => e.breakdown.base),
    streakBonus: sum('attack', (e) => e.breakdown.streakBonus),
    chainBonus: sum('attack', (e) => e.breakdown.chainBonus),
    power: sum('attack', (e) => e.breakdown.power),
    canceled: sum('attack', (e) => e.counter.canceled),
    sent: sum('attack', (e) => e.counter.sent),
    applied: g.players.reduce((s, p) => s + p.incoming.stats.applied, 0),
    overflow: g.players.reduce((s, p) => s + p.incoming.stats.overflow, 0),
    pinchDiscarded: g.players.reduce((s, p) => s + p.incoming.stats.pinchDiscarded, 0),
    pinches: ev.filter((e) => e.type === 'pinchWarn' && e.state === 'start').length,
    recoveries: ev.filter((e) => (e.type === 'danger' || e.type === 'attackPinch') && e.state === 'release').length,
    launchOk: ev.filter((e) => e.type === 'arrive' && e.success).length,
    launchFail: ev.filter((e) => e.type === 'arrive' && !e.success).length,
    ...sp,
  };
}

// ---------------------------------------------------------------- MODE2（45回）

function mode2(level: Difficulty, ch: Character, seed: number) {
  const g = new Mode2Game({ seed, players: 1 });
  const initial = `${pieceLabel(g.base)}|${g.players[0].board.cols.map((c) => c.map((s) => (s.kind === 'piece' ? pieceLabel(s.piece) : '?')).join('')).join('/')}`;
  let h = 0;
  for (const c of initial) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const cpu = new CpuController(0, level, seed * 11 + 7, ch);
  while (!g.playing) g.step();
  const limit = g.playStartTick + Math.round(M2_CAP_MS / TICK_MS);
  while (!g.result && g.tick < limit) g.step(cpu.poll(g as never) as never);
  const sp = speedStats([cpu]);
  return {
    level,
    character: ch,
    seed,
    initialId: `seed${seed}#${h.toString(16)}`,
    cleared: g.result?.outcome === 'clear',
    clearSec: g.result ? r2(g.elapsedMs() / 1000) : null,
    remaining: g.remaining(g.players[0]),
    refreshes: g.refreshCount,
    launchOk: g.events.filter((e) => e.type === 'arrive' && e.success).length,
    launchFail: g.events.filter((e) => e.type === 'arrive' && !e.success).length,
    ...sp,
  };
}

// ---------------------------------------------------------------- 遊び方（全説明項目）

const host = () => ({ assets: fakeAssets(), bus: new AudioBus('./') });

function itemRows(where: string, items: ItemRecord[]) {
  return items.map((x, i) => {
    const panels = pageText(x.page).panels;
    const end = x.endTick ?? x.startTick;
    const panelMs = x.panelTicks.map((t, k) => r2(((k + 1 < x.panelTicks.length ? x.panelTicks[k + 1] : end) - t) * TICK_MS));
    const panelChars = panels.map((l) => countTextChars(l.join('')));
    // 文章ごとの表示時間が、その文章だけに初期式（1秒＋文字数÷8秒）を当てた値より短いもの
    const short = panelMs.map((ms, k) => (panelMs.length > 1 && ms < 1000 + (panelChars[k] / 8) * 1000 ? `panel${k + 1}:${ms}ms<${1000 + panelChars[k] * 125}ms` : null)).filter(Boolean);
    return {
      where,
      order: i + 1,
      page: x.page,
      chars: countTextChars(pageText(x.page).text),
      startMs: r2(x.startTick * TICK_MS),
      doneMs: x.doneTick === null ? null : r2(x.doneTick * TICK_MS),
      demoMs: x.doneTick === null ? null : r2((x.doneTick - x.startTick) * TICK_MS),
      minMs: r2(x.minTicks * TICK_MS),
      minTicks: x.minTicks,
      nextMs: x.endTick === null ? null : r2(x.endTick * TICK_MS),
      shownMs: r2((end - x.startTick) * TICK_MS),
      heldMs: x.doneTick === null ? null : r2((end - x.doneTick) * TICK_MS),
      panelMs: panelMs.join('/'),
      shortPanels: short.join(' '),
    };
  });
}

function runStage(make: () => PacedStage, maxMs = 300_000) {
  const st = make();
  for (let t = 0; t < maxMs && !st.finished; t += TICK_MS) st.update(TICK_MS);
  return st;
}

it('V320-FIX-06 計測', () => {
  mkdirSync(OUT, { recursive: true });
  const meta = {
    id: 'V320-FIX-06',
    cpuVersion: CPU_CONFIG.version,
    speed: CPU_CONFIG.speed,
    mode1Adjust: CPU_CONFIG.mode1Adjust?.adjustment,
    capSec: CAP_MS / 1000,
    note: 'CPU同士の机上計測。人間の勝率・遊びやすさを示すものではない',
  };

  const m1 = LEVELS.flatMap((lv) => PAIRS.flatMap((pr) => SEEDS.map((s) => mode1(lv, pr, s))));
  writeFileSync(new URL('mode1_rounds.csv', OUT), csv(m1));
  const m1sum = Object.fromEntries(
    LEVELS.map((lv) => {
      const rows = m1.filter((r) => r.level === lv);
      const done = rows.filter((r) => r.decided);
      const nums = (f: (r: (typeof rows)[number]) => number) => summary(rows.map(f));
      const roles: Record<string, number> = {};
      for (const r of rows) for (const [k, v] of Object.entries(r.roles)) roles[k] = (roles[k] ?? 0) + v;
      const tot = (f: (r: (typeof rows)[number]) => number) => rows.reduce((s, r) => s + f(r), 0);
      return [
        lv,
        {
          n: rows.length,
          decided: done.length,
          undecided: rows.length - done.length,
          gameSecDecidedOnly: summary(done.map((r) => r.gameSec)),
          causes: rows.reduce((o, r) => ((o[r.cause] = (o[r.cause] ?? 0) + 1), o), {} as Record<string, number>),
          winners: rows.reduce((o, r) => ((o[r.winner] = (o[r.winner] ?? 0) + 1), o), {} as Record<string, number>),
          declares: nums((r) => r.declares),
          declareIntervalSec: summary(rows.map((r) => r.declareIntervalSecMean).filter((x) => x > 0)),
          roles: Object.fromEntries(Object.entries(roles).sort((x, y) => y[1] - x[1])),
          maxStreak: nums((r) => r.maxStreak),
          maxChain: nums((r) => r.maxChain),
          totals: { baseAttack: tot((r) => r.baseAttack), streakBonus: tot((r) => r.streakBonus), chainBonus: tot((r) => r.chainBonus), power: tot((r) => r.power), canceled: tot((r) => r.canceled), sent: tot((r) => r.sent), applied: tot((r) => r.applied), overflow: tot((r) => r.overflow), pinchDiscarded: tot((r) => r.pinchDiscarded) },
          perRound: { power: nums((r) => r.power), canceled: nums((r) => r.canceled), sent: nums((r) => r.sent), applied: nums((r) => r.applied) },
          pinches: nums((r) => r.pinches),
          recoveries: nums((r) => r.recoveries),
          speed: { moveGapMinTick: Math.min(...rows.map((r) => r.moveGapMinTick ?? 999)), afterMoveMinTick: Math.min(...rows.map((r) => r.afterMoveMinTick ?? 999)), moveGapMeanTick: summary(rows.map((r) => r.moveGapMeanTick ?? 0)), launchGapMeanMs: summary(rows.map((r) => r.launchGapMeanMs ?? 0)) },
        },
      ];
    }),
  );

  const m2 = LEVELS.flatMap((lv) => CHARS.flatMap((ch) => SEEDS.map((s) => mode2(lv, ch, s))));
  writeFileSync(new URL('mode2_runs.csv', OUT), csv(m2));
  const m2sum = Object.fromEntries(
    LEVELS.map((lv) => {
      const rows = m2.filter((r) => r.level === lv);
      const done = rows.filter((r) => r.cleared);
      return [
        lv,
        {
          n: rows.length,
          cleared: done.length,
          notCleared: rows.length - done.length,
          clearSec: summary(done.map((r) => r.clearSec!)),
          byCharacter: Object.fromEntries(CHARS.map((ch) => [ch, summary(done.filter((r) => r.character === ch).map((r) => r.clearSec!))])),
          refreshes: summary(rows.map((r) => r.refreshes)),
          moveGapMinTick: Math.min(...rows.map((r) => r.moveGapMinTick ?? 999)),
          afterMoveMinTick: Math.min(...rows.map((r) => r.afterMoveMinTick ?? 999)),
          moveGapMeanTick: summary(rows.map((r) => r.moveGapMeanTick ?? 0)),
          afterMoveMeanTick: summary(rows.map((r) => r.afterMoveMeanTick ?? 0)),
          launchGapMeanMs: summary(rows.map((r) => r.launchGapMeanMs ?? 0)),
        },
      ];
    }),
  );

  // 遊び方：目次の各項目（基本操作／連鎖説明／MODE1／MODE2）。放置デモの説明章（基本操作・役・ピンチ）は同じ教材定義
  const lessons: [string, LessonDef][] = [
    ['help:basic / demo:basic', LESSON_BASIC],
    ['help:streak#1 / demo:roles', rolesLesson('all')],
    ['help:streak#2', LESSON_CRACK],
    ['help:mode1#1', LESSON_M1_SINGLE],
    ['help:mode1#2', LESSON_M1_VERSUS],
    ['help:mode1#3 / demo:pinch', LESSON_PINCH],
  ];
  const help = lessons.flatMap(([where, def]) => {
    const st = runStage(() => new LessonStage(host(), def));
    if (!st.finished) throw new Error(`${where} not finished`);
    return itemRows(where, st.items.log);
  });
  const m2st = runStage(() => new Mode2Stage(host()));
  if (!m2st.finished) throw new Error('mode2 lesson not finished');
  help.push(...itemRows('help:mode2', m2st.items.log));
  writeFileSync(new URL('help_items.csv', OUT), csv(help));

  writeFileSync(new URL('summary.json', OUT), JSON.stringify({ meta, mode1: m1sum, mode2: m2sum, helpShortPanels: help.filter((h) => h.shortPanels).map((h) => `${h.where} ${h.page}: ${h.shortPanels}`) }, null, 1));
  console.log(JSON.stringify({ mode1: Object.fromEntries(Object.entries(m1sum).map(([k, v]) => [k, { decided: v.decided, undecided: v.undecided, sec: v.gameSecDecidedOnly, causes: v.causes }])), mode2: Object.fromEntries(Object.entries(m2sum).map(([k, v]) => [k, { cleared: v.cleared, sec: v.clearSec }])) }, null, 1));
});
