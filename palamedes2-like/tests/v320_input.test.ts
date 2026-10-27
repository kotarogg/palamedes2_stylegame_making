// v3.2.0 移動の先行入力（2tick）：MODE1・MODE2 共通。境界・逆方向・同時押し・端・反復と予約の競合・離した時・硬直・詰まり
import { describe, expect, it } from 'vitest';
import type { Command } from '../src/core/game';
import { Mode2Game } from '../src/core/mode2';
import { makeGame, toPlay } from './helpers';

type Any = { tick: number; step(c?: readonly Command[]): void; players: { selectedCol: number; charMoveEndTick: number }[]; inputLog: { tick: number; event: string; action: string; reason?: string }[] };
const L = (repeat = false): Command => (repeat ? { player: 0, type: 'left', repeat: true } : { player: 0, type: 'left' });
const R = (repeat = false): Command => (repeat ? { player: 0, type: 'right', repeat: true } : { player: 0, type: 'right' });

function games(): [string, () => Any][] {
  return [
    ['MODE1', () => {
      const g = makeGame();
      toPlay(g);
      return g as unknown as Any;
    }],
    ['MODE2', () => {
      const g = new Mode2Game({ seed: 3, players: 1 });
      while (!g.playing) g.step();
      return g as unknown as Any;
    }],
  ];
}

/** 移動を1回始め、次に移動できる tick（charMoveEndTick）を返す */
function startMove(g: Any, c: Command = R()): number {
  g.step([c]);
  return g.players[0].charMoveEndTick;
}
const stepTo = (g: Any, tick: number, cmds: Command[] = []) => {
  while (g.tick + 1 < tick) g.step();
  g.step(cmds);
};
const finish = (g: Any) => {
  for (let i = 0; i < 40; i++) g.step();
};

describe.each(games())('%s：移動の先行入力 2tick', (_name, make) => {
  it('次に移動できるtickが E のとき、E−3 の入力は期限切れ、E−2・E−1 は E に1回、E は通常入力', () => {
    for (const [dt, moved, reason] of [
      [-3, false, 'expired'],
      [-2, true, null],
      [-1, true, null],
      [0, true, null],
    ] as const) {
      const g = make();
      const e = startMove(g);
      stepTo(g, e + dt, [R()]);
      if (dt < 0) {
        stepTo(g, e);
        expect(g.players[0].selectedCol, `dt=${dt}`).toBe(moved ? 4 : 3);
        if (moved) expect(g.players[0].charMoveEndTick).toBe(e + (e - (e - 5))); // 移動はちょうど E に開始（周期は変えない）
      }
      finish(g);
      expect(g.players[0].selectedCol, `dt=${dt}`).toBe(moved ? 4 : 3);
      if (reason) expect(g.inputLog.some((x) => x.reason === reason)).toBe(true);
    }
  });

  it('逆方向の新規押下は方向を更新。同じtickの左右同時の新規押下は中立。1回の入力で2列以上動かない', () => {
    const g = make();
    const e = startMove(g);
    stepTo(g, e - 2, [R()]);
    g.step([L()]); // 逆方向で更新
    finish(g);
    expect(g.players[0].selectedCol).toBe(2);
    const h = make();
    h.step([L(), R()]);
    finish(h);
    expect(h.players[0].selectedCol).toBe(2);
    expect(h.inputLog.some((x) => x.reason === 'simultaneous')).toBe(true);
  });

  it('端で無効になった予約は破棄（記録）。予約は1回だけ消費', () => {
    const g = make();
    const e = startMove(g, L()); // 2→1
    stepTo(g, e - 1, [L()]);
    finish(g); // 1→0
    expect(g.players[0].selectedCol).toBe(0);
    const e2 = startMove(g, L()); // 端：動かない
    expect(e2).toBeLessThanOrEqual(g.tick);
    const h = make();
    h.step([L()]);
    h.step([L()]);
    const end = h.players[0].charMoveEndTick;
    stepTo(h, end - 1, [L()]);
    finish(h);
    expect(h.players[0].selectedCol).toBe(0); // 2→1→0（期限切れの1件は数えない）
    expect(h.inputLog.filter((x) => x.event === 'consume')).toHaveLength(1);
  });

  it('自動反復：既存の予約を上書きせず期限も延ばさない。離したら反復でできた予約を捨てる。明示的な短押しは離しても期限内なら有効', () => {
    const g = make();
    const e = startMove(g);
    stepTo(g, e - 2, [L()]);
    g.step([R(true)]); // 反復は上書きしない
    finish(g);
    expect(g.players[0].selectedCol).toBe(2);
    const h = make();
    const e2 = startMove(h);
    stepTo(h, e2 - 2, [R(true)]); // 反復で予約
    h.step([{ player: 0, type: 'cancelRepeat' }]); // 移動終了前に離した
    finish(h);
    expect(h.players[0].selectedCol).toBe(3);
    expect(h.inputLog.some((x) => x.reason === 'released')).toBe(true);
    const k = make();
    const e3 = startMove(k);
    stepTo(k, e3 - 2, [R()]); // 短押し
    k.step([{ player: 0, type: 'cancelRepeat' }]); // 離しても有効
    finish(k);
    expect(k.players[0].selectedCol).toBe(4);
  });
});

