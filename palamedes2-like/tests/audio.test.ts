import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AudioBus, dbToGain, DEFAULT_MIX, volumeToGain } from '../src/audio/audioBus';
import { allAudioFiles, BGM_FILES, launchSuccessSfx, roleDeclareSfx, roleVoiceLine, sfxFile, SFX_IDS, VOICE_PRIORITY } from '../src/audio/audioMap';
import type { AnyGame } from '../src/core/match';
import { parseSettings } from '../src/input/settings';
import { emptyRecords, parseRecords, submitEndless, submitMode2, submitStage } from '../src/ui/records';
import { characterPose, planResult, readyDurationMs } from '../src/view/presentation';
import { resolveScale } from '../src/view/scale';
import { ROOT } from './helpers';

describe('音声素材の一覧（v3.1.0 必須117本）', () => {
  it('BGM3・SE39・ボイス75（3キャラ×25、ピンチ含む）の一覧。リポジトリには効果音とボイスが実在する（BGMを含む必須117本の実在は納品検査 check-release／e2e が担う）', () => {
    const files = allAudioFiles();
    expect(files).toHaveLength(117);
    expect(new Set(files).size).toBe(117);
    expect(new Set(SFX_IDS.map((id) => sfxFile(id))).size).toBe(39);
    expect(files.filter((f) => f.startsWith('sfx/'))).toHaveLength(39);
    expect(files.filter((f) => f.startsWith('voice/'))).toHaveLength(75);
    for (const c of ['kotaro', 'akane', 'zunko']) expect(files.filter((f) => f.startsWith(`voice/voice_${c}_`)), c).toHaveLength(25);
    // 置き換えた旧音（成功音・成立音・連鎖音・旧上昇音）は収録しない
    for (const old of ['sfx/sfx_piece_success.wav', 'sfx/sfx_role_success.wav', 'sfx/sfx_chain.wav', 'sfx/sfx_field_rise.wav']) {
      expect(files).not.toContain(old);
      expect(existsSync(new URL(`public/assets/audio/${old}`, ROOT)), old).toBe(false);
    }
    for (const f of files.filter((f) => !f.startsWith('bgm/'))) expect(existsSync(new URL(`public/assets/audio/${f}`, ROOT)), f).toBe(true);
    expect(Object.values(BGM_FILES)).toEqual(['bgm/bgm_menu.wav', 'bgm/bgm_puzzle_single.wav', 'bgm/bgm_puzzle_versus.wav']);
  });

  it('段階SE：打ち上げ成功は連続取得1〜5（6以上は5）、役宣言は役連鎖1〜5（6以上は5）。2系統は独立', () => {
    expect([1, 2, 3, 4, 5, 6, 12].map(launchSuccessSfx)).toEqual(['launch_success_1', 'launch_success_2', 'launch_success_3', 'launch_success_4', 'launch_success_5', 'launch_success_5', 'launch_success_5']);
    expect([1, 2, 5, 6].map(roleDeclareSfx)).toEqual(['role_declare_1', 'role_declare_2', 'role_declare_5', 'role_declare_5']);
    expect(sfxFile('launch_success_1')).toBe('sfx/se_launch_success_01.wav');
    expect(sfxFile('role_declare_5')).toBe('sfx/se_role_declare_05.wav');
    expect(sfxFile('counter')).toBe('sfx/sfx_counter.wav');
    expect(sfxFile('attack_row')).toBe('sfx/sfx_attack_row.wav');
    expect(sfxFile('field_rise')).toBe('sfx/se_field_rise.wav');
  });

  it('役ボイスは役名ロゴ番号＋1の2桁（R1→role_01、R16→role_16）', () => {
    expect(roleVoiceLine(0)).toBe('role_01');
    expect(roleVoiceLine(15)).toBe('role_16');
  });
});

