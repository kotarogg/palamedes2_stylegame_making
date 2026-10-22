// 第3版の表示・演出・画面遷移の状態（DOM非依存部分）：受攻撃ストック表示、接着、キャラ別シート、クラッカー、
// 役名表示の予定（B4・B5）、キャラクター選択、CPU相手順、クレジットのページ分け、段階SE
import { describe, expect, it } from 'vitest';
import type { AudioBus } from '../src/audio/audioBus';
import { SoundDirector } from '../src/audio/director';
import type { Command, Game, GameEvent } from '../src/core/game';
import type { AnyGame } from '../src/core/match';
import type { PlayerId } from '../src/core/types';
import { CharacterSelect, creditPages, CPU_ORDER, nextCpuOpponent } from '../src/app';
import { CHARACTER_SHEET, GameView } from '../src/view/gameView';
import { crackerPose, planResult, RoleNameDirector, RoleNameSchedule } from '../src/view/presentation';
import { DEFAULT_STOCK_VIEW, pendingGroupY, stockColumnLayout, stockGroupHeight, stockIcons } from '../src/view/stockLayout';
import { EMPTY, fakeAssets, makeGame, rows, setStock, stepN, toPlay } from './helpers';

const atk = (player: PlayerId, lines: number): Command => ({ player, type: 'debugAttack', lines });
const evs = <T extends GameEvent['type']>(g: Game, type: T, p?: PlayerId) =>
  g.events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type && (p === undefined || ('player' in e && e.player === p)));

