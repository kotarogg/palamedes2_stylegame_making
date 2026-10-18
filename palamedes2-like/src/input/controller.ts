// 1P/2P・CPUが共通で使う入力窓口。キーボード・ゲームパッドとも割当変更可能（確定）。
import type { Action, Command, Game } from '../core/game';
import type { PlayerId } from '../core/types';

export interface Controller {
  readonly player: PlayerId;
  /** 次のtickで適用するコマンドを返す（呼ばれるたびに消費） */
  poll(game: Game): Command[];
}

export const ACTIONS: readonly Action[] = ['left', 'right', 'launch', 'rotate', 'declare', 'manualRise'];

export const ACTION_LABEL: Record<Action, string> = {
  left: '左移動',
  right: '右移動',
  launch: '発射',
  rotate: 'B入れ替え',
  declare: '役宣言',
  manualRise: '手動上昇',
};

export type KeyBindings = Record<Action, string[]>;

/** 初期割当（確定）。一時停止は Esc 共通（キーボード）・START（ゲームパッド） */
export const DEFAULT_KEY_BINDINGS: Record<PlayerId, KeyBindings> = {
  0: {
    left: ['KeyA'],
    right: ['KeyD'],
    launch: ['KeyF'],
    rotate: ['KeyG'],
    declare: ['KeyH'],
    manualRise: ['KeyW'],
  },
  1: {
    left: ['ArrowLeft'],
    right: ['ArrowRight'],
    launch: ['Comma'],
    rotate: ['Period'],
    declare: ['Slash'],
    manualRise: ['ArrowUp'],
  },
};

/** 割当に使えないキー（共通操作に予約） */
export const RESERVED_KEYS: ReadonlySet<string> = new Set([
  'Escape',
  'Enter',
  'NumpadEnter',
  'Tab',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
]);

export type PadInput = { kind: 'button'; index: number } | { kind: 'axis'; index: number; dir: -1 | 1 };
export type PadBindings = Record<Action, PadInput[]>;

/** 標準マッピング：0=A 1=B 2=X 3=Y 4=LB 5=RB 9=START 12〜15=十字キー上下左右、軸0=左スティック左右 */
export const DEFAULT_PAD_BINDINGS: PadBindings = {
  left: [
    { kind: 'button', index: 14 },
    { kind: 'axis', index: 0, dir: -1 },
  ],
  right: [
    { kind: 'button', index: 15 },
    { kind: 'axis', index: 0, dir: 1 },
  ],
  launch: [{ kind: 'button', index: 0 }],
  rotate: [{ kind: 'button', index: 1 }],
  declare: [{ kind: 'button', index: 2 }],
  manualRise: [{ kind: 'button', index: 5 }],
};

export const PAD_START = 9;
export const PAD_CONFIRM = 0;

const KEY_LABEL: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Slash: '/',
  Period: '.',
  Comma: ',',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Space: 'Space',
  Backquote: '`',
};
export const keyName = (c: string): string => KEY_LABEL[c] ?? c.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'テンキー');

const PAD_BUTTON_LABEL: Record<number, string> = {
  0: 'A',
  1: 'B',
  2: 'X',
  3: 'Y',
  4: 'LB',
  5: 'RB',
  6: 'LT',
  7: 'RT',
  8: 'BACK',
  9: 'START',
  10: 'LS',
  11: 'RS',
  12: '十字↑',
  13: '十字↓',
  14: '十字←',
  15: '十字→',
};
export const padInputName = (i: PadInput): string =>
  i.kind === 'button' ? (PAD_BUTTON_LABEL[i.index] ?? `ボタン${i.index}`) : `スティック${i.index}${i.dir < 0 ? '−' : '＋'}`;

export function cloneKeyBindings(b: KeyBindings): KeyBindings {
  return Object.fromEntries(ACTIONS.map((a) => [a, [...b[a]]])) as KeyBindings;
}

export function clonePadBindings(b: PadBindings): PadBindings {
  return Object.fromEntries(ACTIONS.map((a) => [a, b[a].map((x) => ({ ...x }))])) as PadBindings;
}

/**
 * キー割当の変更。同じキーが他の操作（両プレイヤー）に割り当たっていれば外し、重複させない。
 * 予約キーは割り当てない（false を返す）。
 */
export function assignKey(all: KeyBindings[], player: PlayerId, action: Action, code: string): boolean {
  if (RESERVED_KEYS.has(code)) return false;
  for (const b of all) for (const a of ACTIONS) b[a] = b[a].filter((c) => c !== code);
  all[player][action] = [code];
  return true;
}

