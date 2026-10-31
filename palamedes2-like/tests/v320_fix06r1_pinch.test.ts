// V320-FIX-06-R1 第3項：ピンチの開始と復帰を同じ単位で集計（プレイヤーごと。なし→あり＝開始、あり→両方なし＝復帰、敗北は復帰に含めない）
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, NATURAL_RISE_MS } from '../src/core/config';
import { Game } from '../src/core/game';
import { PinchTracker } from '../src/core/metrics';
import { CpuController } from '../src/input/cpu';
import { EMPTY, makeGame, toPlay } from './helpers';

function setup() {
  const g = makeGame({ boards: { 0: EMPTY, 1: EMPTY } });
  toPlay(g);
  return { g, t: new PinchTracker(g), p: g.players[0] };
}

describe('PinchTracker（状態を直接設定）', () => {
  it('重複猶予：自然→攻撃が重なっても開始1回、片方だけの解除は復帰にしない、両方解除で復帰1回', () => {
    const { t, p } = setup();
    t.sample();
    p.graceRemaining = 100; // 自然の危険猶予
    t.sample();
    p.incoming.pinchRemaining = 50; // 攻撃ピンチ猶予が重なる
    t.sample();
    p.graceRemaining = null; // 自然だけ解除
    t.sample();
    expect(t.finish()[0]).toEqual({ starts: 1, recoveries: 0, defeatedInPinch: 0, ongoingAtEnd: 1 });
    p.incoming.pinchRemaining = null; // 両方なし
    t.sample();
    expect(t.finish()[0]).toEqual({ starts: 1, recoveries: 1, defeatedInPinch: 0, ongoingAtEnd: 0 });
  });

  it('片方ずつの開始・解除の繰り返し：開始と復帰が同じ回数', () => {
    const { t, p } = setup();
    for (let k = 0; k < 3; k++) {
      p.incoming.pinchRemaining = 10;
      t.sample();
      t.sample();
      p.incoming.pinchRemaining = null;
      t.sample();
      p.graceRemaining = 10;
      t.sample();
      p.graceRemaining = null;
      t.sample();
    }
    expect(t.finish()[0]).toEqual({ starts: 6, recoveries: 6, defeatedInPinch: 0, ongoingAtEnd: 0 });
  });

  it('敗北はピンチ中でも復帰に含めず、以後は数えない。計測終了時継続中は別に数える（相手側）', () => {
    const { g, t, p } = setup();
    const q = g.players[1];
    p.graceRemaining = 30;
    q.incoming.pinchRemaining = 30;
    t.sample();
    p.defeated = true;
    p.graceRemaining = null;
    t.sample();
    p.defeated = false; // 敗北後の状態変化は数えない
    t.sample();
    const [a, b] = t.finish();
    expect(a).toEqual({ starts: 1, recoveries: 0, defeatedInPinch: 1, ongoingAtEnd: 0 });
    expect(b).toEqual({ starts: 1, recoveries: 0, defeatedInPinch: 0, ongoingAtEnd: 1 });
  });
});

describe('実ゲームでの整合', () => {
  it('CPU対戦（中級・決着あり／上級・未決着）：開始＝復帰＋ピンチ中の敗北＋終了時継続中。開始はピンチ警告の開始と一致、復帰は敗北以外の警告終了と一致', () => {
    for (const [level, seed, capSec] of [
      ['normal', 3, 180],
      ['hard', 1, 60],
    ] as const) {
      const g = new Game({ seed, config: { ...DEFAULT_CONFIG, naturalRiseIntervalMs: NATURAL_RISE_MS[level] } });
      const cpus = [new CpuController(0, level, seed * 3, 'kotaro'), new CpuController(1, level, seed * 5 + 1, 'akane')];
      const t = new PinchTracker(g);
      const limit = g.playStartTick + capSec * 60;
      while (!g.result && g.tick < limit) {
        g.step([...cpus[0].poll(g), ...cpus[1].poll(g)]);
        t.sample();
      }
      const res = t.finish();
      res.forEach((c, i) => {
        expect(c.starts, `${level} p${i}`).toBe(c.recoveries + c.defeatedInPinch + c.ongoingAtEnd);
        const warn = g.events.filter((e) => e.type === 'pinchWarn' && e.player === i);
        expect(c.starts).toBe(warn.filter((e) => e.type === 'pinchWarn' && e.state === 'start').length);
        const ends = warn.filter((e) => e.type === 'pinchWarn' && e.state === 'end').length;
        expect(c.recoveries).toBe(ends - c.defeatedInPinch);
      });
      expect(res.reduce((s, c) => s + c.starts, 0)).toBeGreaterThan(0);
    }
  });
});