describe('受攻撃ストックの配置（第10章）', () => {
  it('大＝5ライン16×16、小＝1ライン8×8を左上→右上→左下→右下。大を先に置く。0〜29の全状態', () => {
    for (let n = 0; n <= 29; n++) {
      const ic = stockIcons(n);
      expect(ic.filter((i) => i.size === 'large')).toHaveLength(Math.floor(n / 5));
      expect(ic.filter((i) => i.size === 'small')).toHaveLength(n % 5);
      const firstSmall = ic.findIndex((i) => i.size === 'small');
      if (firstSmall >= 0) expect(ic.slice(firstSmall).every((i) => i.size === 'small')).toBe(true);
      expect(stockGroupHeight(n)).toBe(16 * (Math.floor(n / 5) + (n % 5 > 0 ? 1 : 0)));
    }
    expect(stockIcons(9).map((i) => [i.size, i.x, i.y])).toEqual([
      ['large', 0, 0],
      ['small', 0, 16],
      ['small', 8, 16],
      ['small', 0, 24],
      ['small', 8, 24],
    ]);
  });

  it('修正R1：開始時の予約1〜29 × 現ブロック残量1〜予約 × 待機0〜(29−残量)、破棄・相殺の残像を含め、全要素が画面内（640×360）', () => {
    const cfg = DEFAULT_STOCK_VIEW;
    expect(cfg.origin[0]).toEqual([20, 148]);
    expect(cfg.origin[1]).toEqual([604, 148]);
    let cases = 0;
    let maxBottom = 0;
    for (const side of [0, 1] as const) {
      const [x0, top] = cfg.origin[side];
      for (let reserved = 1; reserved <= 29; reserved++)
        for (let cur = 1; cur <= reserved; cur++)
          for (let pend = 0; pend <= 29 - cur; pend++) {
            const pendingY = top + pendingGroupY(stockGroupHeight(reserved), null, null, cfg);
            // ピンチ破棄の残像（同じ波の余り最大2、予約内）と相殺の残像（相殺前の待機＝pend＋相殺分 ≦ 29−残量）
            const discard = Math.min(2, reserved - cur);
            const canceled = 29 - cur - pend;
            const after = [
              { kind: 'discard' as const, lines: discard, ms: 0 },
              { kind: 'counter' as const, lines: canceled, ms: 0 },
            ];
            for (const e of stockColumnLayout(x0, top, pendingY, cur, pend, after, cfg)) {
              const ok = e.x >= 0 && e.y >= 0 && e.x + e.w <= 640 && e.y + e.h <= 360;
              if (!ok) throw new Error(`画面外 side=${side} reserved=${reserved} cur=${cur} pend=${pend}: ${JSON.stringify(e)}`);
              maxBottom = Math.max(maxBottom, e.y + e.h);
            }
            cases++;
          }
    }
    expect(cases).toBeGreaterThan(8000);
    expect(maxBottom).toBeLessThanOrEqual(360);
    // 列は盤面枠（1P x48〜、2P 〜x592）と重ならない（囲い±3px を含む）
    expect(cfg.origin[0][0] + 16 + 3).toBeLessThanOrEqual(48);
    expect(cfg.origin[1][0] - 3).toBeGreaterThanOrEqual(592);
  });

  it('修正R1：PMの再現状態（予約29・残量5＝block3＋wave2・待機24）で待機群の下端が360以内（旧 y=228 では410）', () => {
    const top = DEFAULT_STOCK_VIEW.origin[0][1];
    const pendingY = top + pendingGroupY(stockGroupHeight(29), null, null);
    const bottom = Math.max(...stockColumnLayout(20, top, pendingY, 5, 24, []).map((e) => e.y + e.h));
    expect(bottom).toBe(148 + 96 + 6 + 80);
    expect(228 + 96 + 6 + 80).toBe(410);
    expect(bottom).toBeLessThanOrEqual(360);
  });

  it('修正R1：大5／小1・群の分離・囲い・XD相殺と破棄フェードの区別は従来どおり', () => {
    const L = stockColumnLayout(20, 148, 186, 9, 11, [
      { kind: 'counter', lines: 2, ms: 40 },
      { kind: 'discard', lines: 1, ms: 60 },
    ]);
    const icons = L.filter((e) => e.type === 'icon');
    expect(icons.filter((e) => e.y < 186 && e.type === 'icon' && !e.xd && e.alpha === 1).map((e) => (e as { size: string }).size)).toEqual(['large', 'small', 'small', 'small', 'small']);
    expect(L.filter((e) => e.type === 'frame')).toEqual([{ type: 'frame', x: 17, y: 145, w: 22, h: 38 }]);
    expect(L.filter((e) => e.type === 'burst').map((e) => (e as { frame: number }).frame)).toEqual([1, 1]);
    expect(icons.filter((e) => e.type === 'icon' && e.xd)).toHaveLength(2);
    expect(icons.filter((e) => e.type === 'icon' && e.alpha < 1)).toHaveLength(1);
  });

  it('待機群：ブロック中は予約高さ＋間隔の下に固定、終了後は120msで上詰め', () => {
    expect(pendingGroupY(32, null, null)).toBe(32 + DEFAULT_STOCK_VIEW.groupGapPx);
    expect(pendingGroupY(null, 38, 0)).toBe(38);
    expect(pendingGroupY(null, 38, 60)).toBe(19);
    expect(pendingGroupY(null, 38, 120)).toBe(0);
    expect(pendingGroupY(null, null, null)).toBe(0);
  });

  it('ゲーム内：上＝処理中ブロック（予約高さを終了まで維持）、下＝nextPending。群を混ぜない', () => {
    const g = makeGame({ boards: { 0: EMPTY, 1: EMPTY } });
    const v = new GameView(g, fakeAssets());
    toPlay(g);
    g.step([atk(0, 7)]);
    v.syncEvents();
    const oy = DEFAULT_STOCK_VIEW.origin[0][1];
    expect(v.stockView(0, g.tick)).toMatchObject({ blockLines: 0, pendingLines: 7, pendingY: oy, reservedPx: null });
    stepN(g, 120); // ブロック開始＋1段目
    v.syncEvents();
    expect(v.stockView(0, g.tick)).toMatchObject({ blockLines: 6, pendingLines: 0, reservedPx: 32 });
    g.step([atk(0, 12)]); // 消化中の受信は待機群へ
    v.syncEvents();
    expect(v.stockView(0, g.tick)).toMatchObject({ blockLines: 6, pendingLines: 12, reservedPx: 32, pendingY: oy + 32 + DEFAULT_STOCK_VIEW.groupGapPx });
    stepN(g, 30); // 2段目
    v.syncEvents();
    expect(v.stockView(0, g.tick)).toMatchObject({ blockLines: 5, reservedPx: 32 }); // 減っても予約高さは縮めない
    stepN(g, 200); // ブロック終了（7段でピンチ）
    v.syncEvents();
    const end = evs(g, 'blockEnd', 0)[0].tick;
    expect(v.stockView(0, end)).toMatchObject({ blockLines: 0, reservedPx: null, pendingY: oy + 32 + DEFAULT_STOCK_VIEW.groupGapPx });
    expect(v.stockView(0, end + 4).pendingY).toBeGreaterThan(oy);
    expect(v.stockView(0, end + 8).pendingY).toBe(oy); // 120ms＝7.2tick
  });

  it('相殺：XD顔＋小爆発を4コマ×40msの残像として表示（数量は即時に減る）。ピンチ破棄は別の表現（120msフェード）', () => {
    const g = makeGame({ boards: { 0: rows(4), 1: EMPTY } });
    const v = new GameView(g, fakeAssets());
    toPlay(g);
    g.step([atk(0, 3)]);
    setStock(g, 0, '1s', '2s', '3s', '4s');
    g.step([{ player: 0, type: 'declare' }]);
    stepN(g, 200);
    v.syncEvents();
    const c = evs(g, 'attackCancel', 0)[0];
    expect(c.total).toBe(0);
    expect(v.stockAfterimages(0, c.tick)).toEqual([{ kind: 'counter', lines: 3, frame: 0 }]);
    expect(v.stockAfterimages(0, c.tick + 8)[0].frame).toBe(3); // 133ms
    expect(v.stockAfterimages(0, c.tick + g.ticks(160))).toEqual([]);

    const h = makeGame({ boards: { 0: rows(5), 1: EMPTY } });
    const w = new GameView(h, fakeAssets());
    toPlay(h);
    h.step([atk(0, 5)]);
    stepN(h, 120 + h.ticks(400));
    w.syncEvents();
    const d = evs(h, 'attackDiscard', 0)[0];
    expect(w.stockAfterimages(0, d.tick)).toEqual([{ kind: 'discard', lines: 1, frame: 0 }]);
    expect(w.stockAfterimages(0, d.tick + 8)).toEqual([]); // 133ms
  });
});

