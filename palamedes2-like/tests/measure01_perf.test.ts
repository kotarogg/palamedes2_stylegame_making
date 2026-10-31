// V320-MEASURE-01 性能測定（開発用。MEASURE_PERF=1 のときだけ実行）：ゲーム時間20分相当を計測ON／OFFで回し、
// 処理時間・記録件数・サイズ・ヒープを docs/measure01/perf_MEASURE-01.json へ保存する。描画・ブラウザは含まない（ロジック＋記録のみ）。
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Command, Game } from '../src/core/game';
import { Match } from '../src/core/match';
import { createSeededRng } from '../src/core/rng';
import { CpuController } from '../src/input/cpu';
import { profileConfig } from '../src/measure/profile';
import { MeasureRecorder } from '../src/measure/recorder';

const MINUTES = Number(process.env.MEASURE_PERF_MINUTES ?? 20);
const TICKS = MINUTES * 60 * 60;

/** 人の操作の代わり：1P は約3.6操作／秒の乱数入力（押下・反復・離す） */
function human(seed: number) {
  const rng = createSeededRng(seed);
  const acts = ['left', 'right', 'launch', 'rotate', 'declare', 'manualRise'] as const;
  return (): Command[] => {
    const out: Command[] = [];
    if (rng.next() < 0.06) {
      const a = acts[Math.floor(rng.next() * acts.length)];
      out.push({ player: 0, type: a, ...(rng.next() < 0.2 && (a === 'left' || a === 'right') ? { repeat: true } : {}) });
    }
    if (rng.next() < 0.01) out.push({ player: 0, type: 'cancelRepeat' });
    return out;
  };
}

function run(withRec: boolean) {
  let clock = 0;
  const rec = withRec ? new MeasureRecorder(undefined, () => clock) : null;
  rec?.start();
  let seed = 1;
  let matches = 0;
  let rounds = 0;
  const h = human(77);
  let m = new Match({ firstTo: 2, difficulty: 'normal', seed, mode: 'mode1', config: profileConfig('B') });
  let cpu = new CpuController(1, 'normal', seed, 'akane');
  rec?.matchStart({ mode: 'mode1', kind: 'cpu', characters: ['kotaro', 'akane'], devices: [], humans: [0], seed, profile: 'B' });
  const t0 = performance.now();
  for (let i = 0; i < TICKS; i++) {
    clock += 1000 / 60;
    rec?.beginFrame(1000 / 60);
    if (m.state === 'matchResult') {
      matches++;
      seed++;
      m = new Match({ firstTo: 2, difficulty: 'normal', seed, mode: 'mode1', config: profileConfig('B') });
      cpu = new CpuController(1, 'normal', seed, 'akane');
      rec?.matchStart({ mode: 'mode1', kind: 'cpu', characters: ['kotaro', 'akane'], devices: [], humans: [0], seed, profile: 'B' });
    }
    const g = m.game as Game;
    rec?.beforeTick(g);
    const cmds = [...h(), ...cpu.poll(g)];
    if (rec) for (const c of cmds) rec.command(c, c.player === 0 ? 'keyboard' : 'cpu');
    if (rec && m.state !== 'round') for (const c of cmds) rec.dropCommand(c, 'result');
    const before = m.game;
    m.step(cmds, m.state === 'roundResult');
    rec?.afterTick(before as Game);
    if (m.game !== before) rounds++;
  }
  const ms = performance.now() - t0;
  let exportMs = 0;
  let bytes = 0;
  if (rec) {
    rec.stop();
    const e0 = performance.now();
    const parts = rec.exportParts();
    bytes = parts.reduce((a, s) => a + Buffer.byteLength(s), 0);
    exportMs = performance.now() - e0;
  }
  return { ms, perTickUs: (ms * 1000) / TICKS, matches, rounds, records: rec?.count ?? 0, chars: rec?.sizeChars ?? 0, bytes, exportMs, heapMB: process.memoryUsage().heapUsed / 1e6, rec };
}

describe.runIf(process.env.MEASURE_PERF === '1')('性能測定（ゲーム時間20分）', () => {
  it('計測ON／OFF', () => {
    run(false); // 準備運転（JIT）
    const off = run(false);
    global.gc?.();
    const heapBefore = process.memoryUsage().heapUsed / 1e6;
    const on = run(true);
    const heapOn = process.memoryUsage().heapUsed / 1e6;
    const out = {
      id: 'V320-MEASURE-01',
      env: { node: process.version, platform: process.platform, arch: process.arch, cpus: (await_cpus()) },
      gameMinutes: MINUTES,
      ticks: TICKS,
      note: 'ロジック（Match・CPU）＋記録器のみ。描画・音声・ブラウザは含まない。入力は乱数（人の代わり、約3.6操作/秒）',
      off: { ms: Math.round(off.ms), perTickUs: +off.perTickUs.toFixed(1), matches: off.matches, rounds: off.rounds },
      on: { ms: Math.round(on.ms), perTickUs: +on.perTickUs.toFixed(1), matches: on.matches, rounds: on.rounds, records: on.records, chars: on.chars, fileBytes: on.bytes, exportMs: Math.round(on.exportMs), heapDeltaMB: +(heapOn - heapBefore).toFixed(1) },
      overheadPerTickUs: +(on.perTickUs - off.perTickUs).toFixed(1),
      recordsPerMinute: Math.round(on.records / MINUTES),
      bytesPerMinute: Math.round(on.bytes / MINUTES),
      limitRatio: +Math.max(on.records / on.rec!.limits.maxRecords, on.chars / on.rec!.limits.maxChars).toFixed(3),
    };
    writeFileSync(new URL('../docs/measure01/perf_MEASURE-01.json', import.meta.url), JSON.stringify(out, null, 1));
    console.log(JSON.stringify(out));
    expect(on.rounds).toBe(off.rounds);
    expect(on.rec!.limitStopped).toBe(false);
  }, 600_000);
});

function await_cpus(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  try {
    return `${require('node:os').cpus()[0]?.model ?? '?'} x${require('node:os').cpus().length}`;
  } catch {
    return 'unknown';
  }
}
