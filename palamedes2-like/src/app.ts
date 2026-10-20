// 画面遷移と入力の統合：起動→メインメニュー→（MODE1／MODE2 × シングル／CPU対戦／2P対戦、オプション、遊び方）→試合→結果→再戦／メニュー。
// 一時停止は無い。プレイ中の Esc／START は「試合を終了してメニューへ戻る」確認で、確認中もゲームは進む（そのプレイヤーの入力だけがダイアログへ）。
import type { AudioBus } from './audio/audioBus';
import { PLAYER_CHARACTER, type BgmId, type Character } from './audio/audioMap';
import { SoundDirector } from './audio/director';
import { DIFFICULTY_LABEL, type Difficulty } from './core/config';
import { FixedStepDriver } from './core/driver';
import type { Command, Game } from './core/game';
import { Match, SingleSession, type AnyGame, type FirstTo, type GameMode, type SingleMode } from './core/match';
import type { Mode2Game } from './core/mode2';
import type { PlayerId } from './core/types';
import {
  ACTION_LABEL,
  ACTIONS,
  assignKey,
  cloneKeyBindings,
  clonePadBindings,
  DEFAULT_KEY_BINDINGS,
  DEFAULT_PAD_BINDINGS,
  GamepadController,
  keyName,
  KeyboardController,
  padInputName,
  padPressed,
  type Controller,
  type PadInput,
  type PadSource,
  type PadState,
} from './input/controller';
import { CpuController } from './input/cpu';
import { defaultSettings, DEVICE_CHOICES, deviceLabel, sameDevice, saveSettings, type AppSettings, type DeviceChoice, type DisplayScale } from './input/settings';
import { MenuInput, type NavEvent, type NavKey } from './ui/menuInput';
import { loadRecords, saveRecords, submitEndless, submitMode2, submitStage, type Records } from './ui/records';
import { drawBackground, drawConfirm, drawFooter, drawMenuCharacters, drawMenuItems, drawOptionPanel, drawResultPanel, type OptionRow } from './ui/screens';
import type { Assets } from './view/assets';
import { GameView } from './view/gameView';
import { readyDurationMs, Staging } from './view/presentation';
import { drawPanel, drawText, formatTime } from './view/text';

export const W = 640;
export const H = 360;

interface Scene {
  /** キー入力（生のキーコード）。メニュー操作として使う場合は MenuInput 経由の onNav を使う */
  onKey?(code: string, repeat: boolean): boolean;
  onNav(ev: NavEvent): void;
  update(dtMs: number): void;
  render(ctx: CanvasRenderingContext2D, ms: number): void;
  /** true：キーボードを MenuInput に渡さず onKey で直接受け取る */
  readonly rawKeys?: boolean;
}

export interface AppDeps {
  assets: Assets;
  bus: AudioBus;
  pads: PadSource;
  settings: AppSettings;
  /** 表示倍率・全画面の適用（main が実装） */
  applyDisplay: (s: AppSettings['display']) => void;
  requestFullscreen: (on: boolean) => void;
  dev: boolean;
}

export class App {
  settings: AppSettings;
  records: Records = loadRecords();
  scene: Scene;
  readonly menuInput: MenuInput;
  settingsSaved = true;

  constructor(readonly deps: AppDeps) {
    this.settings = deps.settings;
    this.menuInput = new MenuInput(deps.pads);
    deps.bus.setVolumes(this.settings.audio);
    this.scene = new MenuScene(this);
  }

  get assets(): Assets {
    return this.deps.assets;
  }

  get bus(): AudioBus {
    return this.deps.bus;
  }

  setScene(s: Scene): void {
    this.scene = s;
    this.menuInput.clear();
  }

  toMenu(): void {
    this.bus.stopEffects();
    this.bus.playBgm('menu');
    this.setScene(new MenuScene(this));
  }

  saveSettings(): void {
    this.settingsSaved = saveSettings(this.settings);
    this.bus.setVolumes(this.settings.audio);
  }

  onKey(code: string, repeat: boolean): boolean {
    void this.bus.unlock();
    if (this.scene.rawKeys && this.scene.onKey) return this.scene.onKey(code, repeat);
    if (this.scene.onKey && this.scene.onKey(code, repeat)) return true;
    return this.menuInput.onKey(code, repeat);
  }

  private padHeld = false;

  /**
   * ゲームパッドのボタンを押した瞬間にも音声の有効化を試みる（キー・クリックと同じ unlock）。
   * 押しっぱなしで毎フレーム呼ばない。ブラウザがパッド操作を再生許可の操作と認めない場合は、
   * AudioContext が suspended のまま残るので、画面上部の案内でキー／クリックを促す。
   */
  private pollPadActivation(): void {
    if (this.bus.unlocked) return;
    let any = false;
    for (let i = 0; i < 4 && !any; i++) any = !!this.deps.pads(i)?.buttons.some((b) => b?.pressed);
    if (any && !this.padHeld) void this.bus.unlock();
    this.padHeld = any;
  }

  frame(dtMs: number, ms: number, ctx: CanvasRenderingContext2D): void {
    this.pollPadActivation();
    this.menuInput.pollPads();
    for (const ev of this.menuInput.drain()) this.scene.onNav(ev);
    this.scene.update(dtMs);
    this.scene.render(ctx, ms);
    if (!this.bus.unlocked) {
      // 未試行＝最初の操作待ち。試行済みで止まっている＝ブラウザが再生を許可していない（パッド操作は許可対象外のブラウザがある）
      const msg = this.bus.unlockAttempted && this.bus.ctx
        ? 'ブラウザが音の再生を止めています。キーを1回押すか、画面をクリックしてください'
        : '最初の操作で音が出ます（キー・クリック・ゲームパッド）';
      drawText(ctx, msg, 320, 6, { align: 'center', size: 9, color: '#ffe0a0', box: true });
    }
  }