describe('攻撃段の接着（第11章）', () => {
  it('新しい段は画面下から120msで飛来し、120ms・最大2pxで揺れて止まる。6列同時（同じ開始tick）', () => {
    const g = makeGame({ boards: { 0: EMPTY, 1: EMPTY } });
    const v = new GameView(g, fakeAssets());
    toPlay(g);
    g.step([atk(0, 1)]);
    stepN(g, 120);
    v.syncEvents();
    const row = evs(g, 'attackRow', 0)[0];
    expect(row.rowIds).toHaveLength(6);
    const t = row.tick;
    const y = 300;
    expect(v.attachOffset(t, t, 100, y).y).toBeGreaterThan(360);
    expect(v.attachOffset(t, t + g.ticks(60), 100, y).y).toBeGreaterThan(y);
    expect(v.attachOffset(t, t + g.ticks(120), 100, y)).toEqual({ x: 100, y });
    for (let k = 0; k <= g.ticks(120); k++) expect(Math.abs(v.attachOffset(t, t + g.ticks(120) + k, 100, y).x - 100)).toBeLessThanOrEqual(2);
    expect(v.attachOffset(t, t + g.ticks(240), 100, y)).toEqual({ x: 100, y });
  });
});

describe('キャラクター分離（第15章）・結果演出（第14章）', () => {
  it('モーションシートはキャラで選ぶ（コタローS1・アカネS2・ずん子S13）。プレイヤー番号では選ばない', () => {
    expect(CHARACTER_SHEET).toEqual({ kotaro: 'S1', akane: 'S2', zunko: 'S13' });
    const g = makeGame();
    const v = new GameView(g, fakeAssets());
    expect([v.characterSheet(0), v.characterSheet(1)]).toEqual(['S1', 'S2']);
    v.hud = { characters: ['zunko', 'kotaro'] };
    expect([v.characterSheet(0), v.characterSheet(1)]).toEqual(['S13', 'S1']);
  });

  it('クラッカー：勝者演出と同時に4コマ×220msを1回、勝者側を向く。引分け・ゲームオーバーはなし', () => {
    const fake = (outcome: string, winner: 0 | 1 | null): AnyGame => ({ result: { tick: 600, outcome, winner }, ticks: (ms: number) => Math.round((ms * 60) / 1000) }) as unknown as AnyGame;
    const p = planResult(fake('win', 0))!;
    const ms = 1000 / 60;
    expect(crackerPose(p, p.crackerTick! - 1, ms)).toBeNull();
    expect(crackerPose(p, p.crackerTick!, ms)).toEqual({ frame: 0, toward: 0 });
    expect(crackerPose(p, p.crackerTick! + 13, ms)).toEqual({ frame: 0, toward: 0 }); // 216.7ms
    expect(crackerPose(p, p.crackerTick! + 14, ms)).toEqual({ frame: 1, toward: 0 });
    expect(crackerPose(p, p.crackerTick! + 52, ms)).toEqual({ frame: 3, toward: 0 });
    expect(crackerPose(p, p.crackerTick! + 53, ms)).toBeNull();
    expect(crackerPose(planResult(fake('win', 1)), 692, ms)?.toward).toBe(1);
    expect(crackerPose(planResult(fake('draw', null)), 700, ms)).toBeNull();
    expect(crackerPose(planResult(fake('gameOver', null)), 700, ms)).toBeNull();
  });
});

