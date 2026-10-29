// V320-FIX-05 第4章：MODE1 CPU の認識誤り（誤認・見落とし）・探索深さの上限・中級／上級の必須判断待ち。
// 初級・MODE2 は FIX-04-R1 の動作のまま（0% では乱数を消費しない）
import { describe, expect, it } from 'vitest';
import type { Game } from '../src/core/game';
import { Mode2Game } from '../src/core/mode2';
import { CPU_CONFIG, CpuController, type CpuConfig } from '../src/input/cpu';
import { EMPTY, makeGame, toPlay } from './helpers';

const clone = (): CpuConfig => JSON.parse(JSON.stringify(CPU_CONFIG));
const without = (): CpuConfig => {
  const c = clone();
  delete c.mode1Adjust;
  return c;
};

function play(g: Game | Mode2Game, cpu: CpuController, ticks: number) {
  const cmds: string[] = [];
  for (let i = 0; i < ticks && !g.result; i++) {
    const out = cpu.poll(g);
    for (const c of out) cmds.push(`${g.tick + 1}:${c.type}`);
    g.step(out);
  }
  return cmds;
}

/** 判断停止・失念・必須待ちを0にした設定（認識の検証用） */
function quiet(cfg: CpuConfig): CpuConfig {
  for (const lv of ['easy', 'normal', 'hard'] as const) {
    for (const ch of ['kotaro', 'akane', 'zunko'] as const) {
      cfg.decisionStop[lv].pct[ch] = 0;
      for (const sit of ['normal', 'pinch'] as const) cfg.forget[lv][sit][ch] = { pct: 0, ms: 0 };
      cfg.manualRise[lv].rows0[ch] = 0;
      cfg.manualRise[lv].rows1[ch] = 0;
      cfg.manualRise[lv].rows2[ch] = 0;
    }
  }
  cfg.mandatoryWait = {};
  cfg.mode1Adjust!.mandatoryWait = {};
  return cfg;
}

describe('V320-FIX-05 設定（PM指定の初期実装値）', () => {
  it('誤認・見落とし（コタロー/アカネ/ずん子）・必須待ち・探索深さ。調整識別子を記録', () => {
    const a = CPU_CONFIG.mode1Adjust!;
    expect(a.adjustment).toBe('V320-FIX-05_mode1_perception');
    expect(a.misread.easy).toEqual({ normal: { kotaro: 0, akane: 0, zunko: 0 }, pinch: { kotaro: 0, akane: 0, zunko: 0 } });
    expect(a.misread.normal).toEqual({ normal: { kotaro: 12, akane: 16, zunko: 12 }, pinch: { kotaro: 6, akane: 8, zunko: 6 } });
    expect(a.misread.hard).toEqual({ normal: { kotaro: 8, akane: 12, zunko: 8 }, pinch: { kotaro: 0, akane: 0, zunko: 0 } });
    expect(a.overlook.normal).toEqual({ normal: { kotaro: 16, akane: 12, zunko: 12 }, pinch: { kotaro: 6, akane: 6, zunko: 8 } });
    expect(a.overlook.hard).toEqual({ normal: { kotaro: 8, akane: 8, zunko: 12 }, pinch: { kotaro: 0, akane: 0, zunko: 0 } });
    expect(a.mandatoryWait).toEqual({ normal: { normalMs: [120, 180, 240], pinchMs: [60, 90, 120] }, hard: { normalMs: [60, 100, 140], pinchMs: [30, 50, 70] } });
    expect(a.searchDepth).toEqual({ easy: { normal: null, pinch: null }, normal: { normal: 2, pinch: 2 }, hard: { normal: 3, pinch: 4 } });
    // 既存の値は維持
    expect(CPU_CONFIG.mandatoryWait).toEqual({ easy: { normalMs: [300, 400, 500], pinchMs: [150, 200, 250] } });
    expect([CPU_CONFIG.decisionStop.easy.normalMs[1], CPU_CONFIG.decisionStop.normal.normalMs[1], CPU_CONFIG.decisionStop.hard.normalMs[1]]).toEqual([1000, 660, 220]);
  });
});