  // ---- 試合開始 ----

  startGame(mode: GameMode, kind: 'single' | 'cpu' | '2p', singleMode?: SingleMode): void {
    this.bus.stopEffects();
    this.setScene(new GameScene(this, mode, kind, singleMode));
  }
}

// ---------------------------------------------------------------- メインメニュー

interface MenuItem {
  label: string;
  desc: string;
  children?: MenuItem[];
  run?: () => void;
}

class MenuScene implements Scene {
  private stack: { title: string; items: MenuItem[]; cursor: number }[];

  constructor(private readonly app: App) {
    const a = app;
    const root: MenuItem[] = [
      {
        label: 'MODE1',
        desc: '役をそろえてラインを消す。対戦では攻撃を送り合う',
        children: [
          {
            label: 'シングル',
            desc: '1人で遊ぶ（コタロー）',
            children: [
              { label: 'ひたすら', desc: 'Lv1〜20。消去数でLvが上がり、自然上昇が速くなる', run: () => a.startGame('mode1', 'single', 'endless') },
              { label: 'ステージクリア', desc: '全10ステージ。各ステージの消去ノルマを達成する', run: () => a.startGame('mode1', 'single', 'stage') },
            ],
          },
          { label: 'CPU対戦', desc: 'NPCと対戦（強さ・先取本数はオプション）', run: () => a.startGame('mode1', 'cpu') },
          { label: '2P対戦', desc: '1台のPCで2人対戦', run: () => a.startGame('mode1', '2p') },
        ],
      },
      {
        label: 'MODE2',
        desc: '場のカードへ出せるピースを打ち上げ、先に盤面を空にする',
        children: [
          { label: 'シングル', desc: '盤面を空にするまでのタイムを競う', run: () => a.startGame('mode2', 'single', 'mode2') },
          { label: 'CPU対戦', desc: 'NPCと対戦', run: () => a.startGame('mode2', 'cpu') },
          { label: '2P対戦', desc: '1台のPCで2人対戦', run: () => a.startGame('mode2', '2p') },
        ],
      },
      { label: 'オプション', desc: '音・操作・対戦・表示の設定', run: () => a.setScene(new OptionsScene(a)) },
      { label: '遊び方', desc: '操作とルールの説明', run: () => a.setScene(new HelpScene(a)) },
    ];
    this.stack = [{ title: 'メインメニュー', items: root, cursor: 0 }];
    app.bus.playBgm('menu');
  }

  private get top() {
    return this.stack[this.stack.length - 1];
  }

  onNav(ev: NavEvent): void {
    const t = this.top;
    const bus = this.app.bus;
    switch (ev.key) {
      case 'up':
      case 'down': {
        const n = t.items.length;
        const next = (t.cursor + (ev.key === 'up' ? n - 1 : 1)) % n;
        if (next !== t.cursor) bus.playSfx('ui_move');
        t.cursor = next;
        return;
      }
      case 'confirm': {
        const it = t.items[t.cursor];
        bus.playSfx('ui_confirm');
        if (it.children) this.stack.push({ title: `${t.title === 'メインメニュー' ? '' : `${t.title} › `}${it.label}`, items: it.children, cursor: 0 });
        else it.run?.();
        return;
      }
      case 'back':
        if (this.stack.length > 1) {
          this.stack.pop();
          bus.playSfx('ui_cancel');
        }
        return;
      default:
        return;
    }
  }

  update(): void {}

  render(ctx: CanvasRenderingContext2D, ms: number): void {
    const A = this.app.assets;
    drawBackground(ctx, A);
    drawMenuCharacters(ctx, A, ms);
    const t = this.top;
    drawText(ctx, t.title, 320, 70, { align: 'center', size: 13, bold: true, color: '#fff3c8' });
    drawMenuItems(ctx, A, t.items.map((i) => i.label), t.cursor);
    drawText(ctx, t.items[t.cursor].desc, 320, 290, { align: 'center', size: 10, color: '#e8ecff', box: true, maxWidth: 420 });
    const r = this.app.records;
    if (t.title.endsWith('シングル')) {
      const best: string[] = [];
      if (t.title.startsWith('MODE1')) {
        if (r.endless) best.push(`ひたすら ベスト ${r.endless.score.toLocaleString('ja-JP')}点（Lv${r.endless.level}）`);
        if (r.stage) best.push(`ステージ ベスト ${r.stage.score.toLocaleString('ja-JP')}点（最高${r.stage.maxStage}面${r.stage.completed ? '・完走' : ''}）`);
      } else if (r.mode2Single) best.push(`最短クリア ${formatTime(r.mode2Single.bestMs)}`);
      best.forEach((b, i) => drawText(ctx, b, 320, 200 + i * 14, { align: 'center', size: 10, color: '#c0ffd0', box: true }));
    }
    drawFooter(ctx, A);
  }
}

// ---------------------------------------------------------------- オプション

type OptPage = 'top' | 'audio' | 'controls' | 'match' | 'display' | 'keys0' | 'keys1' | 'pads0' | 'pads1';

interface OptRowDef extends OptionRow {
  change?: (dir: -1 | 1) => void;
  confirm?: () => void;
}