describe('先行入力：硬直・詰まり・状態変化では残さない', () => {
  it('MODE1：発射の硬直を横断して左右予約を残さない（硬直中の入力は保持しない）', () => {
    const g = makeGame({ base: '1s', boards: { 0: { 2: ['2s', '3s'] } } });
    toPlay(g);
    g.step([{ player: 0, type: 'launch' }]);
    g.step([R()]);
    for (let i = 0; i < 60; i++) g.step();
    expect(g.players[0].selectedCol).toBe(2);
    g.clearInputBuffers();
    expect(g.players[0].buffered).toBeNull();
  });
});

describe('v3.2.0 先行入力：フレームレート別（30/60/120fps・低fps）', () => {
  /**
   * 実際の経路を再現：キー押下はフレームの間に KeyboardController へ積まれ、次のフレームで固定ステップ（FixedStepDriver）の
   * 最初のtickに受け付けられる。受付tickが E−2 以上なら E に1回だけ移動し、それより前なら期限切れ。どのfpsでも2列移動しない
   */
  it.each([30, 60, 120, 15])('%sfps：受付tick基準の規則どおり（同じ押下で複数回動かない）', async (fps) => {
    const { KeyboardController } = await import('../src/input/controller');
    const { FixedStepDriver } = await import('../src/core/driver');
    for (const [name, make] of games()) {
      for (let offsetMs = 0; offsetMs <= 120; offsetMs += 5) {
        const g = make();
        const kb = new KeyboardController(0);
        const driver = new FixedStepDriver({ tickMs: 1000 / 60, step: () => g.step(kb.poll()) });
        g.step([R()]);
        const E = g.players[0].charMoveEndTick;
        const startCol = g.players[0].selectedCol;
        // E のtickが始まる時刻の offsetMs 前に押す（t=0 はいま、次のtickは g.tick+1）
        const pressAt = (E - (g.tick + 1)) * (1000 / 60) - offsetMs;
        let t = 0;
        const frame = 1000 / fps;
        let pressed = false;
        let acceptTick = -1;
        while (t < 600) {
          if (!pressed && t + frame > pressAt) {
            // フレームの途中で押された：次のフレームで受け付け
            kb.handleKey('KeyD', false);
            pressed = true;
            acceptTick = g.tick + 1;
          }
          driver.advance(frame);
          t += frame;
        }
        const moves = g.players[0].selectedCol - startCol;
        const consumed = g.inputLog.filter((e) => e.event === 'consume' && e.action === 'right');
        if (acceptTick >= E) expect(moves, `${name} ${fps}fps ${offsetMs}ms 通常入力`).toBe(1);
        else if (acceptTick >= E - 2) {
          expect(moves, `${name} ${fps}fps ${offsetMs}ms accept${acceptTick} E${E}`).toBe(1);
          expect(consumed.map((e) => e.tick)).toEqual([E]);
        } else {
          expect(moves, `${name} ${fps}fps ${offsetMs}ms 期限切れ`).toBe(0);
          expect(g.inputLog.some((e) => e.event === 'discard' && e.reason === 'expired')).toBe(true);
        }
      }
    }
  });
});

