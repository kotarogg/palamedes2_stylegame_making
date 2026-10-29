// V320-FIX-04 第7章：初級CPUの必須判断待ち（MODE1・MODE2）。中級・上級は変更なし
import { describe, expect, it } from 'vitest';
import type { Game } from '../src/core/game';
import { Mode2Game } from '../src/core/mode2';
import { CPU_CONFIG, CpuController, type CpuConfig } from '../src/input/cpu';
import { EMPTY, makeGame, toPlay } from './helpers';

const clone = (): CpuConfig => JSON.parse(JSON.stringify(CPU_CONFIG));

function play(g: Game | Mode2Game, cpu: CpuController, ticks: number) {
  const cmds: { tick: number; type: string }[] = [];
  for (let i = 0; i < ticks && !g.result; i++) {
    const out = cpu.poll(g);
    for (const c of out) cmds.push({ tick: g.tick + 1, type: c.type });
    g.step(out);
  }
  return cmds;
}

describe('V320-FIX-04 初級の必須判断待ち', () => {
  it('設定：初級だけ 300/400/500ms（重み25/50/25）、ピンチ 150/200/250ms。調整識別子を記録。既存の追加停止は維持', () => {
    expect(CPU_CONFIG.adjustment).toBe('V320-FIX-04_easy_mandatory_wait');
    expect(CPU_CONFIG.mandatoryWait).toEqual({ easy: { normalMs: [300, 400, 500], pinchMs: [150, 200, 250] } });
    expect(CPU_CONFIG.mandatoryWaitWeights).toEqual([25, 50, 25]);
    expect(CPU_CONFIG.decisionStop.easy).toEqual({ pct: { kotaro: 45, akane: 50, zunko: 55 }, normalMs: [700, 1000, 1300], pinchMs: [350, 500, 650] });
  });

  it('判断の機会につき1回（操作の間に最大1回）・最初の操作の前にも適用。追加停止の抽選と同じ回数', () => {
    for (const ch of ['kotaro', 'akane', 'zunko'] as const) {
      const g = makeGame({}, undefined, 11);
      toPlay(g);
      const cpu = new CpuController(0, 'easy', 3, ch);
      const cmds = play(g, cpu, 3000);
      const acts = cmds.filter((c) => c.type !== 'left' && c.type !== 'right').map((c) => c.tick);
      expect(acts.length).toBeGreaterThan(5);
      let prev = -1;
      for (const t of acts) {
        expect(cpu.log.filter((l) => l.kind === 'mandatoryWait' && l.tick > prev && l.tick <= t).length, `${ch} ${prev}..${t}`).toBeLessThanOrEqual(1);
        prev = t;
      }
      const first = cpu.log.find((l) => l.kind === 'mandatoryWait')!;
      expect(first.tick).toBe(g.playStartTick + 1); // 入力受付の最初の判断
      // 最初の操作（移動を含む）は必須待ちの後
      expect(cmds[0].tick - first.tick).toBeGreaterThanOrEqual(g.ticks(300));
      expect(cpu.stats.mandatoryCount).toBe(cpu.stats.stopRolls);
      // 移動1列ごとには抽選しない
      expect(cpu.stats.mandatoryCount).toBeLessThan(cmds.length);
    }
  });

  it('時間候補は 300/400/500（通常）・150/200/250（ピンチ）。抽選の比率はおおむね 25/50/25', () => {
    const count: Record<string, number> = {};
    for (let seed = 1; seed <= 12; seed++) {
      const g = makeGame({}, undefined, seed);
      toPlay(g);
      const cpu = new CpuController(0, 'easy', seed, 'akane');
      play(g, cpu, 2400);
      for (const l of cpu.log.filter((x) => x.kind === 'mandatoryWait')) {
        expect(['normal 300ms', 'normal 400ms', 'normal 500ms', 'pinch 150ms', 'pinch 200ms', 'pinch 250ms']).toContain(l.detail);
        const k = l.detail!.split(' ')[1];
        count[k] = (count[k] ?? 0) + 1;
      }
    }
    const n = Object.values(count).reduce((a, b) => a + b, 0);
    expect(n).toBeGreaterThan(150);
    const share = (a: string, b: string) => ((count[a] ?? 0) + (count[b] ?? 0)) / n;
    expect(share('300ms', '150ms')).toBeGreaterThan(0.17);
    expect(share('300ms', '150ms')).toBeLessThan(0.33);
    expect(share('400ms', '200ms')).toBeGreaterThan(0.4);
    expect(share('400ms', '200ms')).toBeLessThan(0.6);
  });

  it('順序：必須待ち→追加停止→計画実行。通常待機中のピンチ移行で、未消化の必須待ちと追加停止をそれぞれ1回だけ半分', () => {
    const cfg = clone();
    cfg.decisionStop.easy.pct.kotaro = 100;
    cfg.decisionStopWeights = [0, 100, 0]; // 追加停止 1000ms＝60tick
    cfg.mandatoryWaitWeights = [0, 100, 0]; // 必須待ち 400ms＝24tick
    const g = makeGame({ base: '1s', boards: { 0: { 0: ['2s'], 1: ['3d'], 2: ['3d'], 3: ['3d'], 4: ['3d'], 5: ['3d'] }, 1: EMPTY } });
    toPlay(g);
    const cpu = new CpuController(0, 'easy', 1, 'kotaro', cfg);
    expect(cpu.poll(g)).toEqual([]);
    const start = g.tick + 1;
    expect([cpu.stats.mandatoryTicks, cpu.stats.stopTicks]).toEqual([24, 60]);
    expect(cpu.log.slice(0, 2).map((l) => l.kind)).toEqual(['mandatoryWait', 'decisionStop']);
    for (let i = 0; i < 10; i++) g.step(cpu.poll(g));
    // 必須待ちの残り14・追加停止60 → 7・30
    g.players[0].incoming.pinchRemaining = 240;
    expect(cpu.poll(g)).toEqual([]);
    expect([cpu.stats.mandatoryHalved, cpu.stats.stopHalved]).toEqual([1, 1]);
    expect([cpu.stats.mandatoryTicks, cpu.stats.stopTicks]).toEqual([17, 30]);
    let first = -1;
    for (let i = 0; i < 90 && first < 0; i++) {
      g.players[0].incoming.pinchRemaining = 240;
      const out = cpu.poll(g);
      if (out.length) first = g.tick + 1;
      g.step(out);
    }
    expect(first - start).toBe(10 + 7 + 30);
    expect([cpu.stats.mandatoryHalved, cpu.stats.stopHalved]).toEqual([1, 1]);
    expect(cpu.log.filter((l) => l.kind === 'mandatoryWait')).toHaveLength(1);
  });

  // V320-FIX-05 で更新：MODE1 の中級・上級には FIX-05 の必須待ち（mode1Adjust）が入るため、FIX-04 の表（初級だけ）の検証は mode1Adjust を外して行う
  it('FIX-04 の必須待ち表は初級だけ（中級・上級の操作列は FIX-04 の表の有無で変わらない。FIX-05 の MODE1 調整は除外して比較）', () => {
    for (const level of ['normal', 'hard'] as const) {
      const run = (cfg: CpuConfig) => {
        const g = makeGame({}, undefined, 21);
        toPlay(g);
        const cpu = new CpuController(0, level, 4, 'zunko', cfg);
        return { cmds: play(g, cpu, 2400), cpu };
      };
      const base = clone();
      delete base.mode1Adjust;
      const without = clone();
      delete without.mode1Adjust;
      delete without.mandatoryWait;
      const a = run(base);
      expect(a.cpu.stats.mandatoryCount).toBe(0);
      expect(a.cmds).toEqual(run(without).cmds);
    }
  });

  it('MODE2 の初級にも通常の表で適用。新ラウンド（別ゲーム）で待ちを持ち越さない', () => {
    const g = new Mode2Game({ seed: 3, players: 1 });
    while (!g.playing) g.step();
    const cpu = new CpuController(0, 'easy', 2, 'kotaro');
    play(g, cpu, 1200);
    const m = cpu.log.filter((l) => l.kind === 'mandatoryWait');
    expect(m.length).toBeGreaterThan(3);
    expect(m.every((l) => l.detail!.startsWith('normal'))).toBe(true);
    const h = new Mode2Game({ seed: 4, players: 1 });
    while (!h.playing) h.step();
    cpu.poll(h);
    expect(cpu.log.at(-2)!.tick).toBe(h.playStartTick + 1);
  });
});
