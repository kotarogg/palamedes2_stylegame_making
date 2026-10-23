// v3.1.0 CPU 動作確認（少数の固定seed）：3難易度 × 3キャラ（相手は固定順の次キャラ）× seed 1〜3、自然上昇は難易度と同じ。
// 停止・判断異常（長時間の無操作、不成立宣言）と、決着時間・宣言間隔・ピンチ解除・ミスを記録する。
// CPU同士の結果であり、人間向け難易度の合格を示すものではない。結果は test-results/cpu-v310/ へ。
import { mkdirSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import type { Character } from '../src/audio/audioMap';
import { DEFAULT_CONFIG, NATURAL_RISE_MS, type Difficulty } from '../src/core/config';
import { Game } from '../src/core/game';
import { Mode2Game } from '../src/core/mode2';
import { CpuController } from '../src/input/cpu';

const LEVELS: Difficulty[] = ['easy', 'normal', 'hard'];
const CHARS: Character[] = ['kotaro', 'akane', 'zunko'];
const SEEDS = [1, 2, 3];
const LIMIT = 60 * 60 * 5; // 5分
/** 操作できる状態で、この時間以上どの操作も出さなければ「停止」とみなす */
const IDLE_LIMIT = 60 * 8;

interface Row {
  mode: 'mode1' | 'mode2';
  level: Difficulty;
  chars: [Character, Character];
  seed: number;
  decided: boolean;
  seconds: number;
  outcome: string | null;
  declares: number[];
  declareIntervalSec: (number | null)[];
  sixRoles: number[];
  fails: number[];
  launches: number[];
  misses: number[];
  pinchStarts: number[];
  pinchReleases: number[];
  manualRises: number[];
  longestIdleSec: number[];
  rolls: Record<string, number>;
}

function run(mode: 'mode1' | 'mode2', level: Difficulty, chars: [Character, Character], seed: number): Row {
  const config = { ...DEFAULT_CONFIG, naturalRiseIntervalMs: NATURAL_RISE_MS[level] };
  const g = mode === 'mode1' ? new Game({ seed, config }) : new Mode2Game({ seed });
  const cpus = [new CpuController(0, level, seed * 3, chars[0]), new CpuController(1, level, seed * 5 + 1, chars[1])];
  const idle = [0, 0];
  const longest = [0, 0];
  while (!g.result && g.tick < LIMIT) {
    const cmds = cpus.flatMap((c, i) => {
      const out = c.poll(g);
      const p = g.players[i];
      const free = g.playing && !(g.mode === 'mode1' ? g.isLocked(p as never) || g.isMoving(p as never) : (g as Mode2Game).isLocked(p as never) || (g as Mode2Game).isMoving(p as never));
      idle[i] = out.length || !free ? 0 : idle[i] + 1;
      longest[i] = Math.max(longest[i], idle[i]);
      return out;
    });
    g.step(cmds);
  }
  const ev = g.events as { type: string; player?: number; tick: number; success?: boolean; state?: string; result?: { size: number } }[];
  const per = (f: (e: (typeof ev)[number]) => boolean) => [0, 1].map((p) => ev.filter((e) => e.player === p && f(e)).length);
  const declTicks = [0, 1].map((p) => ev.filter((e) => e.type === 'declare' && e.player === p).map((e) => e.tick));
  const rolls: Record<string, number> = {};
  for (const c of cpus) for (const l of c.log) rolls[`${l.kind}:${l.hit ? 'hit' : 'miss'}`] = (rolls[`${l.kind}:${l.hit ? 'hit' : 'miss'}`] ?? 0) + 1;
  return {
    mode,
    level,
    chars,
    seed,
    decided: !!g.result,
    seconds: (g.result?.tick ?? g.tick) / 60,
    outcome: g.result?.outcome ?? null,
    declares: declTicks.map((d) => d.length),
    declareIntervalSec: declTicks.map((d) => (d.length >= 2 ? (d[d.length - 1] - d[0]) / 60 / (d.length - 1) : null)),
    sixRoles: per((e) => e.type === 'declare' && e.result?.size === 6),
    fails: per((e) => e.type === 'declareFail'),
    launches: per((e) => e.type === 'launch'),
    misses: per((e) => e.type === 'arrive' && e.success === false),
    pinchStarts: per((e) => e.type === 'pinchWarn' && e.state === 'start'),
    pinchReleases: per((e) => e.type === 'pinchWarn' && e.state === 'end'),
    manualRises: per((e) => e.type === 'rise' && (e as { kind?: string }).kind === 'manual'),
    longestIdleSec: longest.map((t) => t / 60),
    rolls,
  };
}

it('v3.1.0 CPU 動作確認（3難易度×3キャラ×seed1〜3、MODE1・MODE2）', () => {
  const rows: Row[] = [];
  for (const mode of ['mode1', 'mode2'] as const)
    for (const level of LEVELS)
      for (const me of CHARS) {
        const opp = CHARS.filter((c) => c !== me)[0];
        for (const seed of SEEDS) rows.push(run(mode, level, [me, opp], seed));
      }
  const dir = new URL('../test-results/cpu-v310/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL('cpu_v310.json', dir), JSON.stringify({ date: new Date().toISOString(), limitTicks: LIMIT, idleLimitTicks: IDLE_LIMIT, rows }, null, 1));
  const bad = rows.filter((r) => r.fails.some((x) => x > 0) || r.longestIdleSec.some((s) => s * 60 >= IDLE_LIMIT));
  console.log(`rows=${rows.length} anomalies=${bad.length}`);
  for (const r of rows) console.log(`${r.mode} ${r.level} ${r.chars.join('-')} s${r.seed}: ${r.decided ? r.outcome : '未決着'} ${r.seconds.toFixed(1)}s decl=${r.declares} six=${r.sixRoles} itv=${r.declareIntervalSec.map((x) => (x === null ? '-' : x.toFixed(1)))} miss=${r.misses}/${r.launches} pinch=${r.pinchStarts}/${r.pinchReleases} rise=${r.manualRises} idle=${r.longestIdleSec.map((x) => x.toFixed(1))} fail=${r.fails}`);
});
