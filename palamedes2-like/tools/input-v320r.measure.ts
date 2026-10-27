// v3.2.0 r 入力修正の証跡：npm run measure:cpu -- tools/input-v320r.measure.ts
// PM 再現の①②・期限境界・E での左右同時押下・短押し後の解除・反復との競合（MODE1・MODE2）と、低fps時の受付tick（キー時刻付き）を、
// 入力記録（buffer／consume／discard と tick）と移動イベントで出力する。結果は docs/v320r/input_evidence.json へ。
import { mkdirSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { FixedStepDriver } from '../src/core/driver';
import type { Command } from '../src/core/game';
import { Game } from '../src/core/game';
import { Mode2Game } from '../src/core/mode2';
import { KeyboardController } from '../src/input/controller';

type Any = Game | Mode2Game;
const R = (repeat = false): Command => (repeat ? { player: 0, type: 'right', repeat: true } : { player: 0, type: 'right' });
const L = (): Command => ({ player: 0, type: 'left' });
const C = (): Command => ({ player: 0, type: 'cancelRepeat' });

const make = (mode: 'mode1' | 'mode2'): Any => {
  const g = mode === 'mode1' ? new Game({ seed: 7 }) : new Mode2Game({ seed: 3, players: 1 });
  while (!g.playing) g.step();
  return g;
};

/** 3列目へ1歩移動中（E＝次に移動できるtick）に、E からの相対tickでコマンドを流す */
function scenario(mode: 'mode1' | 'mode2', script: [number, Command[]][]) {
  const g = make(mode);
  g.step([R()]);
  const E = g.players[0].charMoveEndTick;
  const moveStart = g.events.length;
  const logStart = g.inputLog.length;
  for (let t = g.tick + 1; t <= E + 12; t++) g.step(script.find(([d]) => E + d === t)?.[1] ?? []);
  return {
    E,
    script: script.map(([d, cmds]) => ({ tick: `E${d === 0 ? '' : d > 0 ? `+${d}` : d}`, commands: cmds.map((c) => c.type + ('repeat' in c && c.repeat ? '(反復)' : '')) })),
    inputLog: g.inputLog.slice(logStart).map((x) => ({ ...x, rel: `E${x.tick - E === 0 ? '' : x.tick - E > 0 ? `+${x.tick - E}` : x.tick - E}` })),
    moves: g.events
      .slice(moveStart)
      .filter((e) => e.type === 'move')
      .map((e) => {
        const m = e as { tick: number; from: number; to: number };
        return { tick: m.tick, rel: `E${m.tick - E === 0 ? '' : `+${m.tick - E}`}`, from: m.from, to: m.to };
      }),
  };
}

/** 低fps：キー時刻付きでフレーム処理し、押下の受付tickと実時刻を記録（1回目で E の実時刻を求め、2回目で押す） */
function lowFpsRun(fps: number, pressAt: number | null) {
  const g = make('mode1');
  const kb = new KeyboardController(0);
  const tickAt = new Map<number, number>();
  const driver = new FixedStepDriver({
    tickMs: 1000 / 60,
    step: (info) => {
      tickAt.set(g.tick + 1, Math.round(info!.at! * 10) / 10);
      g.step(kb.poll(undefined, info));
    },
  });
  const frame = 1000 / fps;
  let now = 1000;
  driver.advance(0, now);
  const keys = [now + 1, ...(pressAt === null ? [] : [pressAt])];
  while (now < 1600) {
    const next = now + frame;
    for (const at of keys) if (at > now && at <= next) kb.handleKey('KeyD', false, at);
    now = next;
    driver.advance(frame, now);
  }
  return { g, tickAt };
}

function lowFps(fps: number, pressLeadMs: number) {
  const base = lowFpsRun(fps, null);
  const E = (base.g.events.find((e) => e.type === 'move') as { endTick: number }).endTick;
  const pressAt = base.tickAt.get(E)! - pressLeadMs;
  const { g, tickAt } = lowFpsRun(fps, pressAt);
  const log = g.inputLog.filter((x) => x.action === 'right');
  return {
    fps,
    pressLeadMsBeforeTickE: pressLeadMs,
    E,
    tickE_at: tickAt.get(E),
    pressAt: Math.round(pressAt * 10) / 10,
    inputLog: log.map((x) => ({ ...x, at: tickAt.get(x.tick) })),
    moves: g.events.filter((e) => e.type === 'move').map((e) => ({ tick: e.tick, at: tickAt.get(e.tick) })),
  };
}

it('v3.2.0 r 入力証跡', () => {
  const out: Record<string, unknown> = {
    about: '移動予約の消費順（当該tickの解除・新規方向・同時押しを旧予約より先に反映）と、低fps時の受付（入力時刻と固定ステップの対応）の記録。E＝次に移動できるtick。模擬入力（実キーボード・実パッドではない）',
  };
  for (const mode of ['mode1', 'mode2'] as const) {
    out[mode] = {
      'PM①：E−1 に右の反復で予約、E で解除 → 動かない': scenario(mode, [[-1, [R(true)]], [0, [C()]]]),
      'PM②：E−1 に右、E で左 → E に左へ1回だけ': scenario(mode, [[-1, [R()]], [0, [L()]]]),
      'E−2 に右 → E に右へ1回': scenario(mode, [[-2, [R()]]]),
      'E−3 に右 → 期限切れ': scenario(mode, [[-3, [R()]]]),
      'E−1 に右、E で左右同時 → 中立（動かない）': scenario(mode, [[-1, [R()]], [0, [L(), R()]]]),
      'E−1 に右の短押し、E で解除 → E に右へ1回（期限内は維持）': scenario(mode, [[-1, [R()]], [0, [C()]]]),
      'E−1 に反復→解除（同じtick） → 予約を作らない': scenario(mode, [[-1, [R(true), C()]]]),
    };
  }
  out.lowFps = [15, 30, 60, 120, 144].flatMap((fps) => [20, 40, 60].map((lead) => lowFps(fps, lead)));
  mkdirSync(new URL('../docs/v320r/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../docs/v320r/input_evidence.json', import.meta.url), JSON.stringify(out, null, 1));
});