describe('V320-FIX-05 初級・MODE2 は変わらない（0%では乱数を消費しない）', () => {
  it('MODE1 初級：FIX-05 の調整の有無で操作列が完全に一致（3キャラ×2seed）', () => {
    for (const ch of ['kotaro', 'akane', 'zunko'] as const)
      for (const seed of [3, 11]) {
        const run = (cfg: CpuConfig) => {
          const g = makeGame({}, undefined, seed);
          toPlay(g);
          const cpu = new CpuController(0, 'easy', seed, ch, cfg);
          return { cmds: play(g, cpu, 3000), cpu };
        };
        const a = run(CPU_CONFIG);
        expect(a.cpu.stats.perceptionRolls).toBe(0);
        expect(a.cmds).toEqual(run(without()).cmds);
      }
  });

  it('MODE2 の中級・上級：FIX-05 の調整の有無で操作列が完全に一致（認識誤り・必須待ちは MODE1 だけ）', () => {
    for (const level of ['normal', 'hard'] as const) {
      const run = (cfg: CpuConfig) => {
        const g = new Mode2Game({ seed: 7, players: 1 });
        while (!g.playing) g.step();
        const cpu = new CpuController(0, level, 4, 'akane', cfg);
        return { cmds: play(g, cpu, 2400), cpu };
      };
      const a = run(CPU_CONFIG);
      expect(a.cpu.stats.perceptionRolls).toBe(0);
      expect(a.cpu.stats.mandatoryCount).toBe(0);
      expect(a.cmds).toEqual(run(without()).cmds);
    }
  });

  it('同じ設定・seed なら同じ操作列（中級・上級の MODE1）', () => {
    for (const level of ['normal', 'hard'] as const) {
      const run = () => {
        const g = makeGame({}, undefined, 21);
        toPlay(g);
        return play(g, new CpuController(0, level, 4, 'zunko'), 3000);
      };
      expect(run()).toEqual(run());
    }
  });
});

describe('V320-FIX-05 認識誤り（MODE1）', () => {
  it('誤認：出せない最上段を候補として選び、人間と同じ発射コマンドで打ち上げ、ゲーム本体が失敗と判定する（発射前に取り消さない）', () => {
    const cfg = quiet(clone());
    cfg.mode1Adjust!.misread.normal.normal.kotaro = 100;
    cfg.mode1Adjust!.overlook.normal.normal.kotaro = 0;
    // 場1♠。最上段はすべて合わない（4♥・5♦）＝実際の成功候補0
    const g = makeGame({ base: '1s', boards: { 0: { 0: ['4h', '5d'], 1: ['5d', '4h'], 2: ['4h', '5d'], 3: ['5d', '4h'], 4: ['4h', '5d'], 5: ['5d', '4h'] }, 1: EMPTY } });
    toPlay(g);
    const cpu = new CpuController(0, 'normal', 1, 'kotaro', cfg);
    play(g, cpu, 240);
    expect(cpu.stats.perceptionRolls).toBeGreaterThanOrEqual(1);
    expect(cpu.stats.misreadApplied).toBeGreaterThanOrEqual(1);
    expect(cpu.stats.misreadChosen).toBeGreaterThanOrEqual(1);
    expect(cpu.stats.misreadLaunched).toBeGreaterThanOrEqual(1);
    const id = cpu.misreadLaunchIds[0];
    const arrive = g.events.find((e) => e.type === 'arrive' && e.piece.id === id);
    expect(arrive && arrive.type === 'arrive' && arrive.success).toBe(false);
  });

  it('見落とし：唯一の成功候補を外す。同じ場・最上段の間は再抽選せず、完全情報の候補へ差し戻さない（打開操作で最上段が変われば新しい判断）', () => {
    const cfg = quiet(clone());
    cfg.mode1Adjust!.misread.normal.normal.kotaro = 0;
    cfg.mode1Adjust!.overlook.normal.normal.kotaro = 100;
    // 場1♠。成功候補は列1の2♠だけ（7段：手動上昇なし）
    const tall = (top: string) => [top, '4h', '5d', '4h', '5d', '4h', '5d'];
    const g = makeGame({ base: '1s', boards: { 0: { 0: tall('2s'), 1: tall('4h'), 2: tall('5d'), 3: tall('4h'), 4: tall('5d'), 5: tall('4h') }, 1: EMPTY } });
    toPlay(g);
    const cpu = new CpuController(0, 'normal', 1, 'kotaro', cfg);
    const target = (g.players[0].board.cols[0][0] as { piece: { id: number } }).piece.id;
    const keyOf = () => {
      const p = g.players[0];
      return `${g.base.id}|${p.board.cols.map((c) => (c[0] ? (c[0].kind === 'piece' ? c[0].piece.id : `r${c[0].pieceId}`) : '-')).join(',')}`;
    };
    const rollKeys: string[] = [];
    let launchedTarget = false;
    for (let i = 0; i < 300; i++) {
      const n = cpu.log.length;
      const k = keyOf();
      const out = cpu.poll(g);
      if (cpu.log.slice(n).some((l) => l.kind === 'perception')) rollKeys.push(k);
      if (out.some((c) => c.type === 'launch') && (g.players[0].board.cols[g.players[0].selectedCol][0] as { piece?: { id: number } })?.piece?.id === target) launchedTarget = true;
      g.step(out);
    }
    expect(cpu.stats.overlookApplied).toBeGreaterThanOrEqual(1);
    // 抽選は（場・最上段）が変わった時だけ：連続する2回の抽選が同じ状態で起きない（B入替で最上段が一周して戻った再訪は新しい判断）
    for (let i = 1; i < rollKeys.length; i++) expect(rollKeys[i], `roll${i}`).not.toBe(rollKeys[i - 1]);
    // 見落とした2♠を、完全情報へ差し戻して打ち上げない
    expect(launchedTarget).toBe(false);
  });

  it('実戦（中級・上級 MODE1）：認識の抽選回数は、観測した（場・最上段）の組の数を超えない（毎フレーム・1列移動ごとに引き直さない）', () => {
    for (const level of ['normal', 'hard'] as const) {
      const g = makeGame({}, undefined, 33);
      toPlay(g);
      const cpu = new CpuController(0, level, 5, 'akane');
      const keys = new Set<string>();
      for (let i = 0; i < 3600 && !g.result; i++) {
        const p = g.players[0];
        keys.add(`${g.base.id}|${p.board.cols.map((c) => (c[0] ? (c[0].kind === 'piece' ? c[0].piece.id : `r${c[0].pieceId}`) : '-')).join(',')}`);
        g.step(cpu.poll(g));
      }
      expect(cpu.stats.perceptionRolls).toBeGreaterThan(5);
      expect(cpu.stats.perceptionRolls).toBeLessThanOrEqual(keys.size);
      // 抽選の対象・当選・候補の変化・選択・発射を区別して数える
      const s = cpu.stats;
      expect(s.misreadApplied).toBeLessThanOrEqual(s.misreadHits);
      expect(s.overlookApplied).toBeLessThanOrEqual(s.overlookHits);
      expect(s.misreadLaunched).toBeLessThanOrEqual(s.misreadChosen);
    }
  });
});