describe('役名表示の予定（第13章 B4・B5）', () => {
  const ticks = (ms: number) => Math.round((ms * 60) / 1000);

  it('先頭ロゴ＝代表役：保持 max(600ms, ボイス尺)＋150ms、後続ロゴは各600ms。開始時に代表役ボイス', () => {
    const heads: number[] = [];
    const s = new RoleNameSchedule(ticks, undefined, (logo, t) => heads.push(logo, t));
    s.declare([3, 7, 9], 900, 100);
    expect(heads).toEqual([3, 100]);
    expect(s.logoAt(100)).toEqual({ logo: 3, since: 100 });
    expect(s.logoAt(100 + 54 + 8)).toEqual({ logo: 3, since: 100 }); // 900ms＋150ms の手前
    expect(s.logoAt(100 + 54 + 9)).toEqual({ logo: 7, since: 163 });
    expect(s.logoAt(163 + 36)).toEqual({ logo: 9, since: 199 });
    expect(s.logoAt(199 + 36)).toBeNull();
    // ボイスが短い／不明なら600ms
    const t = new RoleNameSchedule(ticks);
    t.declare([1], 300, 0);
    expect(t.current).toMatchObject({ headStart: 0, waitEnd: 36 + 9, end: 45 });
    t.declare([2], null, 100);
    expect(t.current).toMatchObject({ headStart: 100, waitEnd: 145 });
  });

  it('後続ロゴ表示中の新宣言は後続を中止して即開始。先頭保持中の新宣言は最新1件だけ待たせる', () => {
    const heads: number[] = [];
    const s = new RoleNameSchedule(ticks, undefined, (logo) => heads.push(logo));
    s.declare([1, 2, 3], 600, 0); // waitEnd 45
    s.declare([4], 600, 50); // 後続表示中 → 中止して即開始
    expect(s.logoAt(50)).toEqual({ logo: 4, since: 50 });
    s.declare([5, 6], 600, 60); // 先頭保持中 → 表示待ち
    s.declare([7], 600, 70); // 最新1件だけ
    expect(s.hasPending).toBe(true);
    s.update(94);
    expect(s.logoAt(94)?.logo).toBe(4);
    s.update(95); // 4 の先頭＋待機の終了で 7 を開始（5,6 は捨てる）
    expect(s.logoAt(95)).toEqual({ logo: 7, since: 95 });
    expect(heads).toEqual([1, 4, 7]);
    s.stop();
    expect(s.logoAt(96)).toBeNull();
  });

  it('結果で表示・表示待ちをすべて消す。ゲーム処理（攻撃・段の時刻）は延長しない', () => {
    const g = makeGame({ boards: { 0: rows(4), 1: rows(4) } });
    const d = new RoleNameDirector(g, null, ['kotaro', 'akane']);
    toPlay(g);
    setStock(g, 0, '1s', '2s', '3s', '4s');
    g.step([{ player: 0, type: 'declare' }]);
    d.update();
    expect(d.logoAt(0, g.tick)).not.toBeNull();
    (g as unknown as { result: unknown }).result = { tick: g.tick, outcome: 'win', winner: 0 };
    expect(d.logoAt(0, g.tick)).toBeNull();
  });
});

