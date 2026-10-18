// 設定画面（F2）：先取本数・自然上昇の難易度・各プレイヤーの使用機器・キー/ゲームパッド割当。
import { DIFFICULTY_LABEL, type Difficulty } from '../core/config';
import type { Action } from '../core/game';
import type { FirstTo } from '../core/match';
import type { PlayerId } from '../core/types';
import {
  ACTION_LABEL,
  ACTIONS,
  assignKey,
  keyName,
  padInputName,
  padPressed,
  type PadInput,
  type PadSource,
} from '../input/controller';
import { defaultSettings, DEVICE_CHOICES, deviceLabel, sameDevice, type AppSettings } from '../input/settings';

type Page = { kind: 'main' } | { kind: 'keys'; player: PlayerId } | { kind: 'pad'; player: PlayerId };

export type SettingsResult = 'none' | 'close' | 'startMatch';

const MAIN_ITEMS = ['firstTo', 'difficulty', 'dev0', 'dev1', 'keys0', 'keys1', 'pad0', 'pad1', 'reset', 'start'] as const;
type MainItem = (typeof MAIN_ITEMS)[number];

const DIFFS: Difficulty[] = ['easy', 'normal', 'hard'];

export class SettingsView {
  page: Page = { kind: 'main' };
  cursor = 0;
  /** キー／ボタン入力待ちの操作 */
  capturing: Action | null = null;
  message = '';
  private padBaseline: PadState | null = null;

  constructor(
    public settings: AppSettings,
    private readonly pads: PadSource,
  ) {}

  open(settings: AppSettings): void {
    this.settings = settings;
    this.page = { kind: 'main' };
    this.cursor = 0;
    this.capturing = null;
    this.message = '';
  }

  private rows(): number {
    return this.page.kind === 'main' ? MAIN_ITEMS.length : ACTIONS.length + 1;
  }

  /** キー入力を処理する。設定を閉じる／試合開始を返す */
  handleKey(code: string): SettingsResult {
    if (this.capturing) {
      if (code === 'Escape') {
        this.capturing = null;
        this.message = '取り消しました';
      } else if (this.page.kind === 'keys') {
        const ok = assignKey(this.settings.keys, this.page.player, this.capturing, code);
        this.message = ok ? `${ACTION_LABEL[this.capturing]} = ${keyName(code)}` : `${keyName(code)} は共通操作に予約されています`;
        this.capturing = null;
      }
      return 'none';
    }
    const n = this.rows();
    if (code === 'ArrowUp') this.cursor = (this.cursor + n - 1) % n;
    else if (code === 'ArrowDown') this.cursor = (this.cursor + 1) % n;
    else if (code === 'ArrowLeft' || code === 'ArrowRight') this.change(code === 'ArrowLeft' ? -1 : 1);
    else if (code === 'Enter' || code === 'Space') return this.decide();
    else if (code === 'Escape' || code === 'F2') {
      if (this.page.kind !== 'main') {
        this.page = { kind: 'main' };
        this.cursor = 0;
        return 'none';
      }
      return 'close';
    }
    return 'none';
  }

  private change(dir: number): void {
    if (this.page.kind !== 'main') return;
    const item: MainItem = MAIN_ITEMS[this.cursor];
    const s = this.settings;
    if (item === 'firstTo') s.firstTo = ((((s.firstTo - 1 + dir) % 3) + 3) % 3 + 1) as FirstTo;
    else if (item === 'difficulty') s.difficulty = DIFFS[(DIFFS.indexOf(s.difficulty) + dir + 3) % 3];
    else if (item === 'dev0' || item === 'dev1') {
      const p = item === 'dev0' ? 0 : 1;
      const i = DEVICE_CHOICES.findIndex((d) => sameDevice(d, s.devices[p]));
      s.devices[p] = { ...DEVICE_CHOICES[(i + dir + DEVICE_CHOICES.length) % DEVICE_CHOICES.length] };
    }
  }

  private decide(): SettingsResult {
    if (this.page.kind === 'main') {
      const item: MainItem = MAIN_ITEMS[this.cursor];
      if (item === 'keys0' || item === 'keys1') this.page = { kind: 'keys', player: item === 'keys0' ? 0 : 1 };
      else if (item === 'pad0' || item === 'pad1') this.page = { kind: 'pad', player: item === 'pad0' ? 0 : 1 };
      else if (item === 'reset') {
        this.settings = defaultSettings();
        this.message = '初期値に戻しました';
        return 'none';
      } else if (item === 'start') return 'startMatch';
      else {
        this.change(1);
        return 'none';
      }
      this.cursor = 0;
      return 'none';
    }
    if (this.cursor === ACTIONS.length) {
      this.page = { kind: 'main' };
      this.cursor = 0;
      return 'none';
    }
    this.capturing = ACTIONS[this.cursor];
    this.message = this.page.kind === 'keys' ? 'キーを押してください（Escで取消）' : 'ゲームパッドのボタンを押してください（Escで取消）';
    this.padBaseline = null;
    return 'none';
  }

