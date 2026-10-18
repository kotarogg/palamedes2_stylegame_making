// 試合設定・入力機器・割当の保持。保存先はこのブラウザの localStorage（読めない環境では初期値で動く）。
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

export interface AppSettings {
  firstTo: FirstTo;
  /** 自然上昇の難易度 */
  difficulty: Difficulty;
  devices: [DeviceChoice, DeviceChoice];
  keys: [KeyBindings, KeyBindings];
  pads: [PadBindings, PadBindings];
}

export function defaultSettings(): AppSettings {
  return {
    firstTo: 2,
    difficulty: 'normal',
    devices: [{ kind: 'keyboard' }, { kind: 'keyboard' }],
    keys: [cloneKeyBindings(DEFAULT_KEY_BINDINGS[0]), cloneKeyBindings(DEFAULT_KEY_BINDINGS[1])],
    pads: [clonePadBindings(DEFAULT_PAD_BINDINGS), clonePadBindings(DEFAULT_PAD_BINDINGS)],
  };
}

const STORAGE_KEY = 'palamedes2-like.settings.v1';

function validKeys(b: unknown): b is KeyBindings {
  return !!b && typeof b === 'object' && ACTIONS.every((a) => Array.isArray((b as KeyBindings)[a]));
}

function validPads(b: unknown): b is PadBindings {
  return !!b && typeof b === 'object' && ACTIONS.every((a) => Array.isArray((b as PadBindings)[a]));
}

/** 保存値を検査して読み込む。壊れていれば初期値 */
export function parseSettings(raw: string | null): AppSettings {
  const d = defaultSettings();
  if (!raw) return d;
  try {
    const s = JSON.parse(raw) as Partial<AppSettings>;
    if (s.firstTo === 1 || s.firstTo === 2 || s.firstTo === 3) d.firstTo = s.firstTo;
    if (s.difficulty === 'easy' || s.difficulty === 'normal' || s.difficulty === 'hard') d.difficulty = s.difficulty;
    if (Array.isArray(s.devices) && s.devices.length === 2) d.devices = s.devices as AppSettings['devices'];
    if (Array.isArray(s.keys) && s.keys.length === 2 && s.keys.every(validKeys)) d.keys = s.keys as AppSettings['keys'];
    if (Array.isArray(s.pads) && s.pads.length === 2 && s.pads.every(validPads)) d.pads = s.pads as AppSettings['pads'];
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

export function saveSettings(s: AppSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // 保存できない環境（プライベートウィンドウ等）では保存しない
  }
}

export const deviceLabel = (d: DeviceChoice): string =>
  d.kind === 'keyboard' ? 'キーボード' : d.kind === 'gamepad' ? `ゲームパッド${d.index + 1}` : `CPU（${{ easy: '初級', normal: '中級', hard: '上級' }[d.level]}）`;

/** 機器の選択肢（設定画面で循環） */
export const DEVICE_CHOICES: readonly DeviceChoice[] = [
  { kind: 'keyboard' },
  { kind: 'gamepad', index: 0 },
  { kind: 'gamepad', index: 1 },
  { kind: 'gamepad', index: 2 },
  { kind: 'gamepad', index: 3 },
  { kind: 'cpu', level: 'easy' },
  { kind: 'cpu', level: 'normal' },
  { kind: 'cpu', level: 'hard' },
];

export const sameDevice = (a: DeviceChoice, b: DeviceChoice): boolean => JSON.stringify(a) === JSON.stringify(b);

export const isHuman = (d: DeviceChoice): boolean => d.kind !== 'cpu';

export type { PlayerId };
