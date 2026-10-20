import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AudioBus, dbToGain, DEFAULT_MIX, volumeToGain } from '../src/audio/audioBus';
import { allAudioFiles, BGM_FILES, roleVoiceLine, SFX_IDS, VOICE_PRIORITY } from '../src/audio/audioMap';
import type { AnyGame } from '../src/core/match';
import { parseSettings } from '../src/input/settings';
import { emptyRecords, parseRecords, submitEndless, submitMode2, submitStage } from '../src/ui/records';
import { characterPose, planResult, readyDurationMs } from '../src/view/presentation';
import { chooseScale } from '../src/view/scale';
import { ROOT } from './helpers';

describe('音声素材の一覧（必須79本）', () => {
  it('BGM3・SE30・ボイス46。効果音とボイスは配信物に実在する', () => {
    const files = allAudioFiles();
    expect(files).toHaveLength(79);
    expect(new Set(files).size).toBe(79);
    expect(SFX_IDS).toHaveLength(30);
    expect(files.filter((f) => f.startsWith('voice/'))).toHaveLength(46);
    for (const f of files.filter((f) => !f.startsWith('bgm/'))) expect(existsSync(new URL(`public/assets/audio/${f}`, ROOT)), f).toBe(true);
    expect(Object.values(BGM_FILES)).toEqual(['bgm/bgm_menu.wav', 'bgm/bgm_puzzle_single.wav', 'bgm/bgm_puzzle_versus.wav']);
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

  it('勝敗：敗者の落下700ms→200ms後に勝者→300ms後に受付', () => {
    const p = planResult(fake('win', 1))!;
    expect(p).toMatchObject({ kind: 'versus', winner: 1, loser: 0, startTick: 600, fallEndTick: 642, winnerTick: 654, acceptTick: 672 });
    expect(characterPose(p, 0, 621)).toMatchObject({ anim: 'lose_fall', gone: false });
    expect(characterPose(p, 0, 642).gone).toBe(true);
    expect(characterPose(p, 1, 653).anim).toBeNull();
    expect(characterPose(p, 1, 654).anim).toBe('win');
  });

  it('引分け：両者敗北モーション・落下なし', () => {
    const p = planResult(fake('draw', null))!;
    expect(p.winnerTick).toBeNull();
    for (const pl of [0, 1] as const) expect(characterPose(p, pl, 700)).toEqual({ anim: 'lose_fall', fall: 0, gone: false });
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
    expect(r.stage).toEqual({ score: 5000, maxStage: 5, completed: true });
    expect(submitMode2(r, 65000)).toBe(true);
    expect(submitMode2(r, 70000)).toBe(false);
    expect(parseRecords(JSON.stringify(r))).toEqual(r);
    expect(parseRecords('{broken')).toEqual(emptyRecords());
  });

  it('設定：壊れた値・範囲外は初期値へ', () => {
    const s = parseSettings(JSON.stringify({ audio: { bgm: 999, sfx: 'x' }, display: { scale: 9 } }));
    expect(s.audio.sfx).toBe(100);
    expect(s.audio.bgm).toBeLessThanOrEqual(100);
    expect([0, 1, 2, 3, 4]).toContain(s.display.scale);
    expect(parseSettings('{broken')).toEqual(parseSettings(null));
  });

  it('表示倍率：自動は収まる最大の整数倍、指定倍率が収まらなければ収まる最大へ', () => {
    expect(chooseScale(0, 1280, 720)).toBe(2);
    expect(chooseScale(0, 1920, 1080)).toBe(3);
    expect(chooseScale(4, 1920, 1080)).toBe(3);
    expect(chooseScale(1, 1920, 1080)).toBe(1);
    expect(chooseScale(0, 500, 300)).toBeCloseTo(500 / 640);
  });
});
