// オプション設定（音・操作・対戦・表示）の保持。保存先はこのブラウザの localStorage（保存・読込できない環境でも初期値で起動）。
// 初期値（設計補完）：2本先取・自然上昇中級・NPC中級、1P/2Pキーボード、各音量100（マスター−6dBは別に適用）、表示は収まる最大（実画素の整数倍）。
import { DEFAULT_VOLUMES, type AudioVolumes } from '../audio/audioBus';
import type { Difficulty } from '../core/config';
import type { FirstTo } from '../core/match';
import type { PlayerId } from '../core/types';
import {
  ACTIONS,
  cloneKeyBindings,
  clonePadBindings,
  DEFAULT_KEY_BINDINGS,
  DEFAULT_PAD_BINDINGS,
  type KeyBindings,
  type PadBindings,
} from './controller';

export type DeviceChoice = { kind: 'keyboard' } | { kind: 'gamepad'; index: number } | { kind: 'cpu'; level: Difficulty };

/** 0＝収まる最大（実画素の整数倍）、1〜8＝固定倍率（実画素。収まらない倍率は選べない。第3版 B6） */
export type DisplayScale = number;

export interface AppSettings {
  firstTo: FirstTo;
  /** 対戦の自然上昇の難易度（初級7秒・中級5秒・上級3秒） */
  difficulty: Difficulty;
  /** CPU対戦の相手（NPC）の強さ */
  npcLevel: Difficulty;
  /** 1P/2Pの入力機器（キーボード／ゲームパッド）。CPUはモード選択で割り当てる */
  devices: [DeviceChoice, DeviceChoice];
  keys: [KeyBindings, KeyBindings];
  pads: [PadBindings, PadBindings];
  audio: AudioVolumes;
  display: { scale: DisplayScale; fullscreen: boolean };
}

export function defaultSettings(): AppSettings {
  return {
    firstTo: 2,
    difficulty: 'normal',
    npcLevel: 'normal',
    devices: [{ kind: 'keyboard' }, { kind: 'keyboard' }],
    keys: [cloneKeyBindings(DEFAULT_KEY_BINDINGS[0]), cloneKeyBindings(DEFAULT_KEY_BINDINGS[1])],
    pads: [clonePadBindings(DEFAULT_PAD_BINDINGS), clonePadBindings(DEFAULT_PAD_BINDINGS)],
    audio: { ...DEFAULT_VOLUMES },
    display: { scale: 0, fullscreen: false },
  };
}

export const STORAGE_KEY = 'palamedes2-like.settings.v2';

function validKeys(b: unknown): b is KeyBindings {
  return !!b && typeof b === 'object' && ACTIONS.every((a) => Array.isArray((b as KeyBindings)[a]) && (b as KeyBindings)[a].every((c) => typeof c === 'string'));
}

function validPads(b: unknown): b is PadBindings {
  return !!b && typeof b === 'object' && ACTIONS.every((a) => Array.isArray((b as PadBindings)[a]));
}

const isDiff = (d: unknown): d is Difficulty => d === 'easy' || d === 'normal' || d === 'hard';
const vol = (v: unknown, d: number): number => (typeof v === 'number' && v >= 0 && v <= 100 ? Math.round(v) : d);
const validDevice = (d: unknown): d is DeviceChoice =>
  !!d && typeof d === 'object' && ((d as DeviceChoice).kind === 'keyboard' || ((d as DeviceChoice).kind === 'gamepad' && Number.isInteger((d as { index: number }).index)));

/** 保存値を検査して読み込む。壊れている項目は初期値 */
export function parseSettings(raw: string | null): AppSettings {
  const d = defaultSettings();
  if (!raw) return d;
  try {
    const s = JSON.parse(raw) as Partial<AppSettings>;
    if (s.firstTo === 1 || s.firstTo === 2 || s.firstTo === 3) d.firstTo = s.firstTo;
    if (isDiff(s.difficulty)) d.difficulty = s.difficulty;
    if (isDiff(s.npcLevel)) d.npcLevel = s.npcLevel;
    if (Array.isArray(s.devices) && s.devices.length === 2 && s.devices.every(validDevice)) d.devices = s.devices as AppSettings['devices'];
    if (Array.isArray(s.keys) && s.keys.length === 2 && s.keys.every(validKeys)) d.keys = s.keys as AppSettings['keys'];
    if (Array.isArray(s.pads) && s.pads.length === 2 && s.pads.every(validPads)) d.pads = s.pads as AppSettings['pads'];
    if (s.audio && typeof s.audio === 'object') {
      const a = s.audio;
      d.audio = {
        bgm: vol(a.bgm, 100),
        sfx: vol(a.sfx, 100),
        voice: vol(a.voice, 100),
        bgmMute: a.bgmMute === true,
        sfxMute: a.sfxMute === true,
        voiceMute: a.voiceMute === true,
      };
    }
    if (s.display && typeof s.display === 'object') {
      const sc = s.display.scale;
      if (typeof sc === 'number' && Number.isInteger(sc) && sc >= 0 && sc <= 8) d.display.scale = sc;
      d.display.fullscreen = s.display.fullscreen === true;
    }
  } catch {
    // 初期値のまま
  }
  return d;
}

export function loadSettings(): AppSettings {
  try {
    return parseSettings(localStorage.getItem(STORAGE_KEY));
  } catch {
    return defaultSettings();
  }
}

/** 保存できたら true（プライベートウィンドウ等で保存できない場合も例外にしない） */
export function saveSettings(s: AppSettings): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}

export const deviceLabel = (d: DeviceChoice): string =>
  d.kind === 'keyboard' ? 'キーボード' : d.kind === 'gamepad' ? `ゲームパッド${d.index + 1}` : `NPC（${{ easy: '初級', normal: '中級', hard: '上級' }[d.level]}）`;

/** オプションで選べる機器（キーボード／ゲームパッド1〜4） */
export const DEVICE_CHOICES: readonly DeviceChoice[] = [
  { kind: 'keyboard' },
  { kind: 'gamepad', index: 0 },
  { kind: 'gamepad', index: 1 },
  { kind: 'gamepad', index: 2 },
  { kind: 'gamepad', index: 3 },
];

export const sameDevice = (a: DeviceChoice, b: DeviceChoice): boolean => JSON.stringify(a) === JSON.stringify(b);

export const isHuman = (d: DeviceChoice): boolean => d.kind !== 'cpu';

export type { PlayerId };