describe('AudioBus（AudioContext なしでも判定と記録は動く）', () => {
  const make = () => {
    let t = 0;
    const bus = new AudioBus('./', DEFAULT_MIX, () => t);
    return { bus, at: (ms: number) => (t = ms) };
  };

  it('同じ効果音の同一フレーム重複は1回にまとめる', () => {
    const { bus, at } = make();
    expect(bus.playSfx('piece_launch')).toBe(true);
    at(5);
    expect(bus.playSfx('piece_launch')).toBe(false);
    at(100);
    expect(bus.playSfx('piece_launch')).toBe(true);
    expect(bus.log.map((e) => e.skipped ?? 'ok')).toEqual(['ok', 'duplicate', 'ok']);
  });

  it('ボイス：低い優先度は鳴っている高い声を切らない（捨てる）、同等以上は置き換える', () => {
    const { bus, at } = make();
    expect(bus.playVoice('kotaro', 'role_01', VOICE_PRIORITY.role)).toBe(true);
    at(50);
    expect(bus.playVoice('kotaro', 'attack', VOICE_PRIORITY.attack)).toBe(false);
    expect(bus.playVoice('kotaro', 'role_02', VOICE_PRIORITY.role)).toBe(true);
    expect(bus.voicesPlaying('main')).toEqual(['kotaro_role_02']);
  });

  it('結果ボイスは敗者→勝者の2声が重なってよく、プレイ中の声は止める', () => {
    const { bus, at } = make();
    bus.playVoice('akane', 'attack', VOICE_PRIORITY.attack);
    at(10);
    bus.playVoice('kotaro', 'lose', VOICE_PRIORITY.result, 'result');
    at(20);
    bus.playVoice('akane', 'win', VOICE_PRIORITY.result, 'result');
    expect(bus.voicesPlaying('result')).toEqual(['kotaro_lose', 'akane_win']);
    expect(bus.voicesPlaying('main')).toEqual([]);
  });

  it('音量：100＝素材そのまま（0dB）、0＝無音。マスター −6dB・ダッキング −4dB', () => {
    expect(volumeToGain(100)).toBe(1);
    expect(volumeToGain(0)).toBe(0);
    expect(volumeToGain(50)).toBeCloseTo(0.25);
    expect(DEFAULT_MIX.masterDb).toBe(-6);
    expect(DEFAULT_MIX.duckDb).toBe(-4);
    expect(DEFAULT_MIX.bgmFadeMs).toBe(300);
    expect(dbToGain(-6)).toBeCloseTo(0.501, 3);
  });

  it('BGM：同じ曲の再要求では再始動しない（メニュー内の画面遷移）', () => {
    const { bus } = make();
    bus.playBgm('menu');
    bus.playBgm('menu');
    bus.playBgm('versus');
    expect(bus.log.filter((e) => e.kind === 'bgm').map((e) => e.id)).toEqual(['menu', 'versus']);
    expect(bus.currentBgm).toBe('versus');
  });

  it('取得できない素材は missing に記録して続行する', async () => {
    const bus = new AudioBus('./');
    await bus.preload(['bgm/bgm_menu.wav', 'sfx/sfx_go.wav'], async (u) => new Response(u.includes('bgm') ? null : new ArrayBuffer(8), { status: u.includes('bgm') ? 404 : 200 }));
    expect([...bus.missing]).toEqual(['bgm/bgm_menu.wav']);
  });
});

describe('開始・結果演出のタイミング', () => {
  const fake = (outcome: string, winner: 0 | 1 | null): AnyGame => ({ result: { tick: 600, outcome, winner }, ticks: (ms: number) => Math.round((ms * 60) / 1000) }) as unknown as AnyGame;

  it('勝敗（第14章）：敗者モーション640ms→落下700ms→200ms後に勝者＋クラッカー→300ms後に受付', () => {
    const p = planResult(fake('win', 1))!;
    expect(p).toMatchObject({ kind: 'versus', winner: 1, loser: 0, startTick: 600, fallStartTick: 638, fallEndTick: 680, winnerTick: 692, crackerTick: 692, crackerToward: 1, acceptTick: 710 });
    // モーション中は落下しない（最後まで再生してから落下）
    expect(characterPose(p, 0, 637)).toMatchObject({ anim: 'lose_fall', fall: 0, gone: false, motionTicks: 37 });
    expect(characterPose(p, 0, 659).fall).toBeGreaterThan(0);
    expect(characterPose(p, 0, 680).gone).toBe(true);
    expect(characterPose(p, 1, 691).anim).toBeNull();
    expect(characterPose(p, 1, 692).anim).toBe('win');
  });

  it('引分け：両者敗北モーション・落下なし・クラッカーなし。ゲームオーバーもクラッカーなし', () => {
    const p = planResult(fake('draw', null))!;
    expect(p.winnerTick).toBeNull();
    expect(p.crackerTick).toBeNull();
    for (const pl of [0, 1] as const) expect(characterPose(p, pl, 700)).toMatchObject({ anim: 'lose_fall', fall: 0, gone: false });
    expect(planResult(fake('gameOver', null))!.crackerTick).toBeNull();
    expect(planResult(fake('stageClear', 0))).toMatchObject({ crackerTick: 600, crackerToward: 0 });
  });

  it('READY表示：担当ボイス長＋300ms（下限1200ms、音声なしは1850ms）', () => {
    expect(readyDurationMs(1500)).toBe(1800);
    expect(readyDurationMs(500)).toBe(1200);
    expect(readyDurationMs(null)).toBe(1850);
  });
});