const DIFFS: Difficulty[] = ['easy', 'normal', 'hard'];
const cycle = <T>(arr: readonly T[], cur: T, dir: number, eq: (a: T, b: T) => boolean = (a, b) => a === b): T => {
  const i = Math.max(0, arr.findIndex((x) => eq(x, cur)));
  return arr[(i + dir + arr.length) % arr.length];
};

class OptionsScene implements Scene {
  page: OptPage = 'top';
  cursor = 0;
  message = '';
  confirmReset: number | null = null;
  /** 割当の入力待ち */
  capturing: { player: PlayerId; action: (typeof ACTIONS)[number]; pad: boolean; baseline: PadState | null } | null = null;
  readonly rawKeys = false;

  constructor(private readonly app: App) {}

  private get s(): AppSettings {
    return this.app.settings;
  }

  private changed(sfx: 'ui_adjust' | 'ui_confirm' = 'ui_adjust'): void {
    this.app.saveSettings();
    this.app.bus.playSfx(sfx);
    if (!this.app.settingsSaved) this.message = 'このブラウザでは設定を保存できません（今回の起動中だけ有効）';
  }

  rows(): OptRowDef[] {
    const s = this.s;
    const back: OptRowDef = { label: '戻る', confirm: () => this.go(this.page.startsWith('keys') || this.page.startsWith('pads') ? 'controls' : 'top') };
    switch (this.page) {
      case 'top':
        return [
          { label: '音', note: 'BGM・効果音・ボイスの音量とミュート', confirm: () => this.go('audio') },
          { label: '操作', note: '1P/2Pの入力機器とキー・ゲームパッドの割当', confirm: () => this.go('controls') },
          { label: '対戦', note: '先取本数・自然上昇の速さ・NPCの強さ', confirm: () => this.go('match') },
          { label: '表示', note: '画面倍率と全画面', confirm: () => this.go('display') },
          { label: '設定初期化', note: 'すべての設定を初期値に戻します（記録は消えません）', confirm: () => (this.confirmReset = 0) },
          { label: 'メニューへ戻る', confirm: () => this.app.toMenu() },
        ];
      case 'audio': {
        const a = s.audio;
        const slider = (label: string, key: 'bgm' | 'sfx' | 'voice'): OptRowDef => ({
          label,
          slider: a[key],
          value: String(a[key]),
          note: '←→で10ずつ。100＝素材そのままの音量',
          change: (d) => {
            a[key] = Math.max(0, Math.min(100, a[key] + 10 * d));
            this.changed();
          },
        });
        const mute = (label: string, key: 'bgmMute' | 'sfxMute' | 'voiceMute'): OptRowDef => ({
          label,
          value: a[key] ? 'ミュート' : '鳴らす',
          arrows: true,
          change: () => {
            a[key] = !a[key];
            this.changed();
          },
          confirm: () => {
            a[key] = !a[key];
            this.changed();
          },
        });
        return [slider('BGM', 'bgm'), slider('効果音', 'sfx'), slider('ボイス', 'voice'), mute('BGM', 'bgmMute'), mute('効果音', 'sfxMute'), mute('ボイス', 'voiceMute'), back];
      }
      case 'controls': {
        const dev = (p: PlayerId): OptRowDef => ({
          label: `${p + 1}P 入力機器`,
          value: deviceLabel(s.devices[p]) + (s.devices[p].kind === 'gamepad' && !this.app.deps.pads((s.devices[p] as { index: number }).index) ? '（未接続）' : ''),
          arrows: true,
          note: 'CPU対戦では2PがNPCになります',
          change: (d) => {
            s.devices[p] = { ...cycle<DeviceChoice>(DEVICE_CHOICES, s.devices[p], d, sameDevice) };
            this.changed();
          },
        });
        return [
          dev(0),
          dev(1),
          { label: '1P キー割当', note: 'Enterで変更画面へ', confirm: () => this.go('keys0') },
          { label: '2P キー割当', note: 'Enterで変更画面へ', confirm: () => this.go('keys1') },
          { label: '1P ゲームパッド割当', confirm: () => this.go('pads0') },
          { label: '2P ゲームパッド割当', confirm: () => this.go('pads1') },
          {
            label: '割当を初期値に戻す',
            note: 'キーとゲームパッドの割当を両プレイヤーとも初期値へ',
            confirm: () => {
              s.keys = [cloneKeyBindings(DEFAULT_KEY_BINDINGS[0]), cloneKeyBindings(DEFAULT_KEY_BINDINGS[1])];
              s.pads = [clonePadBindings(DEFAULT_PAD_BINDINGS), clonePadBindings(DEFAULT_PAD_BINDINGS)];
              this.message = '割当を初期値に戻しました';
              this.changed('ui_confirm');
            },
          },
          back,
        ];
      }
      case 'keys0':
      case 'keys1':
      case 'pads0':
      case 'pads1': {
        const p = Number(this.page.slice(-1)) as PlayerId;
        const pad = this.page.startsWith('pads');
        return [
          ...ACTIONS.map(
            (act): OptRowDef => ({
              label: ACTION_LABEL[act],
              value:
                this.capturing && this.capturing.action === act
                  ? '入力待ち…'
                  : (pad ? s.pads[p][act].map(padInputName) : s.keys[p][act].map(keyName)).join(' / ') || '（なし）',
              note: pad ? '決定後、割り当てるボタンを押す（Escで取消）' : '決定後、割り当てるキーを押す（Escで取消）',
              confirm: () => {
                this.capturing = { player: p, action: act, pad, baseline: null };
                this.message = pad ? 'ゲームパッドのボタンを押してください' : 'キーを押してください';
              },
            }),
          ),
          back,
        ];
      }
      case 'match':
        return [
          {
            label: '先取本数',
            value: `${s.firstTo}本先取`,
            arrows: true,
            change: (d) => {
              s.firstTo = (((s.firstTo - 1 + d + 3) % 3) + 1) as FirstTo;
              this.changed();
            },
          },
          {
            label: '自然上昇',
            value: `${DIFFICULTY_LABEL[s.difficulty]}（${{ easy: 7, normal: 5, hard: 3 }[s.difficulty]}秒）`,
            arrows: true,
            note: '対戦の自然上昇の周期。シングルはステージ・Lvで決まります',
            change: (d) => {
              s.difficulty = cycle(DIFFS, s.difficulty, d);
              this.changed();
            },
          },
          {
            label: 'NPCの強さ',
            value: DIFFICULTY_LABEL[s.npcLevel],
            arrows: true,
            change: (d) => {
              s.npcLevel = cycle(DIFFS, s.npcLevel, d);
              this.changed();
            },
          },
          back,
        ];
      case 'display':
        return [
          {
            label: '画面倍率',
            value: s.display.scale === 0 ? '自動（収まる最大）' : `${s.display.scale}倍`,
            arrows: true,
            note: '画面に収まらない倍率は、収まる最大の整数倍で表示します',
            change: (d) => {
              s.display.scale = cycle<DisplayScale>([0, 1, 2, 3, 4], s.display.scale, d);
              this.app.deps.applyDisplay(s.display);
              this.changed();
            },
          },
          {
            label: '全画面',
            value: s.display.fullscreen ? 'オン' : 'オフ',
            arrows: true,
            note: 'キーボードかマウスで切り替えてください（ブラウザの制限）',
            change: () => this.toggleFullscreen(),
            confirm: () => this.toggleFullscreen(),
          },
          back,
        ];
    }
  }