describe('キャラクター選択（S05）・CPU相手順', () => {
  it('初期カーソル 1P コタロー／2P アカネ。移動は相手の位置を飛ばして循環。決定済みは動かない', () => {
    const s = new CharacterSelect();
    expect(s.cursors).toEqual([0, 1]);
    expect(s.move(0, 1)).toBe(true); // 1Pは アカネ(1) を飛ばして ずん子(2)
    expect(s.cursors).toEqual([2, 1]);
    expect(s.move(1, 1)).toBe(true); // 2Pは ずん子(2) を飛ばして コタロー(0)
    expect(s.cursors).toEqual([2, 0]);
    expect(s.confirm(0)).toBe(true);
    expect(s.move(0, 1)).toBe(false);
    expect(s.confirm(0)).toBe(false);
    expect(s.move(1, -1)).toBe(true); // 2P：コタロー(0)→左は ずん子(2) を飛ばして アカネ(1)
    expect(s.cursors).toEqual([2, 1]);
  });

  it('戻る：自分の決定だけ取消。両者未決定なら前のメニュー。両者決定で選んだキャラ', () => {
    const s = new CharacterSelect();
    expect(s.back(0)).toBe('leave');
    s.confirm(1);
    expect(s.back(0)).toBe('none');
    expect(s.back(1)).toBe('undo');
    expect(s.locked).toEqual([false, false]);
    s.confirm(0);
    s.confirm(1);
    expect(s.done).toBe(true);
    expect(s.characters()).toEqual(['kotaro', 'akane']);
  });

  it('CPU対戦の相手順：アカネ→ずん子→アカネ（「次の相手へ」だけで進む）', () => {
    expect(CPU_ORDER).toEqual(['akane', 'zunko']);
    expect(nextCpuOpponent('akane')).toBe('zunko');
    expect(nextCpuOpponent('zunko')).toBe('akane');
  });

  it('クレジット：編集可能な本文をページに分け、リンクは選択できる項目として別ページ', () => {
    const pages = creditPages(['a', 'b', 'c'], { YouTube: 'https://y', X: 'https://x' }, 2);
    expect(pages).toEqual([[{ text: 'a' }, { text: 'b' }], [{ text: 'c' }], [{ text: 'YouTube　https://y', url: 'https://y' }, { text: 'X　https://x', url: 'https://x' }]]);
  });
});

describe('段階SE（第12章）', () => {
  const fakeBus = () => {
    const sfx: string[] = [];
    const voice: string[] = [];
    const bus = { playSfx: (id: string) => (sfx.push(id), true), playVoice: (c: string, l: string) => (voice.push(`${c}_${l}`), true), stopPlaySounds: () => undefined } as unknown as AudioBus;
    return { bus, sfx, voice };
  };

  it('打ち上げ成功は連続取得数、役宣言は役連鎖数で5段階。旧成功音・旧成立音・連鎖音は鳴らさない。相殺音は1回', () => {
    const { bus, sfx, voice } = fakeBus();
    const events = [
      { type: 'arrive', tick: 1, player: 0, success: true, streak: 1 },
      { type: 'arrive', tick: 2, player: 0, success: true, streak: 3 },
      { type: 'arrive', tick: 3, player: 1, success: true, streak: 7 },
      { type: 'declare', tick: 4, player: 0, chainCount: 1, logos: [0] },
      { type: 'declare', tick: 5, player: 1, chainCount: 6, logos: [0] },
      { type: 'attack', tick: 6, player: 0, counter: { canceled: 4, sent: 0 } },
      { type: 'attackRow', tick: 7, player: 1, firstOfWave: true },
      { type: 'attackRow', tick: 8, player: 1, firstOfWave: false },
    ];
    const game = { events, mode: 'mode1', playing: false, players: [] } as unknown as AnyGame;
    new SoundDirector(bus, game, ['kotaro', 'zunko']).sync();
    expect(sfx).toEqual(['launch_success_1', 'launch_success_3', 'launch_success_5', 'role_declare_1', 'role_declare_5', 'counter', 'field_rise', 'attack_row', 'field_rise', 'attack_row']);
    // 役ボイスは役名表示側（先頭ロゴ開始と同時）。被攻撃ボイスは波の最初だけ、話者は2Pのキャラ
    expect(voice).toEqual(['zunko_damage']);
  });
});