describe.each(games())('%s：v3.2.0 r 移動予約の消費順（当該tickの解除・新規方向を旧予約より先に反映）', (_name, make) => {
  const C = (): Command => ({ player: 0, type: 'cancelRepeat' });
  type MoveEv = { type: string; tick: number; from: number; to: number };
  const moves = (g: Any) => (g as unknown as { events: MoveEv[] }).events.filter((e) => e.type === 'move');
  /** 3列目へ1歩移動中（E＝次に移動できるtick）。以後の移動イベントだけを見る */
  const setup = () => {
    const g = make();
    const e = startMove(g); // 2→3
    const before = moves(g).length;
    return { g, e, after: () => moves(g).slice(before) };
  };

  it('① E−1 に右の反復で予約し、E で解除：右へ動かない（解除が先）', () => {
    const { g, e, after } = setup();
    stepTo(g, e - 1, [R(true)]);
    stepTo(g, e, [C()]);
    finish(g);
    expect(after()).toEqual([]);
    expect(g.players[0].selectedCol).toBe(3);
    expect(g.inputLog.some((x) => x.event === 'discard' && x.reason === 'released' && x.tick === e)).toBe(true);
  });

  it('② E−1 に右を予約し、E で左を押す：古い右へ動かず、E に左へ1回だけ（切り返しの往復なし）', () => {
    for (const dt of [-1, -2]) {
      const { g, e, after } = setup();
      stepTo(g, e + dt, [R()]);
      stepTo(g, e, [L()]);
      finish(g);
      expect(after().map((m) => [m.tick, m.from, m.to]), `dt=${dt}`).toEqual([[e, 3, 2]]);
      expect(g.inputLog.some((x) => x.event === 'discard' && x.action === 'right' && x.reason === 'overwritten' && x.tick === e)).toBe(true);
      expect(g.inputLog.some((x) => x.event === 'consume' && x.action === 'right')).toBe(false);
    }
  });

  it('期限境界：E−2 の予約は E に1回、E−3 は期限切れ（E で別入力がなければ）', () => {
    const a = setup();
    stepTo(a.g, a.e - 2, [R()]);
    finish(a.g);
    expect(a.after().map((m) => [m.tick, m.to])).toEqual([[a.e, 4]]);
    const b = setup();
    stepTo(b.g, b.e - 3, [R()]);
    finish(b.g);
    expect(b.after()).toEqual([]);
    expect(b.g.inputLog.some((x) => x.reason === 'expired')).toBe(true);
  });

  it('E で左右を同時に新規押下：中立。古い方向の予約も実行しない', () => {
    const { g, e, after } = setup();
    stepTo(g, e - 1, [R()]);
    stepTo(g, e, [L(), R()]);
    finish(g);
    expect(after()).toEqual([]);
    expect(g.inputLog.filter((x) => x.reason === 'simultaneous').length).toBeGreaterThanOrEqual(1);
  });

  it('移動中に左右を同時に新規押下：中立。それまでの方向予約も捨てる', () => {
    const { g, e, after } = setup();
    stepTo(g, e - 2, [R()]);
    stepTo(g, e - 1, [L(), R()]);
    finish(g);
    expect(after()).toEqual([]);
  });

  it('明示的な短押しは、離しても2tickの期限内は有効（E−1 に押し、E に解除しても E に1回動く）', () => {
    const { g, e, after } = setup();
    stepTo(g, e - 1, [R()]);
    stepTo(g, e, [C()]);
    finish(g);
    expect(after().map((m) => [m.tick, m.to])).toEqual([[e, 4]]);
  });

  it('反復との競合：同じtickに反復→解除の順で届いたら予約を作らない。反復は短押しの予約を上書きしない', () => {
    const a = setup();
    stepTo(a.g, a.e - 1, [R(true), C()]);
    finish(a.g);
    expect(a.after()).toEqual([]);
    const b = setup();
    stepTo(b.g, b.e - 2, [L()]);
    stepTo(b.g, b.e - 1, [R(true)]);
    finish(b.g);
    expect(b.after().map((m) => [m.tick, m.to])).toEqual([[b.e, 2]]);
  });

  it('1入力は1回だけ実行。移動の周期は変えない（E に開始し、次の移動可能tickは E＋移動時間）', () => {
    const { g, e, after } = setup();
    stepTo(g, e - 1, [R()]);
    finish(g);
    const m = after();
    expect(m).toHaveLength(1);
    expect(g.players[0].charMoveEndTick - e).toBe(e - (e - 5));
  });
});