  private toggleFullscreen(): void {
    this.s.display.fullscreen = !this.s.display.fullscreen;
    this.app.deps.requestFullscreen(this.s.display.fullscreen);
    this.changed();
  }

  private go(p: OptPage): void {
    this.page = p;
    this.cursor = 0;
    this.message = '';
    this.capturing = null;
  }

  onKey(code: string): boolean {
    const c = this.capturing;
    if (!c) return false;
    if (code === 'Escape') {
      this.capturing = null;
      this.message = '取り消しました';
      this.app.bus.playSfx('ui_cancel');
      return true;
    }
    if (c.pad) return true; // パッドの割当中はキーボードを使わない（Escの取消のみ）
    const ok = assignKey(this.s.keys, c.player, c.action, code);
    this.capturing = null;
    if (ok) {
      this.message = `${ACTION_LABEL[c.action]} = ${keyName(code)}`;
      this.changed('ui_confirm');
    } else {
      this.message = `${keyName(code)} は共通操作に予約されています`;
      this.app.bus.playSfx('ui_invalid');
    }
    return true;
  }

  onNav(ev: NavEvent): void {
    if (this.capturing) {
      if (!this.capturing.pad && ev.source.kind === 'pad' && ev.key === 'back') {
        this.capturing = null;
        this.message = '取り消しました';
      }
      return;
    }
    const bus = this.app.bus;
    if (this.confirmReset !== null) {
      if (ev.key === 'left' || ev.key === 'right') {
        this.confirmReset = 1 - this.confirmReset;
        bus.playSfx('ui_move');
      } else if (ev.key === 'back') {
        this.confirmReset = null;
        bus.playSfx('ui_cancel');
      } else if (ev.key === 'confirm') {
        if (this.confirmReset === 1) {
          this.app.settings = defaultSettings();
          this.app.deps.applyDisplay(this.app.settings.display);
          this.message = '設定を初期値に戻しました';
          this.changed('ui_confirm');
        } else bus.playSfx('ui_cancel');
        this.confirmReset = null;
      }
      return;
    }
    const rows = this.rows();
    switch (ev.key) {
      case 'up':
      case 'down': {
        const n = rows.length;
        const next = (this.cursor + (ev.key === 'up' ? n - 1 : 1)) % n;
        if (next !== this.cursor) bus.playSfx('ui_move');
        this.cursor = next;
        return;
      }
      case 'left':
      case 'right':
        rows[this.cursor].change?.(ev.key === 'left' ? -1 : 1);
        return;
      case 'confirm': {
        const r = rows[this.cursor];
        if (r.confirm) {
          if (!r.change) bus.playSfx('ui_confirm');
          r.confirm();
        } else if (r.change) r.change(1);
        return;
      }
      case 'back':
        bus.playSfx('ui_cancel');
        if (this.page === 'top') this.app.toMenu();
        else this.go(this.page.startsWith('keys') || this.page.startsWith('pads') ? 'controls' : 'top');
        return;
      default:
        return;
    }
  }