/** キーボード1系統分。keydown を次tickまでキューに積む */
export class KeyboardController implements Controller {
  private queue: Action[] = [];
  private lookup = new Map<string, Action>();

  constructor(
    readonly player: PlayerId,
    bindings: KeyBindings = DEFAULT_KEY_BINDINGS[player],
  ) {
    this.setBindings(bindings);
  }

  setBindings(bindings: KeyBindings): void {
    this.lookup = new Map();
    for (const a of ACTIONS) for (const code of bindings[a]) this.lookup.set(code, a);
  }

  /** このキーがこの系統の操作なら、その操作 */
  actionOf(code: string): Action | undefined {
    return this.lookup.get(code);
  }

  /** 処理したキーなら true */
  handleKey(code: string, repeat: boolean): boolean {
    const action = this.lookup.get(code);
    if (!action) return false;
    // キーリピートは左右移動のみ（他の操作は押すたびに1回）
    if (repeat && action !== 'left' && action !== 'right') return true;
    this.queue.push(action);
    return true;
  }

  clear(): void {
    this.queue = [];
  }

  poll(): Command[] {
    const out = this.queue.map((type) => ({ player: this.player, type }));
    this.queue = [];
    return out;
  }
}

/** navigator.getGamepads() の最小限の形（テストで差し替え可能） */
export interface PadState {
  buttons: ReadonlyArray<{ pressed: boolean }>;
  axes: ReadonlyArray<number>;
}
export type PadSource = (index: number) => PadState | null;

export const browserPads: PadSource = (index) => {
  const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
  return (pads[index] as PadState | null | undefined) ?? null;
};

const AXIS_THRESHOLD = 0.5;

export const padPressed = (s: PadState, i: PadInput): boolean =>
  i.kind === 'button' ? !!s.buttons[i.index]?.pressed : (s.axes[i.index] ?? 0) * i.dir > AXIS_THRESHOLD;

/** ゲームパッド1台分。押した瞬間に1回。左右は押し続けでリピート（初回250ms→以後100ms、テスト用初期値） */
export class GamepadController implements Controller {
  private prev = new Map<Action, boolean>();
  private holdStart = new Map<Action, number>();
  private lastRepeat = new Map<Action, number>();
  private prevStart = false;
  private prevConfirm = false;
  /** START を押した（一時停止要求） */
  startPressed = false;
  /** A を押した（勝敗表示中の決定入力に使う） */
  confirmPressed = false;
  repeatDelayMs = 250;
  repeatMs = 100;

  constructor(
    readonly player: PlayerId,
    readonly padIndex: number,
    private bindings: PadBindings = DEFAULT_PAD_BINDINGS,
    private readonly source: PadSource = browserPads,
    private readonly now: () => number = () => performance.now(),
  ) {}

  setBindings(b: PadBindings): void {
    this.bindings = b;
  }

  get connected(): boolean {
    return this.source(this.padIndex) !== null;
  }

  poll(): Command[] {
    const s = this.source(this.padIndex);
    const out: Command[] = [];
    if (!s) return out;
    const t = this.now();
    const start = !!s.buttons[PAD_START]?.pressed;
    if (start && !this.prevStart) this.startPressed = true;
    this.prevStart = start;
    const confirm = !!s.buttons[PAD_CONFIRM]?.pressed;
    if (confirm && !this.prevConfirm) this.confirmPressed = true;
    this.prevConfirm = confirm;
    for (const a of ACTIONS) {
      const down = this.bindings[a].some((i) => padPressed(s, i));
      const was = this.prev.get(a) ?? false;
      if (down && !was) {
        out.push({ player: this.player, type: a });
        this.holdStart.set(a, t);
        this.lastRepeat.set(a, t);
      } else if (down && (a === 'left' || a === 'right')) {
        const hs = this.holdStart.get(a) ?? t;
        if (t - hs >= this.repeatDelayMs && t - (this.lastRepeat.get(a) ?? t) >= this.repeatMs) {
          out.push({ player: this.player, type: a });
          this.lastRepeat.set(a, t);
        }
      }
      this.prev.set(a, down);
    }
    return out;
  }
}

/** テスト・自動検証用：tickを指定して入力を流す */
export class ScriptedController implements Controller {
  constructor(
    readonly player: PlayerId,
    private readonly script: ReadonlyMap<number, Action[]>,
  ) {}

  poll(game: Game): Command[] {
    return (this.script.get(game.tick + 1) ?? []).map((type) => ({ player: this.player, type }));
  }
}