describe('記録・設定・表示倍率', () => {
  it('シングル記録：ひたすら・ステージ・MODE2を分けて更新、壊れた保存値は空', () => {
    const r = emptyRecords();
    expect(submitEndless(r, 1200, 4)).toBe(true);
    expect(submitEndless(r, 900, 6)).toBe(false);
    expect(submitStage(r, 5000, 3, false)).toBe(true);
    expect(submitStage(r, 4000, 5, true)).toBe(false);
    expect(r.stage).toEqual({ score: 5000, maxStage: 5, completed: true, rule: 'stage20_V320-FIX-04' });
    expect(submitMode2(r, 3900, 65000, false).total).toBe(true);
    expect(submitMode2(r, 4200, 70000, false).total).toBe(false);
    expect(parseRecords(JSON.stringify(r))).toEqual(r);
    expect(parseRecords('{broken')).toEqual(emptyRecords());
  });

  it('設定：壊れた値・範囲外は初期値へ', () => {
    const s = parseSettings(JSON.stringify({ audio: { bgm: 999, sfx: 'x' }, display: { scale: 9 } }));
    expect(s.audio.sfx).toBe(100);
    expect(s.audio.bgm).toBeLessThanOrEqual(100);
    expect(s.display.scale).toBe(0);
    expect(parseSettings(JSON.stringify({ display: { scale: 3 } })).display.scale).toBe(3);
    expect(parseSettings('{broken')).toEqual(parseSettings(null));
  });

  it('表示倍率（B6）：実画素の整数倍。描画バッファ640N×360N・CSS 640N/DPR。収まらない固定倍率は収まる最大へ明示切替', () => {
    // DPR 1：1280×720 → 収まる最大2
    expect(resolveScale(0, 1280, 720, 1)).toMatchObject({ mode: 'fit', n: 2, bufferW: 1280, bufferH: 720, cssW: 1280, cssH: 720, switchedToFit: false });
    // DPR 1.25：CSS 1536×864 は実画素1920×1080 → 3倍（CSS 1536×864）
    expect(resolveScale(0, 1536, 864, 1.25)).toMatchObject({ n: 3, bufferW: 1920, bufferH: 1080, cssW: 1536, cssH: 864 });
    // DPR 1.5：固定2倍＝実画素1280×720、CSS 853.33×480
    const r = resolveScale(2, 1280, 720, 1.5);
    expect(r).toMatchObject({ mode: 'fixed', n: 2, bufferW: 1280, bufferH: 720 });
    expect(r.cssW).toBeCloseTo(1280 / 1.5, 6);
    // DPR 2：CSS 1280×720 は実画素2560×1440 → 4倍
    expect(resolveScale(0, 1280, 720, 2).n).toBe(4);
    // 収まらない固定倍率は黙って置き換えず、切替を報告する
    expect(resolveScale(4, 1920, 1080, 1)).toMatchObject({ mode: 'fit', n: 3, switchedToFit: true });
    // 1倍も収まらない場合だけ緊急縮小
    const e = resolveScale(0, 500, 300, 1);
    expect(e).toMatchObject({ mode: 'emergency', n: 1, bufferW: 640 });
    expect(e.cssW).toBeCloseTo(500, 6);
  });
});