  update(): void {
    const c = this.capturing;
    if (!c || !c.pad) return;
    const dev = this.s.devices[c.player];
    const index = dev.kind === 'gamepad' ? dev.index : 0;
    const st = this.app.deps.pads(index);
    if (!st) {
      this.message = `ゲームパッド${index + 1}が接続されていません（Escで取消）`;
      return;
    }
    const cur: PadState = { buttons: st.buttons.map((b) => ({ pressed: b.pressed })), axes: [...st.axes] };
    const base = c.baseline;
    c.baseline = cur;
    if (!base) return;
    let found: PadInput | null = null;
    cur.buttons.forEach((b, i) => {
      if (!found && b.pressed && !base.buttons[i]?.pressed && i !== 9) found = { kind: 'button', index: i };
    });
    if (!found)
      cur.axes.forEach((v, i) => {
        const inp: PadInput = { kind: 'axis', index: i, dir: v > 0 ? 1 : -1 };
        if (!found && padPressed(cur, inp) && !padPressed(base, inp)) found = inp;
      });
    if (!found) return;
    const pads = this.s.pads[c.player];
    const key = JSON.stringify(found);
    for (const a of ACTIONS) pads[a] = pads[a].filter((x) => JSON.stringify(x) !== key);
    pads[c.action] = [found];
    this.message = `${ACTION_LABEL[c.action]} = ${padInputName(found)}`;
    this.capturing = null;
    this.changed('ui_confirm');
  }

  render(ctx: CanvasRenderingContext2D): void {
    const A = this.app.assets;
    drawBackground(ctx, A);
    const titles: Record<OptPage, string> = {
      top: 'オプション',
      audio: 'オプション：音',
      controls: 'オプション：操作',
      match: 'オプション：対戦',
      display: 'オプション：表示',
      keys0: '1P キー割当',
      keys1: '2P キー割当',
      pads0: '1P ゲームパッド割当',
      pads1: '2P ゲームパッド割当',
    };
    const extra = this.page.startsWith('keys') ? '（Esc・Enter・Tab・F1〜F12 は割当できません）' : '';
    drawOptionPanel(ctx, A, titles[this.page], this.rows(), this.cursor, this.message || extra);
    if (this.confirmReset !== null) drawConfirm(ctx, A, '設定を初期値に戻しますか？', ['いいえ', 'はい'], this.confirmReset);
    drawFooter(ctx, A);
  }
}

// ---------------------------------------------------------------- 遊び方

const HELP_PAGES: { title: string; lines: string[] }[] = [
  {
    title: '操作（初期割当）',
    lines: [
      '1P：A/D 移動　F 発射　G B入れ替え　H 役宣言　W 手動上昇',
      '2P：←/→ 移動　, 発射　. B入れ替え　/ 役宣言　↑ 手動上昇',
      'ゲームパッド：十字キー/左スティック 移動　A 発射　B 入れ替え',
      '　　　　　　　X 役宣言　RB 手動上昇',
      'メニュー：十字キー・矢印で選択、A/Enterで決定、B/Escで戻る',
      'プレイ中の Esc／START：試合を終了してメニューへ戻る確認',
      '（確認中もゲームは止まりません）',
      '割当はオプションの「操作」で変更できます',
    ],
  },
  {
    title: 'MODE1 のルール',
    lines: [
      '自分の列の一番上のピースを、中央の場のカードへ打ち上げる',
      '同じ数字・となりの数字（1と6もとなり）・同じマークなら成功',
      '成功したピースは役ストック（最大6個）へ。役ができると光る',
      '光っている間に役宣言：合計翻数ぶんラインを上から消す',
      '対戦では攻撃を送る。相手の攻撃は待機して2秒ごとに最大3段せり上がる',
      '7段のまま自然上昇の時刻になると3秒の猶予。解消できなければ負け',
      '連続取得（2秒以内）で倍率アップ、役連鎖（8秒以内）で攻撃が増える',
    ],
  },
  {
    title: 'MODE1 シングル',
    lines: [
      'ひたすら：消去数でLvが上がる（Lv20でMAX）。Lv11で一度ゆっくりに',
      'ステージクリア：全10ステージ。各ステージの消去ノルマを達成する',
      '成功1個＝消去数1、役の1ライン消去＝消去数6',
      '得点：成功10点×得点倍率、1ライン100点×宣言時の得点倍率',
      '全消し500点、ステージクリアは1000点×面番号',
      'ステージ間は得点・連続取得・役連鎖を引き継ぎます',
    ],
  },
  {
    title: 'MODE2 のルール',
    lines: [
      '自分の6列から、場のカードへ出せるピースを打ち上げ続ける',
      '成功の条件は MODE1 と同じ。先に自分の盤面を空にした方の勝ち',
      '役・ライン消去・攻撃・B入れ替え・せり上がりはありません',
      '両者とも出せるピースがなくなると、3・2・1 のあと場のカードが変わる',
      'シングルは盤面を空にするまでのタイムを競います',
    ],
  },
];

class HelpScene implements Scene {
  private page = 0;

  constructor(private readonly app: App) {}

  onNav(ev: NavEvent): void {
    if (ev.key === 'left' || ev.key === 'right' || ev.key === 'confirm') {
      const n = HELP_PAGES.length;
      this.page = (this.page + (ev.key === 'left' ? n - 1 : 1)) % n;
      this.app.bus.playSfx('ui_move');
    } else if (ev.key === 'back') {
      this.app.bus.playSfx('ui_cancel');
      this.app.toMenu();
    }
  }

  update(): void {}

  render(ctx: CanvasRenderingContext2D): void {
    const A = this.app.assets;
    drawBackground(ctx, A);
    drawPanel(ctx, A, 'help_panel', 96, 45);
    const p = HELP_PAGES[this.page];
    drawText(ctx, `遊び方：${p.title}（${this.page + 1}/${HELP_PAGES.length}）`, 320, 60, { align: 'center', size: 13, bold: true, color: '#fff3c8' });
    p.lines.forEach((l, i) => drawText(ctx, l, 120, 92 + i * 22, { size: 11, maxWidth: 400 }));
    drawText(ctx, '←→／A で次のページ', 320, 270, { align: 'center', size: 9, color: '#c9d6ff' });
    drawFooter(ctx, A, 'ページ', '戻る');
  }
}