describe('V320-FIX-05 中級・上級の必須判断待ち（MODE1）・探索深さ', () => {
  it('中級 120/180/240・上級 60/100/140（ピンチは同じ候補indexの半分）。MODE1 のみ', () => {
    for (const [level, set] of [
      ['normal', ['120ms', '180ms', '240ms', '60ms', '90ms', '120ms']],
      ['hard', ['60ms', '100ms', '140ms', '30ms', '50ms', '70ms']],
    ] as const) {
      const g = makeGame({}, undefined, 9);
      toPlay(g);
      const cpu = new CpuController(0, level, 2, 'kotaro');
      play(g, cpu, 2400);
      const waits = cpu.log.filter((l) => l.kind === 'mandatoryWait');
      expect(waits.length).toBeGreaterThan(3);
      for (const w of waits) expect(set).toContain(w.detail!.split(' ')[1]);
    }
  });

  it('探索深さ：初級は現行（目標までの残り取得数）、中級は2、上級は通常3・ピンチ4が上限', () => {
    const depth = (level: 'easy' | 'normal' | 'hard', goal: 4 | 6, hand: number, sit: 'normal' | 'pinch') =>
      (new CpuController(0, level, 1, 'kotaro') as unknown as { depthCap: (g: 4 | 6, h: number, s: string) => number }).depthCap(goal, hand, sit);
    expect(depth('easy', 6, 2, 'normal')).toBe(4);
    expect(depth('normal', 6, 2, 'normal')).toBe(2);
    expect(depth('normal', 4, 0, 'pinch')).toBe(2);
    expect(depth('hard', 6, 2, 'normal')).toBe(3);
    expect(depth('hard', 6, 2, 'pinch')).toBe(4);
    expect(depth('hard', 4, 3, 'normal')).toBe(1);
  });
});