  /** ゲームパッド割当の入力待ち中に毎フレーム呼ぶ */
  pollPad(): void {
    if (!this.capturing || this.page.kind !== 'pad') return;
    const player = this.page.player;
    const dev = this.settings.devices[player];
    const index = dev.kind === 'gamepad' ? dev.index : 0;
    const s = this.pads(index);
    if (!s) {
      this.message = `ゲームパッド${index + 1}が接続されていません（Escで取消）`;
      return;
    }
    const cur: PadState = { buttons: s.buttons.map((b) => ({ pressed: b.pressed })), axes: [...s.axes] };
    const base = this.padBaseline;
    this.padBaseline = cur;
    if (!base) return; // 押しっぱなしの入力を拾わないため、最初の1回は基準を取るだけ
    let found: PadInput | null = null;
    cur.buttons.forEach((b, i) => {
      if (!found && b.pressed && !base.buttons[i]?.pressed) found = { kind: 'button', index: i };
    });
    if (!found)
      cur.axes.forEach((v, i) => {
        const dir = v > 0 ? 1 : -1;
        const inp: PadInput = { kind: 'axis', index: i, dir };
        if (!found && padPressed(cur, inp) && !padPressed(base, inp)) found = inp;
      });
    if (!found) return;
    const pads = this.settings.pads[player];
    const key = JSON.stringify(found);
    for (const a of ACTIONS) pads[a] = pads[a].filter((x) => JSON.stringify(x) !== key);
    pads[this.capturing] = [found];
    this.message = `${ACTION_LABEL[this.capturing]} = ${padInputName(found)}`;
    this.capturing = null;
  }

  render(ctx: CanvasRenderingContext2D, padConnected: (index: number) => boolean): void {
    ctx.save();
    ctx.fillStyle = 'rgba(8,8,24,0.95)';
    ctx.fillRect(40, 20, 560, 320);
    ctx.font = '11px "Noto Sans CJK JP", "Yu Gothic", "Meiryo", sans-serif';
    ctx.textBaseline = 'top';
    let y = 30;
    const line = (s: string, selected = false, color = '#ffffff') => {
      if (selected) {
        ctx.fillStyle = '#2b4a8a';
        ctx.fillRect(52, y - 2, 536, 15);
      }
      ctx.fillStyle = color;
      ctx.fillText(s, 60, y);
      y += 16;
    };
    const s = this.settings;
    const dev = (p: PlayerId) => {
      const d = s.devices[p];
      return deviceLabel(d) + (d.kind === 'gamepad' && !padConnected(d.index) ? '（未接続）' : '');
    };
    if (this.page.kind === 'main') {
      line('設定（↑↓選択 ←→変更 Enter決定 Esc閉じる）', false, '#ffd060');
      y += 4;
      const labels: Record<MainItem, string> = {
        firstTo: `先取本数：${s.firstTo}本先取`,
        difficulty: `自然上昇の難易度：${DIFFICULTY_LABEL[s.difficulty]}`,
        dev0: `1P 使用機器：${dev(0)}`,
        dev1: `2P 使用機器：${dev(1)}`,
        keys0: '1P キー割当を変更…',
        keys1: '2P キー割当を変更…',
        pad0: '1P ゲームパッド割当を変更…',
        pad1: '2P ゲームパッド割当を変更…',
        reset: 'すべて初期値に戻す',
        start: 'この設定で新しい試合を開始',
      };
      MAIN_ITEMS.forEach((it, i) => line(labels[it], i === this.cursor));
      y += 6;
      line('※先取本数・難易度は「新しい試合を開始」で反映。機器・割当は閉じたときに反映', false, '#9aa4c0');
      line('※CPU難度（初級/中級/上級）は使用機器の選択肢から選びます', false, '#9aa4c0');
    } else {
      const p = this.page.player;
      const isKeys = this.page.kind === 'keys';
      line(`${p + 1}P ${isKeys ? 'キー' : 'ゲームパッド'}割当（Enterで変更 Escで戻る）`, false, '#ffd060');
      y += 4;
      ACTIONS.forEach((a, i) => {
        const v = isKeys ? s.keys[p][a].map(keyName).join(' / ') : s.pads[p][a].map(padInputName).join(' / ');
        line(`${ACTION_LABEL[a]}：${v || '（なし）'}${this.capturing === a ? '  ← 入力待ち' : ''}`, i === this.cursor);
      });
      line('戻る', this.cursor === ACTIONS.length);
      y += 6;
      line(isKeys ? '一時停止は Esc（共通）。F1〜F12・Enter・Tab は割当不可' : '一時停止は START（共通）', false, '#9aa4c0');
    }
    if (this.message) {
      y = 316;
      line(this.message, false, '#c0ffd0');
    }
    ctx.restore();
  }
}

type PadState = { buttons: Array<{ pressed: boolean }>; axes: number[] };