// ---------------------------------------------------------------- 試合

interface QuitDialog {
  player: PlayerId;
  source: 'keyboard' | { pad: number };
  cursor: 0 | 1;
}

export class GameScene implements Scene {
  readonly rawKeys = true;
  readonly session: Match | SingleSession;
  readonly view: GameView;
  readonly director: SoundDirector;
  readonly staging: Staging;
  readonly driver: FixedStepDriver;
  controllers: Controller[] = [];
  keyboards: (KeyboardController | null)[] = [null, null];
  pads: (GamepadController | null)[] = [null, null];
  devices: DeviceChoice[];
  quit: QuitDialog[] = [];
  finalCursor = 0;
  private confirmQueued = false;
  private recorded = false;
  private nextAnnouncer: Character = 'kotaro';
  private readonly bgm: BgmId;
  /** 自動検証用：デバッグ入力のキュー（開発ビルドのみキーで使用） */
  readonly debugQueue: Command[] = [];

  constructor(
    readonly app: App,
    readonly mode: GameMode,
    readonly kind: 'single' | 'cpu' | '2p',
    readonly singleMode?: SingleMode,
  ) {
    const s = app.settings;
    const seed = (Math.random() * 4294967295) >>> 0;
    this.devices = kind === 'cpu' ? [s.devices[0], { kind: 'cpu', level: s.npcLevel }] : kind === 'single' ? [s.devices[0]] : [s.devices[0], s.devices[1]];
    const readyMsFor = () => {
      this.nextAnnouncer = this.pickAnnouncer();
      return readyDurationMs(app.bus.voiceDurationMs(this.nextAnnouncer, 'ready'));
    };
    this.session =
      kind === 'single'
        ? new SingleSession({ mode: singleMode ?? 'endless', seed, readyMsFor })
        : new Match({ firstTo: s.firstTo, difficulty: s.difficulty, seed, mode, readyMsFor });
    // 決定入力の受付は演出側（勝者演出の開始後）で判定する
    this.session.resultMinMs = 0;
    this.bgm = kind === 'single' ? 'single' : 'versus';
    app.bus.playBgm(this.bgm);
    this.buildControllers();
    this.view = new GameView(this.game, app.assets);
    this.director = new SoundDirector(app.bus, this.game);
    this.staging = new Staging(this.game, app.bus, this.stagingOpts());
    this.driver = new FixedStepDriver({ tickMs: 1000 / 60, step: () => this.step() });
  }

  get game(): AnyGame {
    return this.session.game;
  }

  private humans(): PlayerId[] {
    return this.devices.map((d, i) => (d.kind !== 'cpu' ? (i as PlayerId) : null)).filter((x): x is PlayerId => x !== null);
  }

  /** READY／GO 担当：シングル＝選択キャラ（コタロー）、CPU対戦＝相手キャラ、2P対戦＝両者からランダム（演出用の乱数） */
  private pickAnnouncer(): Character {
    if (this.kind === 'single') return PLAYER_CHARACTER[0];
    if (this.kind === 'cpu') return PLAYER_CHARACTER[1];
    return PLAYER_CHARACTER[Math.random() < 0.5 ? 0 : 1];
  }

  private stagingOpts() {
    return { announcer: this.nextAnnouncer, characters: PLAYER_CHARACTER, humans: this.humans() };
  }

  private buildControllers(): void {
    const s = this.app.settings;
    this.controllers = [];
    this.keyboards = [null, null];
    this.pads = [null, null];
    this.devices.forEach((d, i) => {
      const p = i as PlayerId;
      if (d.kind === 'keyboard') {
        const k = new KeyboardController(p, s.keys[p]);
        this.keyboards[p] = k;
        this.controllers.push(k);
      } else if (d.kind === 'gamepad') {
        const g = new GamepadController(p, d.index, s.pads[p], this.app.deps.pads);
        this.pads[p] = g;
        this.controllers.push(g);
      } else {
        this.controllers.push(new CpuController(p, d.level, (Math.random() * 1e9) >>> 0));
      }
    });
  }

  private dialogOf(p: PlayerId): QuitDialog | undefined {
    return this.quit.find((q) => q.player === p);
  }

  private get finished(): boolean {
    const s = this.session;
    return s instanceof Match ? s.state === 'matchResult' : s.state === 'finished' || (s.state === 'result' && !s.hasNext);
  }

  /** 1tick：入力収集→ロジック→ラウンド切替の隔離 */
  private step(): void {
    const s = this.session;
    const before = s.game;
    let cmds: Command[] = [];
    this.controllers.forEach((c) => {
      const out = c.poll(before);
      if (!this.dialogOf(c.player)) cmds.push(...out); // 確認中のプレイヤーの操作はダイアログへ
    });
    cmds.push(...this.debugQueue.splice(0));
    const inResult = s instanceof Match ? s.state !== 'round' : s.state !== 'play';
    if (inResult) cmds = [];
    const confirm = this.confirmQueued && this.staging.acceptReady;
    this.confirmQueued = false;
    if (s instanceof Match) {
      s.step(cmds, confirm && s.state === 'roundResult');
    } else {
      s.step(cmds, confirm && s.state === 'result' && s.hasNext);
    }
    if (s.game !== before) this.onNewRound();
    this.recordIfDone();
  }

  private onNewRound(): void {
    this.app.bus.stopEffects();
    this.view.reset(this.game);
    this.director.reset(this.game);
    this.staging.reset(this.game, this.stagingOpts());
    this.finalCursor = 0;
    this.recorded = false;
  }

