// v3.1.0 音声：与ダメ／被ダメボイスなし、役名との排他（20%代替・連続代替なし）、ピンチ到達音とカウント、ゲイン、結果SEの時刻、相殺音
import { describe, expect, it } from 'vitest';
import { AudioBus, DEFAULT_MIX } from '../src/audio/audioBus';
import { EVENT_GAIN_DB } from '../src/audio/audioMap';
import { SoundDirector } from '../src/audio/director';
import type { Command, Game, GameEvent } from '../src/core/game';
import type { PlayerId } from '../src/core/types';
import { RoleNameDirector, Staging } from '../src/view/presentation';
import { EMPTY, makeGame, rows, setStock, stepN, testConfig, toPlay } from './helpers';

const atk = (player: PlayerId, lines: number): Command => ({ player, type: 'debugAttack', lines });

/** 鳴らした効果音・ボイスを記録するだけの音声（AudioContext なし） */
function recBus() {
  const sfx: { id: string; delay: number; gainDb: number; tick: number }[] = [];
  const voice: { id: string; tick: number }[] = [];
  let tick = 0;
  const bus = {
    playSfx: (id: string, delay = 0, gainDb = 0) => (sfx.push({ id, delay, gainDb, tick }), true),
    playVoice: (c: string, line: string) => (voice.push({ id: `${c}_${line}`, tick }), true),
    playOptionalVoice: (c: string, line: string) => (voice.push({ id: `${c}_${line}`, tick }), true),
    voiceDurationMs: () => 800,
    stopPlaySounds: () => undefined,
  } as unknown as AudioBus;
  return { bus, sfx, voice, at: (t: number) => (tick = t), ids: () => sfx.map((s) => s.id) };
}

describe('v3.1.0 ボイス：通常の与ダメ／被ダメなし', () => {
  it('攻撃送信・攻撃段の適用でボイスを鳴らさない（効果音は従来どおり）', () => {
    const g = makeGame({ boards: { 0: rows(4), 1: EMPTY } });
    toPlay(g);
    const r = recBus();
    const d = new SoundDirector(r.bus, g, ['kotaro', 'akane']);
    setStock(g, 0, '1s', '2s', '3s', '4s');
    g.step([{ player: 0, type: 'declare' }]);
    stepN(g, 400);
    d.sync();
    expect(g.events.some((e) => e.type === 'attack' && e.counter.sent > 0)).toBe(true);
    expect(g.events.some((e) => e.type === 'attackRow')).toBe(true);
    expect(r.voice).toEqual([]);
    expect(r.ids()).toContain('attack_send');
  });
});

