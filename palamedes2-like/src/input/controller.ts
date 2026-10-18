// 1P/2P・将来のCPUが共通で使う入力窓口。
// CPUの戦略は未確定（G06）のため今回は実装しない。Controller を実装すれば差し込める。
import type { Action, Command, Game } from '../core/game';
import type { PlayerId } from '../core/types';

export interface Controller {
  readonly player: PlayerId;
  /** 次のtickで適用するコマンドを返す（呼ばれるたびに消費） */
  poll(game: Game): Command[];
}

/** キー割当（検証用のテスト設定。正式なキー割当は未確定 G06） */
export type KeyBindings = Record<Action, string[]>;

export const DEFAULT_BINDINGS: Record<PlayerId, KeyBindings> = {
  0: {
    left: ['KeyA'],
    right: ['KeyD'],
    launch: ['KeyW'],
    rotate: ['KeyS'],
    declare: ['KeyQ'],
    manualRise: ['KeyE'],
  },
  1: {
    left: ['ArrowLeft'],
    right: ['ArrowRight'],
    launch: ['ArrowUp'],
    rotate: ['ArrowDown'],
    declare: ['Slash', 'NumpadEnter'],
    manualRise: ['Period', 'Numpad0'],
  },
};

/** キーボード1系統分。keydown を次tickまでキューに積む */
export class KeyboardController implements Controller {
  private queue: Action[] = [];
  private readonly lookup = new Map<string, Action>();

  constructor(
    readonly player: PlayerId,
    bindings: KeyBindings = DEFAULT_BINDINGS[player],
  ) {
    for (const [action, codes] of Object.entries(bindings) as [Action, string[]][])
      for (const code of codes) this.lookup.set(code, action);
  }

  /** 処理したキーなら true */
  handleKey(code: string, repeat: boolean): boolean {
    const action = this.lookup.get(code);
    if (!action) return false;
    // キーリピートは左右移動のみ許可（他の操作の連打扱いは決めない）
    if (repeat && action !== 'left' && action !== 'right') return true;
    this.queue.push(action);
    return true;
  }

  poll(): Command[] {
    const out = this.queue.map((type) => ({ player: this.player, type }));
    this.queue = [];
    return out;
  }
}

/** テスト・自動検証用：tickを指定して入力を流す */
export class ScriptedController implements Controller {
  constructor(
    readonly player: PlayerId,
    private readonly script: ReadonlyMap<number, Command['type'][]>,
  ) {}

  poll(game: Game): Command[] {
    const actions = this.script.get(game.tick + 1) ?? [];
    return actions.map((type) =>
      type === 'debugAttack' ? { player: this.player, type, lines: 1 } : { player: this.player, type },
    );
  }
}