  private recordIfDone(): void {
    if (this.recorded || !this.game.result || this.kind !== 'single') return;
    const r = this.app.records;
    const g = this.game;
    const out = g.result!.outcome;
    if (g.mode === 'mode2') {
      if (out === 'clear') submitMode2(r, (g as Mode2Game).elapsedMs());
    } else {
      const s = (g as Game).single!;
      if (s.kind === 'endless') submitEndless(r, s.score, s.level);
      else if (out !== 'stageClear') submitStage(r, s.score, s.stage, out === 'allStagesClear');
      else submitStage(r, s.score, s.stage, false);
    }
    saveRecords(r);
    this.recorded = true;
  }

  // ---- 入力 ----

  private keyboardOwner(): PlayerId | null {
    const i = this.devices.findIndex((d) => d.kind === 'keyboard');
    return i < 0 ? null : (i as PlayerId);
  }

  onKey(code: string, repeat: boolean): boolean {
    if (this.app.deps.dev && this.devKey(code)) return true;
    const owner = this.keyboardOwner();
    const dlg = owner !== null ? this.quit.find((q) => q.source === 'keyboard') : undefined;
    // 終了確認（キーボード）：確認を開いたプレイヤーの割当キーと、他のキーボード操作者に割り当てていない共有キー（←→・Esc・Enter・Backspace）
    // だけを確認へ振り分ける。相手の割当キーは相手のコントローラーへ渡す（共有キーボードでも相手の操作を奪わない）
    if (dlg) {
      const act = this.keyboards[dlg.player]?.actionOf(code);
      const otherOwns = this.keyboards.some((k, i) => i !== dlg.player && k?.actionOf(code));
      if (act) {
        if (act === 'left' || act === 'right') this.moveDialog(dlg);
        else if (act === 'launch' && !repeat) this.decideDialog(dlg);
        return true; // 確認中の本人のプレイ操作は捨てる
      }
      if (!otherOwns) {
        if (code === 'ArrowLeft' || code === 'ArrowRight') {
          this.moveDialog(dlg);
          return true;
        }
        if (code === 'Escape' || code === 'Backspace') {
          if (!repeat) this.closeDialog(dlg);
          return true;
        }
        if (code === 'Enter' || code === 'NumpadEnter') {
          if (!repeat) this.decideDialog(dlg);
          return true;
        }
      }
      for (const k of this.keyboards) if (k && k.player !== dlg.player && k.handleKey(code, repeat)) return true;
      return true;
    }
    if (code === 'Escape') {
      if (owner !== null && !repeat && !this.game.result) {
        this.quit.push({ player: owner, source: 'keyboard', cursor: 0 });
        this.app.bus.playSfx('ui_confirm');
      } else if (this.finished && !repeat) this.app.toMenu();
      return true;
    }
    // 結果中の決定（Enter・Space・人の発射キー）／最終結果の選択
    if (this.game.result) {
      if (repeat) return true;
      const launchKey = this.keyboards.some((k) => k?.actionOf(code) === 'launch');
      if (this.finished) {
        if (code === 'ArrowUp' || code === 'ArrowDown') this.moveFinal();
        else if (code === 'Enter' || code === 'NumpadEnter' || code === 'Space' || launchKey) this.decideFinal();
        return true;
      }
      if (code === 'Enter' || code === 'NumpadEnter' || code === 'Space' || launchKey) this.queueConfirm();
      return true;
    }
    for (const k of this.keyboards) if (k?.handleKey(code, repeat)) return true;
    return false;
  }

  /** 開発ビルドのみ：攻撃注入（1/2＝1Pへ+1/+10、9/0＝2Pへ+10/+1） */
  private devKey(code: string): boolean {
    const map: Record<string, [PlayerId, number]> = { Digit1: [0, 1], Digit2: [0, 10], Digit9: [1, 10], Digit0: [1, 1] };
    const m = map[code];
    if (!m || this.keyboards.some((k) => k?.actionOf(code))) return false;
    this.debugQueue.push({ player: m[0], type: 'debugAttack', lines: m[1] });
    return true;
  }

  onNav(ev: NavEvent): void {
    if (ev.source.kind !== 'pad') return; // キーボードは onKey で扱う
    const padIndex = ev.source.index;
    const player = this.devices.findIndex((d) => d.kind === 'gamepad' && d.index === padIndex);
    const dlg = this.quit.find((q) => typeof q.source === 'object' && q.source.pad === padIndex);
    if (dlg) {
      if (ev.key === 'left' || ev.key === 'right') this.moveDialog(dlg);
      else if (ev.key === 'confirm') this.decideDialog(dlg);
      else if (ev.key === 'back' || ev.key === 'start') this.closeDialog(dlg);
      return;
    }
    if (this.game.result) {
      if (this.finished) {
        if (ev.key === 'up' || ev.key === 'down') this.moveFinal();
        else if (ev.key === 'confirm') this.decideFinal();
        else if (ev.key === 'back') this.app.toMenu();
      } else if (ev.key === 'confirm') this.queueConfirm();
      return;
    }
    if (ev.key === 'start' && player >= 0 && !this.dialogOf(player as PlayerId)) {
      this.quit.push({ player: player as PlayerId, source: { pad: padIndex }, cursor: 0 });
      this.app.bus.playSfx('ui_confirm');
    }
  }

  private queueConfirm(): void {
    // 勝者演出の開始前の決定入力は捨てる（押しっぱなしも持ち越さない＝押した瞬間のみ）
    if (this.staging.acceptReady) this.confirmQueued = true;
  }