describe('v3.2.0 r 低fps時の入力受付（案A：入力時刻と固定ステップの対応）', () => {
  /**
   * 実際の経路：キーは押下時刻（event.timeStamp）付きで積み、フレームごとの追いつき処理（FixedStepDriver に nowMs）で
   * 各tickの実時刻以前の入力だけをそのtickへ渡す。フレーム最後のtickでは残りを渡す（遅延を足さない）。
   * 期待：受付tick＝「実時刻が押下時刻以上の最初のtick（無ければフレーム最後のtick）」。E−2 以上なら E に1回、それより前は期限切れ
   */
  /** 同じ fps・位相で、最初の右（時刻 t0）→ 2回目の右（時刻 press。null なら押さない）をフレーム処理で流す */
  async function sim(make: () => Any, fps: number, phase: number, press: number | null) {
    const { KeyboardController } = await import('../src/input/controller');
    const { FixedStepDriver } = await import('../src/core/driver');
    const g = make();
    const kb = new KeyboardController(0);
    const tickAt = new Map<number, number>();
    const lastOfFrame = new Set<number>();
    const driver = new FixedStepDriver({
      tickMs: 1000 / 60,
      step: (info) => {
        const t = g.tick + 1;
        tickAt.set(t, info!.at!);
        if (info!.last) lastOfFrame.add(t);
        g.step(kb.poll(undefined, info));
      },
    });
    const frame = 1000 / fps;
    let now = 1000 + phase * frame;
    driver.advance(0, now);
    const keys: [number, string][] = [[now + 5, 'KeyD'], ...(press === null ? [] : ([[press, 'KeyD']] as [number, string][]))];
    let queuedAfter = -1;
    while (now < 1700) {
      const next = now + frame;
      for (const [at, code] of keys)
        if (at > now && at <= next) {
          kb.handleKey(code, false, at);
          if (at === press) queuedAfter = g.tick;
        }
      now = next;
      driver.advance(frame, now);
    }
    return { g, tickAt, lastOfFrame, queuedAfter };
  }

  it.each([15, 30, 60, 120, 144])('%sfps・位相4通り：押下時刻に対応するtickで受け付け、E−2 以上なら E に1回（2列移動なし）。実時間の窓は約33ms', async (fps) => {
    for (const [name, make] of games()) {
      let executedUpTo = -1;
      let expiredFrom = Infinity;
      for (const phase of [0, 0.25, 0.5, 0.75]) {
        // 1回目：最初の移動の開始tick と E の実時刻
        const base = await sim(make, fps, phase, null);
        const mv = (base.g as unknown as { events: { type: string; tick: number; endTick: number }[] }).events.find((e) => e.type === 'move')!;
        const E = mv.endTick;
        const tE = base.tickAt.get(E)!;
        const tStart = base.tickAt.get(mv.tick)!;
        for (let lead = 0; lead <= 70; lead += 1) {
          const press = tE - lead;
          if (press <= tStart) continue; // 最初の移動より前の押下は対象外
          const r = await sim(make, fps, phase, press);
          const moved = r.g.players[0].selectedCol - base.g.players[0].selectedCol;
          // 期待の受付tick：押下を積んだ後のtickのうち、実時刻が押下時刻以上の最初のtick。
          // それより先にフレーム最後のtickが来れば、そこで渡す（次フレームへ遅らせない＝遅延を足さない）
          const ticks = [...r.tickAt.keys()].sort((x, y) => x - y).filter((t) => t > r.queuedAfter);
          const acc = ticks.find((t) => r.tickAt.get(t)! >= press || r.lastOfFrame.has(t))!;
          const expectMove = acc >= E - 2 ? 1 : 0;
          expect(moved, `${name} ${fps}fps phase${phase} lead${lead} accept${acc} E${E}`).toBe(expectMove);
          // 受付の記録（buffer／expired／consume）が期待tickと一致
          const first = r.g.inputLog.find((x) => x.action === 'right' && x.tick > r.queuedAfter);
          if (acc < E) expect(first?.tick, `${name} ${fps}fps lead${lead}`).toBe(acc);
          if (moved) executedUpTo = Math.max(executedUpTo, lead);
          else expiredFrom = Math.min(expiredFrom, lead);
        }
      }
      expect(executedUpTo, `${name} ${fps}fps`).toBeGreaterThanOrEqual(33);
      expect(expiredFrom, `${name} ${fps}fps`).toBeGreaterThan(33);
      expect(expiredFrom, `${name} ${fps}fps`).toBeLessThanOrEqual(51);
    }
  });

  it.each([15, 30, 60, 120, 144])('%sfps：各tickの実時刻はフレームをまたいで単調に tickMs ずつ進み、フレーム時刻を超えない', async (fps) => {
    const { FixedStepDriver } = await import('../src/core/driver');
    const at: number[] = [];
    const lastFlags: boolean[] = [];
    let frameNow = 0;
    const d = new FixedStepDriver({
      tickMs: 1000 / 60,
      step: (info) => {
        expect(info!.at!).toBeLessThanOrEqual(frameNow + 1e-6);
        at.push(info!.at!);
        lastFlags.push(info!.last);
      },
    });
    for (let i = 1; i <= 120; i++) {
      frameNow = 500 + (i * 1000) / fps + (i % 3) * 0.7; // 揺らぎのあるフレーム間隔
      d.advance(i === 1 ? (1000 / fps) : frameNow - (500 + ((i - 1) * 1000) / fps + ((i - 1) % 3) * 0.7), frameNow);
    }
    for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeCloseTo(1000 / 60, 6);
    expect(lastFlags.filter(Boolean).length).toBeGreaterThan(0);
  });

  it('同じフレーム内の押下→解除・切り返しは、時刻順にそれぞれのtickへ渡す（15fps・1フレーム4tick）', async () => {
    const { KeyboardController } = await import('../src/input/controller');
    const kb = new KeyboardController(0);
    kb.handleKey('KeyD', false, 100);
    kb.handleKeyUp('KeyD', 120);
    kb.handleKey('KeyA', false, 140);
    // フレームの4tick（実時刻 110, 126.7, 143.3, 160）
    expect(kb.poll(undefined, { at: 110, last: false }).map((c) => c.type)).toEqual(['right']);
    expect(kb.poll(undefined, { at: 126.7, last: false }).map((c) => c.type)).toEqual(['cancelRepeat']);
    expect(kb.poll(undefined, { at: 143.3, last: false }).map((c) => c.type)).toEqual(['left']);
    expect(kb.poll(undefined, { at: 160, last: true })).toEqual([]);
    // フレーム最後のtickより後の時刻の入力も、最後のtickで渡す（次フレームへ遅らせない）
    kb.handleKey('KeyD', false, 170);
    expect(kb.poll(undefined, { at: 160, last: false })).toEqual([]);
    expect(kb.poll(undefined, { at: 160, last: true }).map((c) => c.type)).toEqual(['right']);
    // 時刻の無い呼出し（開始前待機の読み捨てなど）は全部渡す
    kb.handleKey('KeyA', false, 999);
    expect(kb.poll().map((c) => c.type)).toEqual(['left']);
  });

  it('パッド：押下時刻は分からないため推測しない。観測したフレームの最後のtickで渡す（60fps＝1フレーム1tickは従来と同じ）', async () => {
    const { GamepadController } = await import('../src/input/controller');
    let pressed = false;
    const pad = new GamepadController(0, 0, undefined, () => ({ buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: pressed && i === 15 })), axes: [0, 0] }), () => 0);
    pressed = true;
    // 15fps：1フレーム4tick。最初の3tickでは読まず、最後のtickで新規押下として1回
    expect(pad.poll(undefined, { at: 1, last: false })).toEqual([]);
    expect(pad.poll(undefined, { at: 2, last: false })).toEqual([]);
    expect(pad.poll(undefined, { at: 3, last: false })).toEqual([]);
    expect(pad.poll(undefined, { at: 4, last: true }).map((c) => c.type)).toEqual(['right']);
    // 次のフレームも押したまま：新規押下にしない
    expect(pad.poll(undefined, { at: 5, last: true })).toEqual([]);
    pressed = false;
    expect(pad.poll(undefined, { at: 6, last: true }).map((c) => c.type)).toEqual(['cancelRepeat']);
  });
});
