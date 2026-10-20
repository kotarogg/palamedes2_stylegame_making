// メニュー操作の入力（キーボード・ゲームパッド共通）。押した瞬間だけを1回の操作にする（押しっぱなしで連続決定しない）。
// 上下左右は押し続けでリピート（初回350ms→以後110ms。調整用初期値）。決定・戻るはリピートしない。
// パッド：十字キー／左スティック＝移動、A＝決定、B＝戻る、START＝プレイ中の終了確認。
import { browserPads, type PadSource } from '../input/controller';

export type NavKey = 'up' | 'down' | 'left' | 'right' | 'confirm' | 'back' | 'start';

export type NavSource = { kind: 'keyboard' } | { kind: 'pad'; index: number };

export interface NavEvent {
  key: NavKey;
  source: NavSource;
  /** キーボードのキーコード */
  code?: string;
  repeat: boolean;
}

const KEY_NAV: Record<string, NavKey> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Enter: 'confirm',
  NumpadEnter: 'confirm',
  Space: 'confirm',
  Escape: 'back',
  Backspace: 'back',
};

const PAD_COUNT = 4;
const AXIS = 0.5;

export class MenuInput {
  private queue: NavEvent[] = [];
  private prev = new Map<string, boolean>();
  private holdStart = new Map<string, number>();
  private lastRepeat = new Map<string, number>();
  repeatDelayMs = 350;
  repeatMs = 110;

  constructor(
    private readonly pads: PadSource = browserPads,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** keydown を受け取る。メニュー操作として扱ったら true */
  onKey(code: string, repeat: boolean): boolean {
    const key = KEY_NAV[code];
    if (!key) return false;
    if (repeat && (key === 'confirm' || key === 'back')) return true; // 長押しの連続決定を防ぐ
    this.queue.push({ key, source: { kind: 'keyboard' }, code, repeat });
    return true;
  }

  /** 毎フレーム呼ぶ。ゲームパッドの押下変化を操作へ変換 */
  pollPads(): void {
    const t = this.now();
    for (let i = 0; i < PAD_COUNT; i++) {
      const s = this.pads(i);
      if (!s) continue;
      const btn = (n: number) => !!s.buttons[n]?.pressed;
      const ax = (n: number) => s.axes[n] ?? 0;
      const state: Record<NavKey, boolean> = {
        up: btn(12) || ax(1) < -AXIS,
        down: btn(13) || ax(1) > AXIS,
        left: btn(14) || ax(0) < -AXIS,
        right: btn(15) || ax(0) > AXIS,
        confirm: btn(0),
        back: btn(1),
        start: btn(9),
      };
      for (const k of Object.keys(state) as NavKey[]) {
        const id = `${i}:${k}`;
        const down = state[k];
        const was = this.prev.get(id) ?? false;
        if (down && !was) {
          this.queue.push({ key: k, source: { kind: 'pad', index: i }, repeat: false });
          this.holdStart.set(id, t);
          this.lastRepeat.set(id, t);
        } else if (down && (k === 'up' || k === 'down' || k === 'left' || k === 'right')) {
          if (t - (this.holdStart.get(id) ?? t) >= this.repeatDelayMs && t - (this.lastRepeat.get(id) ?? t) >= this.repeatMs) {
            this.queue.push({ key: k, source: { kind: 'pad', index: i }, repeat: true });
            this.lastRepeat.set(id, t);
          }
        }
        this.prev.set(id, down);
      }
    }
  }

  drain(): NavEvent[] {
    const q = this.queue;
    this.queue = [];
    return q;
  }

  /** 画面遷移時：その時点の押下を「押しっぱなし」として扱い、離すまで次の操作にしない */
  clear(): void {
    this.queue = [];
  }
}