  private moveDialog(d: QuitDialog): void {
    d.cursor = d.cursor === 0 ? 1 : 0;
    this.app.bus.playSfx('ui_move');
  }

  private closeDialog(d: QuitDialog): void {
    this.quit = this.quit.filter((q) => q !== d);
    this.app.bus.playSfx('ui_cancel');
  }

  private decideDialog(d: QuitDialog): void {
    if (d.cursor === 1) {
      this.app.bus.playSfx('ui_confirm');
      this.app.toMenu();
    } else this.closeDialog(d);
  }

  private finalChoices(): string[] {
    return this.session instanceof Match ? ['再戦', 'メニューへ'] : ['もう一度', 'メニューへ'];
  }

  private moveFinal(): void {
    if (!this.staging.acceptReady) return;
    this.finalCursor = (this.finalCursor + 1) % 2;
    this.app.bus.playSfx('ui_move');
  }

  private decideFinal(): void {
    if (!this.staging.acceptReady) return;
    const s = this.session;
    this.app.bus.playSfx('ui_confirm');
    if (this.finalCursor === 1) return this.app.toMenu();
    const before = s.game;
    if (s instanceof Match) s.rematch();
    else s.restart();
    this.app.bus.playBgm(this.bgm);
    if (s.game !== before) this.onNewRound();
  }

  // ---- 進行・描画 ----

  update(dtMs: number): void {
    // ゲームパッドの入力は毎フレーム取得（ロジックは固定ステップ）
    this.driver.advance(dtMs);
    this.director.sync();
    this.staging.update();
    // 最終結果はファンファーレ後にメニュー曲へ（同じ曲なら再始動しない）
    if (this.finished && this.staging.acceptReady) this.app.bus.playBgm('menu');
  }

  render(ctx: CanvasRenderingContext2D, ms: number): void {
    const s = this.session;
    const g = this.game;
    const t = g.tick + this.driver.alpha;
    this.view.hud = {
      wins: s instanceof Match ? s.wins : undefined,
      firstTo: s instanceof Match ? s.settings.firstTo : undefined,
      round: s instanceof Match ? s.round : undefined,
      labels: this.devices.length === 2 ? [deviceLabel(this.devices[0]), deviceLabel(this.devices[1])] : undefined,
      result: this.staging.plan,
      matchOver: s instanceof Match && s.state === 'matchResult',
    };
    this.view.render(ctx, t);
    const A = this.app.assets;
    const phase = (['A', 'B', 'C'] as const)[Math.floor(ms / 90) % 3];
    if (g.result && this.staging.acceptReady) {
      if (this.finished || (s instanceof SingleSession && s.state === 'result')) this.drawResult(ctx, phase);
      else drawText(ctx, '決定（A／Enter／発射）で次のラウンドへ', 320, 106, { align: 'center', size: 11, bold: true, box: true });
    }
    for (const q of this.quit) {
      const x = q.player === 0 ? 20 : 340;
      drawConfirm(ctx, A, `${q.player + 1}P：試合を終了してメニューへ戻りますか？`, ['続ける', '終了する'], q.cursor, x, 110, 'ゲームは止まっていません');
    }
  }

  private drawResult(ctx: CanvasRenderingContext2D, phase: 'A' | 'B' | 'C'): void {
    const s = this.session;
    const g = this.game;
    const A = this.app.assets;
    const r = this.app.records;
    const lines: string[] = [];
    let head: string | null = 'show_result';
    let choices = this.finalChoices();
    let hint = '';
    if (s instanceof Match) {
      const w = s.matchWinner;
      lines.push(`${w === null ? '引分け' : `${w + 1}P の勝ち`}（${s.wins[0]} − ${s.wins[1]}）`);
      lines.push(`${s.settings.firstTo}本先取・${this.mode === 'mode1' ? 'MODE1' : 'MODE2'}`);
    } else if (g.mode === 'mode2') {
      const m2 = g as Mode2Game;
      head = 'show_all_clear';
      lines.push(`クリアタイム ${formatTime(m2.elapsedMs())}`);
      if (r.mode2Single) lines.push(`ベスト ${formatTime(r.mode2Single.bestMs)}`);
    } else {
      const sg = (g as Game).single!;
      const out = g.result!.outcome;
      head = out === 'gameOver' ? 'show_game_over' : out === 'allStagesClear' ? 'show_all_stages_complete' : out === 'stageClear' ? 'show_stage_clear' : 'show_result';
      lines.push(`得点 ${sg.score.toLocaleString('ja-JP')}`);
      if (sg.kind === 'stage') {
        lines.push(`ステージ ${sg.stage}${out === 'stageClear' || out === 'allStagesClear' ? ` クリア（ボーナス ${(sg.stage * 1000).toLocaleString('ja-JP')}）` : ''}`);
        if (r.stage) lines.push(`ベスト ${r.stage.score.toLocaleString('ja-JP')}点・最高${r.stage.maxStage}面`);
      } else {
        lines.push(`到達 Lv${sg.level}${sg.level >= 20 ? ' MAX' : ''}`);
        if (r.endless) lines.push(`ベスト ${r.endless.score.toLocaleString('ja-JP')}点`);
      }
      if (s.state === 'result' && s.hasNext) {
        choices = [];
        hint = '決定（A／Enter／発射）で次のステージへ';
      }
    }
    drawResultPanel(ctx, A, head, lines, choices, this.finalCursor, phase, hint);
  }
}

export const DIFF_TEXT = (d: Difficulty) => DIFFICULTY_LABEL[d];
export type { NavKey };