describe('v3.1.0 役宣言の代表ボイス：20%で攻撃ボイス、両方は鳴らさない、連続代替なし、新ラウンドで履歴リセット', () => {
  /** 宣言イベントを注入（表示順の先頭ロゴ＝代表役） */
  function declares(g: Game, ticks: number[], player: PlayerId = 0) {
    for (const t of ticks) (g.events as GameEvent[]).push({ type: 'declare', tick: t, player, logos: [2, 9], chainCount: 1 } as unknown as GameEvent);
  }

  it('宣言1回につき抽選1回。代替なら攻撃ボイスだけ、前回が代替なら次回は役名ボイス。発声は先頭ロゴの表示開始', () => {
    const g = makeGame({ boards: { 0: EMPTY, 1: EMPTY } });
    const r = recBus();
    // 100%で代替：1回目＝攻撃、2回目＝前回が代替なので役名、3回目＝攻撃…と交互
    const dir = new RoleNameDirector(g, r.bus, ['kotaro', 'akane'], undefined, 5, 100);
    for (let t = 0; t <= 700; t++) {
      (g as { tick: number }).tick = t;
      r.at(t);
      if ([10, 200, 400, 600].includes(t)) declares(g, [t]); // 宣言はその tick に届く
      dir.update();
    }
    expect(dir.voiceLog.map((v) => v.voice)).toEqual(['attack', 'role', 'attack', 'role']);
    expect(r.voice.map((v) => v.id)).toEqual(['kotaro_attack', 'kotaro_role_03', 'kotaro_attack', 'kotaro_role_03']);
    expect(r.voice.map((v) => v.tick)).toEqual([10, 200, 400, 600]);
    // 0%：常に役名（複数役でも代表は先頭の1本）
    const g2 = makeGame({ boards: { 0: EMPTY, 1: EMPTY } });
    const r2 = recBus();
    const d2 = new RoleNameDirector(g2, r2.bus, ['akane', 'kotaro'], undefined, 5, 0);
    declares(g2, [10]);
    d2.update();
    expect(r2.voice.map((v) => v.id)).toEqual(['akane_role_03']);
  });

  it('履歴はプレイヤー別で、新ラウンド（reset）で消す。初期値20%は seed 固定で再現', () => {
    const g = makeGame({ boards: { 0: EMPTY, 1: EMPTY } });
    const r = recBus();
    const dir = new RoleNameDirector(g, r.bus, ['kotaro', 'akane'], undefined, 5, 100);
    declares(g, [10], 0);
    declares(g, [12], 1);
    dir.update();
    expect(dir.voiceLog.map((v) => [v.player, v.voice])).toEqual([
      [0, 'attack'],
      [1, 'attack'],
    ]);
    const g2 = makeGame({ boards: { 0: EMPTY, 1: EMPTY } });
    dir.reset(g2);
    declares(g2, [10], 0);
    dir.update();
    expect(dir.voiceLog.at(-1)).toMatchObject({ player: 0, voice: 'attack' }); // 前ラウンドの代替は持ち越さない
    // 初期値20%：同じ seed なら同じ結果
    const run = () => {
      const gg = makeGame({ boards: { 0: EMPTY, 1: EMPTY } });
      const d = new RoleNameDirector(gg, recBus().bus, ['kotaro', 'akane'], undefined, 77);
      declares(gg, Array.from({ length: 30 }, (_, i) => 10 + i * 300));
      for (let t = 0; t < 10000; t += 50) {
        (gg as { tick: number }).tick = t;
        d.update();
      }
      return d.voiceLog.map((v) => v.voice);
    };
    expect(run()).toEqual(run());
    const v = run();
    for (let i = 1; i < v.length; i++) expect(v[i - 1] === 'attack' && v[i] === 'attack').toBe(false);
  });

  it('宣言SE：代表ボイスと同時なら −2dB、前の役名表示の待ちで代表ボイスが後になる宣言は 0dB', () => {
    const g = makeGame({ boards: { 0: rows(6), 1: EMPTY } });
    toPlay(g);
    const r = recBus();
    const names = new RoleNameDirector(g, r.bus, ['kotaro', 'akane']);
    const d = new SoundDirector(r.bus, g, ['kotaro', 'akane'], { attachDelayMs: 120, voiceWithDeclare: (p, t) => names.voiceStartsNow(p, t) });
    setStock(g, 0, '1s', '2s', '3s', '4s');
    g.step([{ player: 0, type: 'declare' }]);
    d.sync();
    names.update();
    const decl = r.sfx.find((s) => s.id.startsWith('role_declare_'))!;
    expect(decl.gainDb).toBe(EVENT_GAIN_DB.declareWithVoice);
    // V320-FIX-05 で更新：表示待ちを作らないため、次の宣言でも代表ボイスは宣言と同時（旧：先頭保持中は待ちの後で 0dB）
    expect(names.voiceStartsNow(0, g.tick + 1)).toBe(true);
    // 代表ボイスと同時でない宣言（voiceWithDeclare＝false の経路）は従来どおり 0dB
    const d2 = new SoundDirector(r.bus, g, ['kotaro', 'akane'], { attachDelayMs: 120, voiceWithDeclare: () => false });
    d2.sync();
    expect(r.sfx.filter((s) => s.id.startsWith('role_declare_')).at(-1)!.gainDb).toBe(0);
  });
});

describe('v3.1.0 警告SE・ピンチボイス', () => {
  it('danger は到達時に1回（毎秒の反復なし）、3/2/1 の表示開始で countdown 各1回。解除・終了後は鳴らさない', () => {
    const g = makeGame({ boards: { 0: rows(7), 1: EMPTY } });
    toPlay(g);
    const r = recBus();
    const d = new SoundDirector(r.bus, g, ['kotaro', 'akane']);
    g.step([atk(0, 3)]);
    for (let i = 0; i < 400 && !g.result; i++) {
      g.step();
      r.at(g.tick);
      d.sync();
    }
    const warn = g.events.filter((e) => e.type === 'pinchWarn' && e.player === 0);
    const t0 = warn[0].tick;
    expect(r.sfx.filter((s) => s.id === 'danger').map((s) => s.tick - t0)).toEqual([0]);
    expect(r.sfx.filter((s) => s.id === 'countdown').map((s) => s.tick - t0)).toEqual([60, 120, 180]);
    // 期限（4000ms）では追加の音なし、結果後は新しいプレイ音を鳴らさない
    expect(r.sfx.filter((s) => s.tick - t0 >= 240 && (s.id === 'danger' || s.id === 'countdown'))).toHaveLength(0);
  });

  it('解除後は数字の音を出さない。再到達で danger が再び1回', () => {
    const g = makeGame({ boards: { 0: rows(7), 1: EMPTY } });
    toPlay(g);
    const r = recBus();
    const d = new SoundDirector(r.bus, g, ['kotaro', 'akane']);
    g.step([atk(0, 3)]);
    while (!g.events.some((e) => e.type === 'attackPinch')) g.step();
    stepN(g, 70);
    Object.assign(g.players[0].incoming, { waveRemaining: 0, blockRemaining: 0 });
    g.players[0].board.cols.forEach((c) => c.pop());
    stepN(g, 200);
    d.sync();
    expect(r.ids().filter((x) => x === 'countdown')).toHaveLength(1);
    expect(r.ids().filter((x) => x === 'danger')).toHaveLength(1);
  });

  it('自然上昇の危険猶予から攻撃ピンチへ移っただけでは到達音を重複させない', () => {
    const g = makeGame({ boards: { 0: rows(7), 1: EMPTY } }, testConfig({ naturalRiseIntervalMs: 1000 }));
    toPlay(g);
    const r = recBus();
    const d = new SoundDirector(r.bus, g, ['kotaro', 'akane']);
    while (!g.events.some((e) => e.type === 'danger')) g.step();
    g.step([atk(0, 3)]);
    stepN(g, 150);
    d.sync();
    expect(r.ids().filter((x) => x === 'danger')).toHaveLength(1);
  });
});

describe('v3.1.0 ゲイン（イベント側）と相殺音', () => {
  it('成立可能通知 −3dB。全消しは同じクリア処理でステージ達成が続く場合だけ −3dB', () => {
    const g = makeGame({ boards: { 0: EMPTY, 1: EMPTY } });
    toPlay(g);
    const r = recBus();
    const d = new SoundDirector(r.bus, g, ['kotaro', 'akane']);
    (g.events as GameEvent[]).push({ type: 'roleAvailable', tick: g.tick, player: 0 } as unknown as GameEvent);
    (g.events as GameEvent[]).push({ type: 'allClear', tick: g.tick, player: 0, bonus: 500, stageClearPending: true });
    (g.events as GameEvent[]).push({ type: 'allClear', tick: g.tick + 50, player: 0, bonus: 500, stageClearPending: false });
    d.sync();
    expect(r.sfx.find((s) => s.id === 'role_available')!.gainDb).toBe(-3);
    expect(r.sfx.filter((s) => s.id === 'all_clear').map((s) => s.gainDb)).toEqual([-3, 0]);
  });

  it('AudioBus はイベントのゲインを再生ノードへ設定し記録する（素材は変更しない）', () => {
    const bus = new AudioBus('./', DEFAULT_MIX, () => 0);
    bus.playSfx('role_available', 0, -3);
    expect(bus.log.at(-1)).toMatchObject({ id: 'role_available', gainDb: -3 });
  });

  it('相殺音：論理相殺（attackCancel）と同数で、同じバッチを二重に鳴らさない', () => {
    // V320-FIX-04：役導入1200msで処理が長くなるため、受攻撃ブロック開始前に攻撃処理が来るよう消去1ラインの盤面にする
    const g = makeGame({ boards: { 0: rows(1), 1: EMPTY } });
    toPlay(g);
    const r = recBus();
    const d = new SoundDirector(r.bus, g, ['kotaro', 'akane']);
    g.step([atk(0, 3)]);
    setStock(g, 0, '1s', '2s', '3s', '4s');
    g.step([{ player: 0, type: 'declare' }]);
    stepN(g, 400);
    d.sync();
    const cancels = g.events.filter((e) => e.type === 'attackCancel').length;
    expect(cancels).toBeGreaterThan(0);
    expect(r.ids().filter((x) => x === 'counter')).toHaveLength(cancels);
  });
});

describe('v3.1.0 結果SEの時刻', () => {
  function result(humans: PlayerId[], loserIsP0: boolean) {
    const g = makeGame({ boards: { 0: loserIsP0 ? rows(7) : EMPTY, 1: loserIsP0 ? EMPTY : rows(7) } });
    toPlay(g);
    const r = recBus();
    const st = new Staging(g, r.bus, { announcer: 'akane', characters: ['kotaro', 'akane'], humans });
    const lp = loserIsP0 ? 0 : 1;
    g.players[lp].incoming.pinchRemaining = 1;
    for (let i = 0; i < 400; i++) {
      g.step();
      r.at(g.tick);
      st.update();
    }
    const plan = st.plan!;
    return { r, plan };
  }

  it('CPU対戦：人が負け → 敗北SEを敗者演出開始に1回、勝利SEなし。人が勝ち → 勝利SEを勝者演出開始に1回、敗北SEなし', () => {
    const lose = result([0], true);
    expect(lose.r.sfx.filter((s) => s.id === 'lose').map((s) => s.tick)).toEqual([lose.plan.startTick]);
    expect(lose.r.sfx.filter((s) => s.id === 'win')).toHaveLength(0);
    const win = result([0], false);
    expect(win.r.sfx.filter((s) => s.id === 'win').map((s) => s.tick)).toEqual([win.plan.winnerTick]);
    expect(win.r.sfx.filter((s) => s.id === 'lose')).toHaveLength(0);
    // 順序：敗者ボイス → 落下 → 勝者演出（勝利SE＋勝利ボイス＋クラッカー）
    expect(win.r.voice.map((v) => v.id).filter((id) => /_(win|lose)$/.test(id))).toEqual(['akane_lose', 'kotaro_win']);
    expect(win.r.sfx.find((s) => s.id === 'result_cracker')!.tick).toBe(win.plan.winnerTick);
  });

  it('2P：敗北SE（敗者演出開始）・勝利SE（勝者演出開始）を各1回。結果開始で勝利SEを鳴らさない', () => {
    const x = result([0, 1], true);
    expect(x.r.sfx.filter((s) => s.id === 'lose').map((s) => s.tick)).toEqual([x.plan.startTick]);
    expect(x.r.sfx.filter((s) => s.id === 'win').map((s) => s.tick)).toEqual([x.plan.winnerTick]);
  });
});
