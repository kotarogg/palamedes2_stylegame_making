// 画面遷移と入力の統合（第3版 第15・16章）：起動→タイトル→メインメニュー→（MODE1／MODE2 × シングル／CPU対戦／2P対戦、オプション、遊び方）
// →（2P対戦はキャラクター選択）→試合→結果→次の相手／再戦／キャラ選択／メニュー。
// 一時停止は無い。プレイ中の Esc／START は「試合を終了してメニューへ戻る」確認で、確認中もゲームは進む（そのプレイヤーの入力だけがダイアログへ）。
import type { AudioBus } from './audio/audioBus';
import { VOICE_PRIORITY, type BgmId, type Character } from './audio/audioMap';
import { DEFAULT_DIRECTOR_OPTIONS, SoundDirector } from './audio/director';
import { DIFFICULTY_LABEL, type Difficulty } from './core/config';
import { FixedStepDriver, type StepInfo } from './core/driver';
import type { Command, Game } from './core/game';
import { Match, SingleSession, type AnyGame, type FirstTo, type GameMode, type SingleMode } from './core/match';
import type { Mode2Game } from './core/mode2';
import { RoundRecorder, type RoundMetrics } from './core/metrics';
import { createSeededRng, type Rng } from './core/rng';
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
import { loadRecords, saveRecords, submitEndless, submitMode2, submitStage, type Mode2Submit, type Records } from './ui/records';
import {
  ACCENT,
  CHARACTER_NAME,
  drawBackground,
  drawCharacterSelect,
  drawConfirm,
  drawCredits,
  drawFooter,
  drawMenuCharacters,
  drawMenuItems,
  drawMenuTitle,
  MENU_ITEM,
  drawOptionPanel,
  drawReadingPanel,
  drawResultPanel,
  drawTitle,
  SELECT_SLOTS,
  type CreditItem,
  type OptionRow,
} from './ui/screens';
import type { Assets } from './view/assets';
import { GameView } from './view/gameView';
import { readyDurationMs, RoleNameDirector, Staging } from './view/presentation';
import { fixedScaleChoices, MAX_FIXED_SCALE } from './view/scale';
import { drawText, formatTime, TEXT_COLORS, UI_FONT } from './view/text';
import { drawBitmapText, TUTORIAL_COLORS } from './view/bitmapFont';
import { TUTORIAL_SCRIPT } from './demo/lesson';
import { DEMO } from './demo/stages';
import { DemoScene, HelpMenuScene, PadEdges } from './demo/scenes';

export const W = 640;
export const H = 360;
/** v3.1.0 パズルシーンの開始前待機（表示準備完了後、試合開始処理へ進むまで） */
export const PRESTART_MS = 1000;
/** V320-FIX-04 CPU観戦：ラウンド結果演出の完了後、次ラウンドへ自動で進むまでの保持 */
export const WATCH_ROUND_HOLD_MS = 1500;

export interface Scene {
  /** マウスのクリック（画面上の押下） */
  onPointer?(): void;
  /** 非アクティブ（タブの切替・ウィンドウのフォーカス喪失）と復帰 */
  onVisibility?(hidden: boolean): void;
  /** v3.2.0 キーを離した（先行入力：自動反復の予約を残さない） */
  onKeyUp?(code: string): void;
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
  /** 現在の表示領域（CSSピクセル）と devicePixelRatio（表示倍率の選択可否に使う） */
  viewport: () => { w: number; h: number; dpr: number };
  /** URLを外部ブラウザ（別タブ）で開く */
  openUrl: (url: string) => void;
  dev: boolean;
}

/**
 * CPU対戦の相手の順（v3.1.0）：固定順「コタロー→アカネ→ずん子」から1Pのキャラを除いた2人を繰り返す。
 * 「次の相手へ」だけで進む（次のラウンド・再戦では交代しない）。保存しない
 */
export const CPU_FIXED_ORDER: readonly Character[] = ['kotaro', 'akane', 'zunko'];

export function cpuOrderFor(me: Character): Character[] {
  return CPU_FIXED_ORDER.filter((c) => c !== me);
}

export function nextCpuOpponent(me: Character, current: Character): Character {
  const order = cpuOrderFor(me);
  const i = order.indexOf(current);
  return order[(i + 1) % order.length];
}

export class App {
  settings: AppSettings;
  records: Records = loadRecords();
  scene: Scene;
  readonly menuInput: MenuInput;
  settingsSaved = true;
  /** CPU対戦の1Pのキャラ（キャラクター選択で決定。メニューへ戻るとコタローへ戻す。保存しない） */
  cpuPlayer: Character = 'kotaro';
  /** CPU対戦の現在の相手（1Pのキャラを除いた固定順の先頭から。保存しない） */
  cpuOpponent: Character = cpuOrderFor('kotaro')[0];
  /** V320-FIX-04 CPU観戦の設定（起動中だけ保持。通常の対戦設定とは別） */
  watch: WatchSettings = defaultWatchSettings();
  /** 開発用：CPU観戦の固定seed（指定時だけ再戦でも同じseed。一般向けの設定には出さない） */
  watchFixedSeed: number | null = null;
  /** 開発用：CPU観戦のラウンド記録（seed・左右キャラ／強さ・自然上昇・勝敗・ゲーム内時間・決着原因） */
  readonly watchLog: WatchLogEntry[] = [];
  /** クレジットのページ位置（URLを開いて戻っても維持） */
  creditsPage = 0;
  /** 開発版だけ：人間のプレイの計測記録（第21章。製品画面には出さない） */
  readonly devMetrics: (RoundMetrics & { kind: string; characters: readonly Character[]; at: string })[] = [];
  private notice: { text: string; until: number } | null = null;
  /** 現在のフレームの時刻（requestAnimationFrame の時刻。performance.now と同じ基準） */
  nowMs = 0;

  constructor(readonly deps: AppDeps) {
    this.settings = deps.settings;
    this.menuInput = new MenuInput(deps.pads);
    deps.bus.setVolumes(this.settings.audio);
    this.scene = new TitleScene(this);
  }

  /** 画面上部の一時通知（表示倍率の切替など） */
  showNotice(text: string, ms = 4000): void {
    this.notice = { text, until: this.nowMs + ms };
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

  /** メインメニューへ（CPU対戦の1Pキャラはコタロー、相手順は先頭へ戻す） */
  toMenu(openPath: readonly string[] = []): void {
    this.bus.stopEffects();
    this.bus.playBgm('menu');
    this.cpuPlayer = 'kotaro';
    this.cpuOpponent = cpuOrderFor('kotaro')[0];
    this.setScene(new MenuScene(this, openPath));
  }

  /** タイトルへ（放置デモの終了・完走）。fadeIn：黒からのフェードイン */
  toTitle(fadeIn = false): void {
    this.bus.stopEffects();
    this.setScene(new TitleScene(this, fadeIn));
  }

  /** 放置デモ（タイトル無操作・オプションの「デモ再生」） */
  startDemo(by: 'idle' | 'option'): void {
    this.setScene(new DemoScene(this, by));
  }

  /** 遊び方の目次（呼出元：メインメニュー／オプション） */
  openHelp(from: 'menu' | 'options'): void {
    this.setScene(new HelpMenuScene(this, from));
  }

  /** 遊び方を閉じて呼出元へ */
  leaveHelp(from: 'menu' | 'options'): void {
    if (from === 'options') this.setScene(new OptionsScene(this, 'top', OPTIONS_HELP_ROW));
    else this.toMenu(['遊び方']);
  }

  /** 遊び方：文章の操作一覧（従来の説明頁） */
  openHelpText(back: () => void): void {
    this.setScene(new HelpScene(this, back));
  }

  onPointer(): void {
    this.scene.onPointer?.();
  }

  onKeyUp(code: string, at: number | null = null): void {
    this.keyEventAt = at;
    this.scene.onKeyUp?.(code);
  }

  /** v3.2.0 r：処理中のキーイベントの時刻（event.timeStamp。無ければ null）。試合中のキー入力をtickの実時刻と対応させる */
  keyEventAt: number | null = null;

  onVisibility(hidden: boolean): void {
    this.scene.onVisibility?.(hidden);
  }

  saveSettings(): void {
    this.settingsSaved = saveSettings(this.settings);
    this.bus.setVolumes(this.settings.audio);
  }

  onKey(code: string, repeat: boolean, at: number | null = null): boolean {
    this.keyEventAt = at;
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
    this.nowMs = ms;
    this.pollPadActivation();
    this.menuInput.pollPads();
    for (const ev of this.menuInput.drain()) this.scene.onNav(ev);
    this.scene.update(dtMs);
    this.scene.render(ctx, ms);
    let y = 6;
    const banner = (msg: string, color: string) => {
      drawText(ctx, msg, 320, y, { align: 'center', size: 10, color, box: true, maxWidth: 620 });
      y += 16;
    };
    // 採用フォントを読めなかった場合は黙って代替フォントへ退避せず、常に明示する
    if (!this.assets.fontLoaded) banner('採用フォント（Noto Sans JP）を読み込めませんでした。文字は代替フォントで表示しています', '#ff9a9a');
    if (!this.bus.unlocked) {
      // 未試行＝最初の操作待ち。試行済みで止まっている＝ブラウザが再生を許可していない（パッド操作は許可対象外のブラウザがある）
      const msg = this.bus.unlockAttempted && this.bus.ctx
        ? 'ブラウザが音の再生を止めています。キーを1回押すか、画面をクリックしてください'
        : '最初の操作で音が出ます（キー・クリック・ゲームパッド）';
      banner(msg, '#ffe0a0');
    }
    if (this.notice && ms < this.notice.until) banner(this.notice.text, '#c0ffd0');
  }

  // ---- 試合開始 ----

  /** characters：シングル＝コタロー、CPU対戦＝1Pの選択キャラ対現在の相手、2P対戦＝キャラ選択の結果 */
  /** V320-FIX-04 CPU観戦を現在の観戦設定で始める（再戦も新しいseed。開発用固定seedの指定時だけ同じseed） */
  startWatch(): void {
    this.bus.stopEffects();
    const w = this.watch;
    this.setScene(new GameScene(this, w.mode, 'watch', undefined, [w.left, w.right], { ...w }));
  }

  startGame(mode: GameMode, kind: 'single' | 'cpu' | '2p', singleMode?: SingleMode, characters?: readonly Character[], opts: { keepSelectVoices?: boolean } = {}): void {
    // キャラクター選択から：決定ボイス（select）だけは止めずに終端まで鳴らす。他の声・SEは止める
    this.bus.stopEffects(opts.keepSelectVoices ? ['select'] : []);
    const chars: readonly Character[] = kind === 'single' ? ['kotaro'] : kind === 'cpu' ? [this.cpuPlayer, this.cpuOpponent] : (characters ?? ['kotaro', 'akane']);
    this.setScene(new GameScene(this, mode, kind, singleMode, chars));
  }
}

// ---------------------------------------------------------------- タイトル（S01）

/**
 * タイトル：最初の決定でメインメニューへ。最初の入力で音声の有効化を試みる（その入力は次の画面へ渡さない）。
 * BGMはメニュー曲（自動再生を強制しない。有効化後に鳴り、タイトル→メニューで再始動しない）。
 */
export class TitleScene implements Scene {
  /** 無操作の経過（タイトルの描画完了から。有効なボタン・方向入力・クリックで0へ。マウス移動では戻さない） */
  idleMs = 0;
  private rendered = false;
  private fadeMs: number;
  /** 無操作20秒：暗転（フェードアウト→黒）してからデモへ。途中の入力で取り消す。null＝暗転していない */
  leavingMs: number | null = null;
  private readonly pads: PadEdges;

  constructor(
    private readonly app: App,
    fadeIn = false,
  ) {
    app.bus.playBgm('menu');
    this.fadeMs = fadeIn ? DEMO.fadeInMs : 0;
    this.pads = new PadEdges(app.deps.pads);
  }

  private touch(): void {
    this.idleMs = 0;
    this.leavingMs = null;
  }

  onKey(_code: string, repeat: boolean): boolean {
    if (!repeat) this.touch();
    return false; // 決定などは MenuInput 経由の onNav で扱う
  }

  onPointer(): void {
    this.touch();
  }

  onNav(ev: NavEvent): void {
    this.touch();
    if (ev.key !== 'confirm' && ev.key !== 'start') return;
    this.app.bus.playSfx('ui_confirm');
    this.app.setScene(new MenuScene(this.app));
  }

  update(dtMs: number): void {
    if (this.pads.poll()) this.touch();
    if (!this.rendered) return;
    if (this.fadeMs > 0) {
      this.fadeMs = Math.max(0, this.fadeMs - dtMs);
      return;
    }
    this.idleMs += dtMs;
    if (this.idleMs < DEMO.idleMs) return;
    this.leavingMs = (this.leavingMs ?? 0) + dtMs;
    if (this.leavingMs >= DEMO.fadeOutMs + DEMO.blackMs) this.app.startDemo('idle');
  }

  render(ctx: CanvasRenderingContext2D, ms: number): void {
    drawTitle(ctx, this.app.assets, ms);
    drawBitmapText(ctx, this.app.assets.tutorial?.font, TUTORIAL_SCRIPT.title_hint, 320, TITLE_HINT_Y, { align: 'center', color: TUTORIAL_COLORS.secondary, outline: TUTORIAL_COLORS.outline });
    const dark = this.leavingMs !== null ? Math.min(1, this.leavingMs / DEMO.fadeOutMs) : this.fadeMs / DEMO.fadeInMs;
    if (dark > 0) {
      ctx.save();
      ctx.globalAlpha = dark;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
    this.rendered = true;
  }
}

/** タイトルの「しばらくするとデモが始まります」の位置（文字の上端） */
export const TITLE_HINT_Y = 340;
/** オプション最上位の「遊び方」の行番号 */
const OPTIONS_HELP_ROW = 5;

// ---------------------------------------------------------------- メインメニュー

interface MenuItem {
  label: string;
  desc: string;
  children?: MenuItem[];
  run?: () => void;
}

export class MenuScene implements Scene {
  private stack: { title: string; items: MenuItem[]; cursor: number }[];

  /** openPath：開いておくサブメニュー（例：キャラ選択から戻る＝['MODE1']） */
  constructor(
    private readonly app: App,
    openPath: readonly string[] = [],
  ) {
    const a = app;
    const root: MenuItem[] = [
      {
        label: 'MODE1',
        desc: MENU_DESC.mode1,
        children: [
          {
            label: 'シングル',
            desc: MENU_DESC.m1_single,
            children: [
              { label: 'ひたすら', desc: MENU_DESC.endless, run: () => a.startGame('mode1', 'single', 'endless') },
              { label: 'ステージクリア', desc: MENU_DESC.stage, run: () => a.startGame('mode1', 'single', 'stage') },
            ],
          },
          { label: 'CPU対戦', desc: MENU_DESC.m1_cpu, run: () => a.setScene(new CpuCharacterSelectScene(a, 'mode1', 'kotaro')) },
          { label: '2P対戦', desc: MENU_DESC.m1_2p, run: () => a.setScene(new CharacterSelectScene(a, 'mode1')) },
        ],
      },
      {
        label: 'MODE2',
        desc: MENU_DESC.mode2,
        children: [
          { label: 'シングル', desc: MENU_DESC.m2_single, run: () => a.startGame('mode2', 'single', 'mode2') },
          { label: 'CPU対戦', desc: MENU_DESC.m2_cpu, run: () => a.setScene(new CpuCharacterSelectScene(a, 'mode2', 'kotaro')) },
          { label: '2P対戦', desc: MENU_DESC.m2_2p, run: () => a.setScene(new CharacterSelectScene(a, 'mode2')) },
        ],
      },
      { label: 'CPU観戦', desc: MENU_DESC.watch, run: () => a.setScene(new WatchSettingsScene(a)) },
      { label: 'オプション', desc: '音・操作・対戦・表示・クレジット', run: () => a.setScene(new OptionsScene(a)) },
      { label: '遊び方', desc: MENU_DESC.help, run: () => a.openHelp('menu') },
    ];
    this.stack = [{ title: 'メインメニュー', items: root, cursor: 0 }];
    for (const label of openPath) {
      const t = this.top;
      const i = t.items.findIndex((x) => x.label === label);
      if (i < 0) break;
      t.cursor = i;
      if (!t.items[i].children) break;
      this.stack.push({ title: `${t.title === 'メインメニュー' ? '' : `${t.title} › `}${label}`, items: t.items[i].children!, cursor: 0 });
    }
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
        bus.playSfx('ui_cancel');
        if (this.stack.length > 1) this.stack.pop();
        // v3.2.0：最上位の戻るでタイトルへ（無操作デモの待機は0から。戻る入力でタイトルの決定へ進まない）
        else this.app.toTitle();
        return;
      default:
        return;
    }
  }

  update(): void {}

  render(ctx: CanvasRenderingContext2D, ms: number): void {
    void ms;
    const A = this.app.assets;
    drawBackground(ctx, A);
    drawMenuCharacters(ctx, A);
    const t = this.top;
    drawMenuTitle(ctx, t.title);
    drawMenuItems(ctx, A, t.items.map((i) => i.label), t.cursor);
    // V320-FIX-04 付録C：説明は採用Noto描画のまま、300pxの1行へ縮小せず全角空白の区切りで行分けする。記録欄はその下
    const descLines = menuDescLines(ctx, t.items[t.cursor].desc);
    descLines.forEach((l, i) => drawText(ctx, l, 320, MENU_DESC_Y(t.items.length) + i * MENU_DESC_PITCH, { align: 'center', size: 11, color: TEXT_COLORS.secondary }));
    const bestY = MENU_DESC_Y(t.items.length) + (descLines.length - 1) * MENU_DESC_PITCH + 22;
    const r = this.app.records;
    if (t.title.endsWith('シングル')) {
      const best: string[] = [];
      if (t.title.startsWith('MODE1')) {
        if (r.endless) best.push(`ひたすら ベスト ${r.endless.score.toLocaleString('ja-JP')}点（Lv${r.endless.level}）`);
        if (r.stage) best.push(`ステージ ベスト ${r.stage.score.toLocaleString('ja-JP')}点（最高${r.stage.maxStage}面${r.stage.completed ? '・全20面クリア' : ''}）`);
        // 旧ルール（全10面）の記録は消さずに区別して表示（20面クリアとは扱わない）
        else if (r.stageLegacy10) best.push(`旧ルール（全10面）ベスト ${r.stageLegacy10.score.toLocaleString('ja-JP')}点（最高${r.stageLegacy10.maxStage}面）`);
      } else {
        if (r.mode2Single) best.push(`最短クリア ${formatTime(r.mode2Single.bestMs)}`);
        if (r.mode2NoResetBest) best.push(`ノーリセット最短 ${formatTime(r.mode2NoResetBest.bestMs)}`);
      }
      best.forEach((b, i) => drawText(ctx, b, 320, bestY + i * 18, { align: 'center', size: 11, color: ACCENT, maxWidth: 300 }));
    }
    drawFooter(ctx, A);
  }
}

// ---------------------------------------------------------------- キャラクター選択（S05・2P対戦）

/** キャラクター選択の状態（DOM非依存。テスト対象） */
export class CharacterSelect {
  /** SELECT_SLOTS の位置。初期：1P コタロー、2P アカネ */
  cursors: [number, number] = [0, 1];
  locked: [boolean, boolean] = [false, false];

  /** 左右移動：相手のカーソル位置を飛ばして循環。決定済みは動かない。動いたら true */
  move(p: PlayerId, dir: -1 | 1): boolean {
    if (this.locked[p]) return false;
    const n = SELECT_SLOTS.length;
    let c = this.cursors[p];
    do c = (c + dir + n) % n;
    while (c === this.cursors[1 - p]);
    if (c === this.cursors[p]) return false;
    this.cursors[p] = c;
    return true;
  }

  /** 決定：同じキャラは2人で決定できない（カーソルは常に別位置なので相手の決定と重ならない） */
  confirm(p: PlayerId): boolean {
    if (this.locked[p]) return false;
    if (this.locked[1 - p] && this.cursors[1 - p] === this.cursors[p]) return false;
    this.locked[p] = true;
    return true;
  }

  /** 戻る：自分の決定だけを取り消す。両者とも未決定なら 'leave'（前のメニューへ） */
  back(p: PlayerId): 'undo' | 'leave' | 'none' {
    if (this.locked[p]) {
      this.locked[p] = false;
      return 'undo';
    }
    return this.locked[0] || this.locked[1] ? 'none' : 'leave';
  }

  get done(): boolean {
    return this.locked[0] && this.locked[1];
  }

  characters(): [Character, Character] {
    return [SELECT_SLOTS[this.cursors[0]], SELECT_SLOTS[this.cursors[1]]];
  }
}

type SelectAction = 'left' | 'right' | 'confirm' | 'back';

/**
 * 2P対戦のキャラクター選択。入力機器はオプションの1P/2P設定に従う。
 * キーボード：各プレイヤーの割当（移動・発射＝決定・B入れ替え＝戻る）。キーボードの操作者が1人なら ←→／Enter／Esc も使える。
 * 同じフレームの入力は 1P→2P の順に処理する。両者決定でただちに試合へ（決定ボイスの終了を待たない）。
 * 決定ボイスは select チャンネルで鳴らし、試合開始の一括停止・READY では止めない（終端まで鳴る）。
 * 決定の入力は試合画面へ渡さない（同じフレームの残りの入力は捨て、パッドは押下中の状態を引き継いで再発火しない）。
 */
export class CharacterSelectScene implements Scene {
  readonly rawKeys = true;
  readonly sel = new CharacterSelect();
  private pending: { p: PlayerId; act: SelectAction }[] = [];
  private keyboards: (KeyboardController | null)[];

  constructor(
    private readonly app: App,
    readonly mode: GameMode,
  ) {
    const s = app.settings;
    this.keyboards = ([0, 1] as const).map((p) => (s.devices[p].kind === 'keyboard' ? new KeyboardController(p, s.keys[p]) : null));
    app.bus.playBgm('menu');
  }

  private soleKeyboard(): PlayerId | null {
    const ks = this.keyboards.map((k, i) => (k ? i : -1)).filter((i) => i >= 0);
    return ks.length === 1 ? (ks[0] as PlayerId) : null;
  }

  onKey(code: string, repeat: boolean): boolean {
    for (const k of this.keyboards) {
      const a = k?.actionOf(code);
      if (!k || !a) continue;
      if (a === 'left' || a === 'right') this.pending.push({ p: k.player, act: a });
      else if (!repeat && a === 'launch') this.pending.push({ p: k.player, act: 'confirm' });
      else if (!repeat && a === 'rotate') this.pending.push({ p: k.player, act: 'back' });
      return true;
    }
    const sole = this.soleKeyboard();
    if (code === 'Escape' || code === 'Backspace') {
      if (!repeat) {
        if (sole !== null) this.pending.push({ p: sole, act: 'back' });
        else if (!this.sel.locked[0] && !this.sel.locked[1]) this.leave();
      }
      return true;
    }
    if (sole === null) return false;
    if (code === 'ArrowLeft' || code === 'ArrowRight') this.pending.push({ p: sole, act: code === 'ArrowLeft' ? 'left' : 'right' });
    else if (!repeat && (code === 'Enter' || code === 'NumpadEnter' || code === 'Space')) this.pending.push({ p: sole, act: 'confirm' });
    else return false;
    return true;
  }

  onNav(ev: NavEvent): void {
    if (ev.source.kind !== 'pad') return;
    const idx = ev.source.index;
    const p = this.app.settings.devices.findIndex((d) => d.kind === 'gamepad' && d.index === idx);
    if (p < 0) return;
    const act: SelectAction | null = ev.key === 'left' || ev.key === 'right' ? ev.key : ev.key === 'confirm' ? 'confirm' : ev.key === 'back' ? 'back' : null;
    if (act) this.pending.push({ p: p as PlayerId, act });
  }

  private leave(): void {
    this.app.bus.playSfx('ui_cancel');
    this.app.toMenu([this.mode === 'mode1' ? 'MODE1' : 'MODE2']);
  }

  update(): void {
    // 同じフレームの入力は 1P→2P（安定ソート）
    const acts = this.pending.splice(0).sort((a, b) => a.p - b.p);
    const bus = this.app.bus;
    for (const { p, act } of acts) {
      if (act === 'left' || act === 'right') {
        if (this.sel.move(p, act === 'left' ? -1 : 1)) bus.playSfx('ui_move');
      } else if (act === 'confirm') {
        if (this.sel.confirm(p)) {
          bus.playSfx('ui_confirm');
          bus.playVoice(this.sel.characters()[p], 'select', VOICE_PRIORITY.start, 'select');
          // 両者決定：ただちに試合へ。同じフレームの残りの入力は試合へ渡さない
          if (this.sel.done) return this.app.startGame(this.mode, '2p', undefined, this.sel.characters(), { keepSelectVoices: true });
        } else bus.playSfx('ui_invalid');
      } else {
        const ch = this.sel.characters()[p];
        const r = this.sel.back(p);
        if (r === 'undo') {
          // 取消：その人の決定ボイスを止める（不要な音を残さない）
          bus.stopVoice('select', `${ch}_select`);
          bus.playSfx('ui_cancel');
        } else if (r === 'leave') return this.leave();
      }
    }
  }

  render(ctx: CanvasRenderingContext2D, ms: number): void {
    drawCharacterSelect(ctx, this.app.assets, this.sel.cursors, this.sel.locked, ms);
    drawText(ctx, `${this.mode === 'mode1' ? 'MODE1' : 'MODE2'} 2P対戦`, 572, 18, { align: 'right', size: 12, color: TEXT_COLORS.secondary });
    drawText(ctx, '左右：選択　発射キー／A：決定　B入れ替えキー／B／Esc：取消・戻る', 320, 346, { align: 'center', size: 9, color: TEXT_COLORS.secondary });
  }
}

/** CPU対戦のキャラクター選択の状態（DOM非依存。テスト対象）。キャンセルで「メニューに戻りますか？」を出す */
export class CpuCharacterSelect {
  cursor: number;
  /** 確認ポップアップ：null＝閉じている、0＝「戻らない」、1＝「戻る」（初期は「戻らない」） */
  dialog: 0 | 1 | null = null;
  confirmed = false;

  constructor(initial: Character = 'kotaro') {
    this.cursor = Math.max(0, SELECT_SLOTS.indexOf(initial));
  }

  get character(): Character {
    return SELECT_SLOTS[this.cursor];
  }

  /** 入力1件。返り値：画面側の処理（効果音・遷移） */
  input(act: SelectAction): 'move' | 'confirm' | 'open' | 'dialogMove' | 'stay' | 'leave' | 'none' {
    if (this.confirmed) return 'none';
    if (this.dialog !== null) {
      // ポップアップ表示中は背後を操作させない
      if (act === 'left' || act === 'right') {
        this.dialog = this.dialog === 0 ? 1 : 0;
        return 'dialogMove';
      }
      if (act === 'confirm') {
        const leave = this.dialog === 1;
        this.dialog = null;
        return leave ? 'leave' : 'stay';
      }
      this.dialog = null; // ポップアップ内のキャンセル＝戻らない（選択位置は維持）
      return 'stay';
    }
    if (act === 'left' || act === 'right') {
      const n = SELECT_SLOTS.length;
      this.cursor = (this.cursor + (act === 'left' ? -1 : 1) + n) % n;
      return 'move';
    }
    if (act === 'confirm') {
      this.confirmed = true;
      return 'confirm';
    }
    this.dialog = 0;
    return 'open';
  }
}

/**
 * CPU対戦のキャラクター選択（MODE1・MODE2）。1Pがコタロー／アカネ／ずん子から選ぶ。2Pカーソルは出さない。
 * CPU は1Pと同じキャラにしない（固定順から1Pを除いた2人）。入力は1Pの機器（キーボードは1Pの割当と ←→／Enter／Esc）。
 */
export class CpuCharacterSelectScene implements Scene {
  readonly rawKeys = true;
  readonly sel: CpuCharacterSelect;
  private pending: SelectAction[] = [];
  private readonly keyboard: KeyboardController | null;

  constructor(
    private readonly app: App,
    readonly mode: GameMode,
    initial: Character,
  ) {
    this.sel = new CpuCharacterSelect(initial);
    const d = app.settings.devices[0];
    this.keyboard = d.kind === 'keyboard' ? new KeyboardController(0, app.settings.keys[0]) : null;
    app.bus.playBgm('menu');
  }

  onKey(code: string, repeat: boolean): boolean {
    const a = this.keyboard?.actionOf(code);
    if (a) {
      if (a === 'left' || a === 'right') this.pending.push(a);
      else if (!repeat && a === 'launch') this.pending.push('confirm');
      else if (!repeat && a === 'rotate') this.pending.push('back');
      return true;
    }
    if (code === 'ArrowLeft' || code === 'ArrowRight') this.pending.push(code === 'ArrowLeft' ? 'left' : 'right');
    else if (!repeat && (code === 'Enter' || code === 'NumpadEnter' || code === 'Space')) this.pending.push('confirm');
    else if (!repeat && (code === 'Escape' || code === 'Backspace')) this.pending.push('back');
    else return false;
    return true;
  }

  onNav(ev: NavEvent): void {
    if (ev.source.kind !== 'pad') return;
    const d = this.app.settings.devices[0];
    if (d.kind === 'gamepad' && d.index !== ev.source.index) return;
    const act: SelectAction | null = ev.key === 'left' || ev.key === 'right' ? ev.key : ev.key === 'confirm' ? 'confirm' : ev.key === 'back' ? 'back' : null;
    if (act) this.pending.push(act);
  }

  update(): void {
    const bus = this.app.bus;
    for (const act of this.pending.splice(0)) {
      switch (this.sel.input(act)) {
        case 'move':
        case 'dialogMove':
          bus.playSfx('ui_move');
          break;
        case 'open':
        case 'stay':
          bus.playSfx(act === 'back' ? 'ui_cancel' : 'ui_confirm');
          break;
        case 'leave':
          bus.playSfx('ui_cancel');
          return this.app.toMenu([this.mode === 'mode1' ? 'MODE1' : 'MODE2']);
        case 'confirm': {
          const me = this.sel.character;
          bus.playSfx('ui_confirm');
          bus.playVoice(me, 'select', VOICE_PRIORITY.start, 'select');
          this.app.cpuPlayer = me;
          this.app.cpuOpponent = cpuOrderFor(me)[0];
          // 決定の入力は試合へ渡さない（同じフレームの残りの入力は捨てる）
          return this.app.startGame(this.mode, 'cpu', undefined, undefined, { keepSelectVoices: true });
        }
        default:
          break;
      }
    }
  }

  render(ctx: CanvasRenderingContext2D, ms: number): void {
    drawCharacterSelect(ctx, this.app.assets, [this.sel.cursor, this.sel.cursor], [this.sel.confirmed, false], ms, 1);
    drawText(ctx, `${this.mode === 'mode1' ? 'MODE1' : 'MODE2'} CPU対戦`, 572, 18, { align: 'right', size: 12, color: TEXT_COLORS.secondary });
    drawText(ctx, `相手：${cpuOrderFor(this.sel.character).map((c) => CHARACTER_NAME[c]).join('→')}`, 320, 40, { align: 'center', size: 11, color: TEXT_COLORS.secondary });
    drawText(ctx, '左右：選択　発射キー／A：決定　B入れ替えキー／B／Esc：戻る', 320, 346, { align: 'center', size: 9, color: TEXT_COLORS.secondary });
    if (this.sel.dialog !== null) {
      // 背後を暗くしてポップアップ
      ctx.fillStyle = 'rgba(0,0,16,0.5)';
      ctx.fillRect(0, 0, 640, 360);
      drawConfirm(ctx, this.app.assets, 'メニューに戻りますか？', ['戻らない', '戻る'], this.sel.dialog);
    }
  }
}

/** メニュー項目の下の説明文のY（項目数に合わせて項目の直下） */
const MENU_DESC_Y = (n: number) => MENU_ITEM.y + MENU_ITEM.pitch * n + 10;
const MENU_DESC_PITCH = 15;
const MENU_DESC_MAX_W = 300;

/** V320-FIX-04 付録C：承認済みメニュー説明（本文は変更しない。表示の行分けだけ） */
export const MENU_DESC = {
  mode1: '役をそろえてライン消去！　連鎖で高得点と強力な攻撃を狙おう！',
  m1_single: '1人プレイで、ハイスコアに挑戦しよう！',
  endless: '連鎖をつないで得点アップ！　Lv20までのレベルアップに挑戦！',
  stage: '消去ノルマを達成して、次のステージへ進もう！',
  m1_cpu: '好きなキャラを選んで対戦！　役と攻撃でCPUに挑もう！',
  m1_2p: '2人で役と攻撃の真剣勝負！　相手のピンチを狙おう！',
  mode2: '出せるピースを次々に打ち上げよう！　速さと判断力のパズル！',
  m2_single: '全部出し切るまでのタイムに挑戦！　自己ベストを更新しよう！',
  m2_cpu: 'CPUと早出し勝負！　相手より先に全部出し切ろう！',
  m2_2p: '同じ場のカードを取り合う早出し勝負！　先に全部出した方の勝ち！',
  watch: 'キャラと強さを選んで、CPU同士の対戦を観戦しよう！',
  help: '実演を見ながら、操作・役・モードごとの遊び方を覚えよう！',
} as const;

/**
 * メニュー説明の行分け：幅300pxに収まらなければ文の区切り（全角空白）で改行し、なお収まらない行は読点・中黒の後ろで改行する。
 * 文字は縮小しない・本文は変えない（区切りの全角空白は行頭・行末に残さない）
 */
export function menuDescLines(ctx: CanvasRenderingContext2D | null, text: string, measure?: (s: string) => number): string[] {
  const w = measure ?? ((s: string) => (ctx ? ((ctx.font = `600 11px ${UI_FONT}`), ctx.measureText(s).width) : [...s].length * 11));
  if (w(text) <= MENU_DESC_MAX_W) return [text];
  const out: string[] = [];
  for (const seg of text.split('　').filter((x) => x.length > 0)) {
    let rest = seg;
    while (w(rest) > MENU_DESC_MAX_W) {
      const chars = [...rest];
      let cut = -1;
      for (let i = 1; i < chars.length; i++) if ('、。！？・'.includes(chars[i - 1]) && w(chars.slice(0, i).join('')) <= MENU_DESC_MAX_W) cut = i;
      if (cut < 0) break;
      out.push(chars.slice(0, cut).join(''));
      rest = chars.slice(cut).join('');
    }
    out.push(rest);
  }
  return out;
}

// ---------------------------------------------------------------- CPU観戦（V320-FIX-04 第12章）

export interface WatchSettings {
  mode: GameMode;
  left: Character;
  leftLevel: Difficulty;
  right: Character;
  rightLevel: Difficulty;
  firstTo: FirstTo;
  /** MODE1 の自然上昇（ms）：7000／5000／3000 */
  riseMs: 7000 | 5000 | 3000;
}

/** 初期値：MODE1、左アカネ初級、右ずん子初級、2本先取、自然上昇7秒 */
export const defaultWatchSettings = (): WatchSettings => ({ mode: 'mode1', left: 'akane', leftLevel: 'easy', right: 'zunko', rightLevel: 'easy', firstTo: 2, riseMs: 7000 });

export interface WatchLogEntry {
  seed: number;
  mode: GameMode;
  left: { character: Character; level: Difficulty };
  right: { character: Character; level: Difficulty };
  riseMs: number | null;
  round: number;
  winner: 'left' | 'right' | 'draw';
  gameMs: number;
  outcome: string;
  cause: string;
}

const WATCH_CHARS: readonly Character[] = ['kotaro', 'akane', 'zunko'];
const WATCH_RISE: readonly WatchSettings['riseMs'][] = [7000, 5000, 3000];
const RISE_DIFFICULTY: Record<WatchSettings['riseMs'], Difficulty> = { 7000: 'easy', 5000: 'normal', 3000: 'hard' };

/** 左右同キャラ不可：変更時は相手が選んでいるキャラを飛ばして次の候補へ */
export function nextWatchCharacter(cur: Character, other: Character, dir: -1 | 1): Character {
  let i = WATCH_CHARS.indexOf(cur);
  do i = (i + dir + WATCH_CHARS.length) % WATCH_CHARS.length;
  while (WATCH_CHARS[i] === other);
  return WATCH_CHARS[i];
}

export class WatchSettingsScene implements Scene {
  cursor = 0;
  readonly rawKeys = false;

  constructor(private readonly app: App) {
    app.bus.playBgm('menu');
  }

  private get w(): WatchSettings {
    return this.app.watch;
  }

  rows(): OptRowDef[] {
    const w = this.w;
    const adjust = (f: () => void) => () => {
      f();
      this.app.bus.playSfx('ui_adjust');
    };
    const rows: OptRowDef[] = [
      { label: 'モード', value: w.mode === 'mode1' ? 'MODE1' : 'MODE2', arrows: true, change: adjust(() => (w.mode = w.mode === 'mode1' ? 'mode2' : 'mode1')) },
      { label: '左キャラ', value: CHARACTER_NAME[w.left], arrows: true, change: (d) => adjust(() => (w.left = nextWatchCharacter(w.left, w.right, d)))() },
      { label: '左の強さ', value: DIFFICULTY_LABEL[w.leftLevel], arrows: true, change: (d) => adjust(() => (w.leftLevel = cycle(DIFFS, w.leftLevel, d)))() },
      { label: '右キャラ', value: CHARACTER_NAME[w.right], arrows: true, change: (d) => adjust(() => (w.right = nextWatchCharacter(w.right, w.left, d)))() },
      { label: '右の強さ', value: DIFFICULTY_LABEL[w.rightLevel], arrows: true, change: (d) => adjust(() => (w.rightLevel = cycle(DIFFS, w.rightLevel, d)))() },
      { label: '先取本数', value: `${w.firstTo}本先取`, arrows: true, change: (d) => adjust(() => (w.firstTo = cycle([1, 2, 3] as FirstTo[], w.firstTo, d)))() },
    ];
    // MODE2 では自然上昇の項目を出さない
    if (w.mode === 'mode1') rows.push({ label: '自然上昇', value: `${w.riseMs / 1000}秒`, arrows: true, change: (d) => adjust(() => (w.riseMs = cycle(WATCH_RISE, w.riseMs, d)))() });
    rows.push({ label: '観戦開始', confirm: () => this.app.startWatch() }, { label: '戻る', confirm: () => this.app.toMenu(['CPU観戦']) });
    return rows;
  }

  onNav(ev: NavEvent): void {
    const bus = this.app.bus;
    const rows = this.rows();
    switch (ev.key) {
      case 'up':
      case 'down': {
        const n = rows.length;
        this.cursor = (this.cursor + (ev.key === 'up' ? n - 1 : 1)) % n;
        bus.playSfx('ui_move');
        return;
      }
      case 'left':
      case 'right':
        rows[this.cursor].change?.(ev.key === 'left' ? -1 : 1);
        // モード切替で行数が変わっても同じ項目を指す
        this.cursor = Math.min(this.cursor, this.rows().length - 1);
        return;
      case 'confirm': {
        const r = rows[this.cursor];
        if (r.confirm) {
          bus.playSfx('ui_confirm');
          r.confirm();
        } else r.change?.(1);
        return;
      }
      case 'back':
        bus.playSfx('ui_cancel');
        this.app.toMenu(['CPU観戦']);
        return;
      default:
        return;
    }
  }

  update(): void {}

  render(ctx: CanvasRenderingContext2D): void {
    drawOptionPanel(ctx, this.app.assets, 'CPU観戦', this.rows(), this.cursor);
    drawFooter(ctx, this.app.assets, '↑↓：項目　←→：変更　A／Enter：決定　B／Esc：戻る');
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

  constructor(
    private readonly app: App,
    page: OptPage = 'top',
    cursor = 0,
  ) {
    this.page = page;
    this.cursor = cursor;
  }

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
          { label: 'クレジット', note: '制作・音声・素材・フォントの表記とリンク', confirm: () => this.app.setScene(new CreditsScene(this.app)) },
          { label: '遊び方', note: '操作とルールの説明（メインメニューの「遊び方」と同じ）', confirm: () => this.app.openHelp('options') },
          { label: 'デモ再生', note: '説明とデモプレイを最初から再生（ボタンを押すとタイトルへ）', confirm: () => this.app.startDemo('option') },
          { label: '設定初期化', note: 'すべての設定を初期値に戻します（記録は消えません）', confirm: () => (this.confirmReset = 0) },
          { label: '戻る', confirm: () => this.app.toMenu() },
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
      case 'display': {
        // 第17章 B6：固定倍率は実画素の整数倍。収まらない固定倍率は選べない（無効と表示）。「収まる最大」は別の選択肢
        const vp = this.app.deps.viewport();
        const fixed = fixedScaleChoices(vp.w, vp.h, vp.dpr, MAX_FIXED_SCALE);
        const choices: DisplayScale[] = [0, ...fixed.filter((f) => f.enabled).map((f) => f.n)];
        const disabled = fixed.filter((f) => !f.enabled).map((f) => f.n);
        const scaleRow: OptRowDef = {
          label: '画面表示倍率',
          value: s.display.scale === 0 ? '収まる最大' : `×${s.display.scale}`,
          arrows: true,
          note: `実画素の整数倍（devicePixelRatio ${vp.dpr}）。収まらない倍率は選べません`,
          change: (d) => {
            s.display.scale = cycle<DisplayScale>(choices, s.display.scale, d);
            this.app.deps.applyDisplay(s.display);
            this.changed();
          },
        };
        const rows: OptRowDef[] = [scaleRow];
        if (disabled.length > 0)
          rows.push({ label: `${disabled.map((n) => `×${n}`).join('・')}（現在無効）`, value: '選択不可', arrows: true, disabled: true, note: 'この画面の大きさでは収まらないため選べません' });
        rows.push(
          {
            label: '全画面',
            value: s.display.fullscreen ? 'オン' : 'オフ',
            arrows: true,
            note: 'キーボードかマウスで切り替えてください（ブラウザの制限）',
            change: () => this.toggleFullscreen(),
            confirm: () => this.toggleFullscreen(),
          },
          {
            label: '出せるピースの表示',
            value: s.assist ? 'オン' : 'オフ',
            arrows: true,
            note: '今の場へ出せる各列の一番上のピースを囲む（MODE1・MODE2、1P/2P共通）',
            change: () => this.toggleAssist(),
            confirm: () => this.toggleAssist(),
          },
          back,
        );
        return rows;
      }
    }
  }

  private toggleAssist(): void {
    this.s.assist = !this.s.assist;
    this.changed();
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
        let next = this.cursor;
        do next = (next + (ev.key === 'up' ? n - 1 : 1)) % n;
        while (rows[next].disabled && next !== this.cursor);
        if (next !== this.cursor) bus.playSfx('ui_move');
        this.cursor = next;
        return;
      }
      case 'left':
      case 'right':
        if (rows[this.cursor].disabled) return;
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
      audio: '音',
      controls: '操作設定',
      match: '対戦設定',
      display: '表示設定',
      keys0: '1P キー割当',
      keys1: '2P キー割当',
      pads0: '1P ゲームパッド割当',
      pads1: '2P ゲームパッド割当',
    };
    const extra = this.page.startsWith('keys') ? '（Esc・Enter・Tab・F1〜F12 は割当できません）' : '';
    drawOptionPanel(ctx, A, titles[this.page], this.rows(), this.cursor, this.message || extra);
    if (this.confirmReset !== null) drawConfirm(ctx, A, '設定を初期値に戻しますか？', ['いいえ', 'はい'], this.confirmReset);
    drawFooter(ctx, A, this.page === 'audio' ? '上下：項目　左右：変更　A／Enter：決定　B／Esc：戻る' : undefined);
  }
}

// ---------------------------------------------------------------- クレジット（S24）

/** クレジット本文（credits_text.json：編集可能なデータ）をページへ分ける。リンクは選択して開ける */
export function creditPages(lines: readonly string[], links: Readonly<Record<string, string>>, perPage = 8): CreditItem[][] {
  const pages: CreditItem[][] = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage).map((text) => ({ text })));
  const linkItems = Object.entries(links).map(([k, url]) => ({ text: `${k}　${url}`, url }));
  if (linkItems.length) pages.push(linkItems);
  return pages.length ? pages : [[]];
}

export class CreditsScene implements Scene {
  private readonly pages: CreditItem[][];
  private cursor = 0;

  constructor(private readonly app: App) {
    this.pages = creditPages(app.assets.credits.lines, app.assets.credits.links);
    app.creditsPage = Math.min(app.creditsPage, this.pages.length - 1);
  }

  private get page(): CreditItem[] {
    return this.pages[this.app.creditsPage];
  }

  private linkIndices(): number[] {
    return this.page.map((it, i) => (it.url ? i : -1)).filter((i) => i >= 0);
  }

  onNav(ev: NavEvent): void {
    const bus = this.app.bus;
    const links = this.linkIndices();
    switch (ev.key) {
      case 'left':
      case 'right': {
        const n = this.pages.length;
        const next = (this.app.creditsPage + (ev.key === 'left' ? n - 1 : 1)) % n;
        if (next !== this.app.creditsPage) bus.playSfx('ui_move');
        this.app.creditsPage = next;
        this.cursor = 0;
        return;
      }
      case 'up':
      case 'down':
        if (links.length > 1) {
          this.cursor = (this.cursor + (ev.key === 'up' ? links.length - 1 : 1)) % links.length;
          bus.playSfx('ui_move');
        }
        return;
      case 'confirm':
        if (links.length) {
          bus.playSfx('ui_confirm');
          // 外部ブラウザで開く。ページ位置はそのまま
          this.app.deps.openUrl(this.page[links[this.cursor]].url!);
        }
        return;
      case 'back':
        bus.playSfx('ui_cancel');
        this.app.setScene(new OptionsScene(this.app, 'top', 4));
        return;
      default:
        return;
    }
  }

  update(): void {}

  render(ctx: CanvasRenderingContext2D): void {
    const A = this.app.assets;
    drawBackground(ctx, A);
    const links = this.linkIndices();
    drawCredits(ctx, A, this.page, this.app.creditsPage, this.pages.length, links.length ? links[this.cursor] : null);
    drawFooter(ctx, A, links.length ? '左右：ページ切替　上下：リンク選択　A／Enter：開く　B／Esc：戻る' : '左右：ページ切替　B／Esc：戻る');
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
      '受けた攻撃は2秒後にまとめて処理：0.4秒ごとに1段、3段ごとに小休止',
      '待機中（枠の下）の攻撃だけを自分の攻撃で相殺できる',
      '7段で自然上昇・攻撃を迎えると4秒の猶予（1秒後から3・2・1）。6段以下に戻せなければ負け',
      '打上連鎖（3秒以内）で倍率アップ、役連鎖（12秒以内）で攻撃が増える',
    ],
  },
  {
    title: 'MODE1 シングル',
    lines: [
      'ひたすら：消去数でLvが上がる（Lv20でMAX）。Lv11で一度ゆっくりに',
      'ステージクリア：全20ステージ。各ステージの消去ノルマを達成する',
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

  constructor(
    private readonly app: App,
    private readonly back: () => void,
  ) {}

  onNav(ev: NavEvent): void {
    if (ev.key === 'left' || ev.key === 'right' || ev.key === 'confirm') {
      const n = HELP_PAGES.length;
      this.page = (this.page + (ev.key === 'left' ? n - 1 : 1)) % n;
      this.app.bus.playSfx('ui_move');
    } else if (ev.key === 'back') {
      this.app.bus.playSfx('ui_cancel');
      this.back();
    }
  }

  update(): void {}

  render(ctx: CanvasRenderingContext2D): void {
    const A = this.app.assets;
    drawBackground(ctx, A);
    const p = HELP_PAGES[this.page];
    drawReadingPanel(ctx, A, `遊び方：${p.title}`);
    p.lines.forEach((l, i) => drawText(ctx, l, 72, 88 + i * 24, { size: 12, maxWidth: 496 }));
    drawText(ctx, `${this.page + 1} / ${HELP_PAGES.length}`, 572, 282, { align: 'right', size: 11, color: TEXT_COLORS.secondary });
    drawFooter(ctx, A, '左右／A：ページ切替　B／Esc：戻る');
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
  readonly roleNames: RoleNameDirector;
  readonly driver: FixedStepDriver;
  controllers: Controller[] = [];
  keyboards: (KeyboardController | null)[] = [null, null];
  pads: (GamepadController | null)[] = [null, null];
  devices: DeviceChoice[];
  quit: QuitDialog[] = [];
  finalCursor = 0;
  private confirmQueued = false;
  private recorded = false;
  /** V320-FIX-04 MODE2シングルの記録更新（総合・ノーリセット専用）。結果画面の「新記録！」表示用 */
  private mode2Submit: Mode2Submit | null = null;
  private nextAnnouncer: Character = 'kotaro';
  /** 2P対戦のREADY／GO担当の抽選専用の乱数（ゲームの乱数列へ影響させない） */
  private readonly announcerRng: Rng;
  private readonly bgm: BgmId;
  /** 自動検証用：デバッグ入力のキュー（開発ビルドのみキーで使用） */
  readonly debugQueue: Command[] = [];
  /** 開発版だけ：MODE1 対戦の計測（受攻撃の推移を1秒ごとに標本） */
  private recorder: RoundRecorder | null = null;
  /**
   * v3.1.0 開始前待機：盤面の表示準備（最初の描画）が済んでから PRESTART_MS 止めて、既存の試合開始処理（READY→GO）へ進む。
   * シーン開始・新ラウンド・再戦で盤面を準備し直すたびに適用。待機中はゲームを進めず（操作・CPU・自然上昇・攻撃・プレイ時間）、
   * 人の入力は読み捨てて解除後へ持ち越さない。null＝待機していない
   */
  private holdMs: number | null = PRESTART_MS;
  private holdRendered = false;

  /** V320-FIX-04 CPU観戦：結果演出の完了から次ラウンドまでの保持（ms） */
  private watchHoldMs = 0;
  readonly seed: number;

  constructor(
    readonly app: App,
    readonly mode: GameMode,
    readonly kind: 'single' | 'cpu' | '2p' | 'watch',
    readonly singleMode?: SingleMode,
    readonly characters: readonly Character[] = kind === 'single' ? ['kotaro'] : ['kotaro', 'akane'],
    /** CPU観戦の設定（kind＝'watch' のときだけ） */
    readonly watch?: WatchSettings,
  ) {
    const s = app.settings;
    const seed = kind === 'watch' && app.watchFixedSeed !== null ? app.watchFixedSeed >>> 0 : (Math.random() * 4294967295) >>> 0;
    this.seed = seed;
    this.announcerRng = createSeededRng((Math.random() * 4294967295) >>> 0);
    // CPU観戦は左右とも CPU（人間の入力機器・補助表示なし。プレイヤーの対戦設定は使わない・書き換えない）
    this.devices =
      kind === 'watch' && watch
        ? [
            { kind: 'cpu', level: watch.leftLevel },
            { kind: 'cpu', level: watch.rightLevel },
          ]
        : kind === 'cpu'
          ? [s.devices[0], { kind: 'cpu', level: s.npcLevel }]
          : kind === 'single'
            ? [s.devices[0]]
            : [s.devices[0], s.devices[1]];
    const readyMsFor = () => {
      this.nextAnnouncer = this.pickAnnouncer();
      return readyDurationMs(app.bus.voiceDurationMs(this.nextAnnouncer, 'ready'));
    };
    this.session =
      kind === 'single'
        ? new SingleSession({ mode: singleMode ?? 'endless', seed, readyMsFor })
        : kind === 'watch' && watch
          ? new Match({ firstTo: watch.firstTo, difficulty: RISE_DIFFICULTY[watch.riseMs], seed, mode, readyMsFor })
          : new Match({ firstTo: s.firstTo, difficulty: s.difficulty, seed, mode, readyMsFor });
    // 決定入力の受付は演出側（勝者演出の開始後）で判定する
    this.session.resultMinMs = 0;
    this.bgm = kind === 'single' ? 'single' : 'versus';
    app.bus.playBgm(this.bgm);
    this.buildControllers();
    this.view = new GameView(this.game, app.assets);
    // v3.1.0：役名表示の予定（代替攻撃ボイスの抽選を含む）と、宣言SEのゲイン（代表ボイスと同時なら −2dB）を接続
    this.roleNames = new RoleNameDirector(this.game, app.bus, characters, undefined, (Math.random() * 4294967295) >>> 0);
    this.director = new SoundDirector(app.bus, this.game, characters, {
      ...DEFAULT_DIRECTOR_OPTIONS,
      voiceWithDeclare: (p, tick) => this.roleNames.voiceStartsNow(p, tick),
      roleVoiceImminent: () => this.roleNames.roleVoiceImminent(),
      seed: (Math.random() * 4294967295) >>> 0,
    });
    this.staging = new Staging(this.game, app.bus, this.stagingOpts());
    this.driver = new FixedStepDriver({ tickMs: 1000 / 60, step: (info) => this.step(info) });
  }

  get game(): AnyGame {
    return this.session.game;
  }

  private humans(): PlayerId[] {
    return this.devices.map((d, i) => (d.kind !== 'cpu' ? (i as PlayerId) : null)).filter((x): x is PlayerId => x !== null);
  }

  /** READY／GO 担当（第12章）：シングル＝コタロー、CPU対戦＝相手キャラ、2P対戦＝ラウンドごとに両者から等確率（専用乱数）。READYとGOは同じ担当 */
  private pickAnnouncer(): Character {
    if (this.kind === 'single') return 'kotaro';
    if (this.kind === 'cpu') return this.characters[1];
    // 2P対戦・CPU観戦：両者から等確率
    return this.characters[this.announcerRng.next() < 0.5 ? 0 : 1];
  }

  private stagingOpts() {
    return { announcer: this.nextAnnouncer, characters: this.characters, humans: this.humans() };
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
        this.controllers.push(new CpuController(p, d.level, (Math.random() * 1e9) >>> 0, this.characters[p]));
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
  private step(info?: StepInfo): void {
    if (this.holdMs !== null) return; // 新ラウンドの開始前待機に入った後は、同じフレームの残りのtickを進めない
    const s = this.session;
    const before = s.game;
    let cmds: Command[] = [];
    this.controllers.forEach((c) => {
      const out = c.poll(before, info);
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
    this.logWatch();
    this.devMeasure();
  }

  private watchLogged = false;

  /** V320-FIX-04 CPU観戦：ラウンドごとの記録（開発用。SINGLE の正式成績には書かない） */
  private logWatch(): void {
    const w = this.watch;
    const g = this.game;
    if (this.kind !== 'watch' || !w || !g.result || this.watchLogged) return;
    this.watchLogged = true;
    const r = g.result;
    const m = this.session as Match;
    let cause: string = r.outcome;
    if (g.mode === 'mode1' && r.winner !== null) {
      const loser = (g as Game).players[1 - r.winner];
      const ev = [...(g as Game).events].reverse().find((e) => (e.type === 'danger' || e.type === 'attackPinch') && e.player === loser.id && e.state === 'defeat');
      cause = ev ? (ev.type === 'danger' ? 'natural_rise_pinch' : 'attack_pinch') : r.outcome;
    }
    this.app.watchLog.push({
      seed: this.seed,
      mode: w.mode,
      left: { character: w.left, level: w.leftLevel },
      right: { character: w.right, level: w.rightLevel },
      riseMs: w.mode === 'mode1' ? w.riseMs : null,
      round: m.round,
      winner: r.winner === null ? 'draw' : r.winner === 0 ? 'left' : 'right',
      gameMs: Math.round((r.tick - g.playStartTick) * g.tickMs),
      outcome: r.outcome,
      cause,
    });
  }

  /** 開発版だけ：ラウンドごとの計測記録（window.__p2like.metrics()／F8 で保存） */
  private devMeasure(): void {
    if (!this.app.deps.dev || this.game.mode !== 'mode1' || this.kind === 'single' || this.recorderDone) return;
    const g = this.game as Game;
    this.recorder ??= new RoundRecorder(g);
    if (!g.result) return this.recorder.sample();
    this.app.devMetrics.push({ ...this.recorder.finish(), kind: this.kind, characters: this.characters, at: new Date().toISOString() });
    this.recorder = null;
    this.recorderDone = true;
  }

  private recorderDone = false;

  private onNewRound(): void {
    this.recorder = null;
    this.recorderDone = false;
    for (const c of this.controllers) c.reset?.();
    this.debugQueue.length = 0;
    this.confirmQueued = false;
    this.app.bus.stopEffects();
    this.view.reset(this.game);
    this.director.reset(this.game);
    this.roleNames.reset(this.game);
    this.staging.reset(this.game, this.stagingOpts());
    this.finalCursor = 0;
    this.recorded = false;
    this.mode2Submit = null;
    this.watchHoldMs = 0;
    this.watchLogged = false;
    this.holdMs = PRESTART_MS;
    this.holdRendered = false;
  }

  private recordIfDone(): void {
    if (this.recorded || !this.game.result || this.kind !== 'single') return;
    const r = this.app.records;
    const g = this.game;
    const out = g.result!.outcome;
    if (g.mode === 'mode2') {
      if (out === 'clear') {
        // V320-FIX-04：総合ベスト（全正常クリア）とノーリセット専用ベスト（場の更新0回）を独立に判定。達成回数は加算しない
        const m2 = g as Mode2Game;
        this.mode2Submit = submitMode2(r, m2.elapsedTicks(), m2.elapsedMs(), m2.noResetAchiever() === 0);
      }
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
    // CPU観戦：1Pの設定機器（キーボード）から終了確認を開ける（2P入力は不要）
    const owner = this.keyboardOwner() ?? (this.kind === 'watch' ? 0 : null);
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
      for (const k of this.keyboards) if (k && k.player !== dlg.player && k.handleKey(code, repeat, this.app.keyEventAt)) return true;
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
        if (code === 'ArrowUp' || code === 'ArrowDown') this.moveFinal(code === 'ArrowUp' ? -1 : 1);
        else if (code === 'Enter' || code === 'NumpadEnter' || code === 'Space' || launchKey) this.decideFinal();
        return true;
      }
      if (code === 'Enter' || code === 'NumpadEnter' || code === 'Space' || launchKey) this.queueConfirm();
      return true;
    }
    for (const k of this.keyboards) if (k?.handleKey(code, repeat, this.app.keyEventAt)) return true;
    return false;
  }

  onKeyUp(code: string): void {
    for (const k of this.keyboards) if (k?.handleKeyUp(code, this.app.keyEventAt)) return;
  }

  /** v3.2.0 フォーカス喪失：移動予約・入力キューを破棄（ゲームの進行は従来どおり） */
  onVisibility(hidden: boolean): void {
    if (!hidden) return;
    const g = this.game as { clearInputBuffers?: () => void };
    g.clearInputBuffers?.();
    for (const k of this.keyboards) k?.clear();
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
    // CPU観戦：パッドからも1Pとして終了確認・結果の選択を行う
    const player = this.kind === 'watch' ? 0 : this.devices.findIndex((d) => d.kind === 'gamepad' && d.index === padIndex);
    const dlg = this.quit.find((q) => typeof q.source === 'object' && q.source.pad === padIndex);
    if (dlg) {
      if (ev.key === 'left' || ev.key === 'right') this.moveDialog(dlg);
      else if (ev.key === 'confirm') this.decideDialog(dlg);
      else if (ev.key === 'back' || ev.key === 'start') this.closeDialog(dlg);
      return;
    }
    if (this.game.result) {
      if (this.finished) {
        if (ev.key === 'up' || ev.key === 'down') this.moveFinal(ev.key === 'up' ? -1 : 1);
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
      // CPU観戦は中止して観戦設定へ戻る
      if (this.kind === 'watch') {
        this.app.bus.stopEffects();
        this.app.setScene(new WatchSettingsScene(this.app));
      } else this.app.toMenu();
    } else this.closeDialog(d);
  }

  /** 試合終了後の選択肢（第15章）。CPU対戦：勝ち＝次の相手へ／同じ相手と再戦／メニュー、負け＝同じ相手に再挑戦／メニュー。2P：再戦／キャラ選択／メニュー */
  finalChoices(): { label: string; act: 'next' | 'rematch' | 'select' | 'menu' }[] {
    const s = this.session;
    if (this.kind === 'watch')
      return [
        { label: '再戦', act: 'rematch' },
        { label: '観戦設定へ', act: 'select' },
        { label: 'メインメニューへ', act: 'menu' },
      ];
    if (s instanceof Match) {
      if (this.kind === 'cpu') {
        return s.matchWinner === 0
          ? [
              { label: '次の相手へ', act: 'next' },
              { label: '同じ相手と再戦', act: 'rematch' },
              { label: 'キャラ選択へ', act: 'select' },
              { label: 'メニューへ', act: 'menu' },
            ]
          : [
              { label: '同じ相手に再挑戦', act: 'rematch' },
              { label: 'キャラ選択へ', act: 'select' },
              { label: 'メニューへ', act: 'menu' },
            ];
      }
      return [
        { label: '同じキャラで再戦', act: 'rematch' },
        { label: 'キャラ選択へ', act: 'select' },
        { label: 'メニューへ', act: 'menu' },
      ];
    }
    const over = this.game.result?.outcome === 'gameOver';
    return [
      { label: over ? '再挑戦' : 'もう一度', act: 'rematch' },
      { label: 'メニューへ', act: 'menu' },
    ];
  }

  private moveFinal(dir: -1 | 1 = 1): void {
    if (!this.staging.acceptReady) return;
    const n = this.finalChoices().length;
    this.finalCursor = (this.finalCursor + dir + n) % n;
    this.app.bus.playSfx('ui_move');
  }

  private decideFinal(): void {
    if (!this.staging.acceptReady) return;
    const s = this.session;
    const choice = this.finalChoices()[Math.min(this.finalCursor, this.finalChoices().length - 1)];
    this.app.bus.playSfx('ui_confirm');
    switch (choice.act) {
      case 'menu':
        return this.app.toMenu();
      case 'next':
        // 「次の相手へ」だけが相手順を進める（新しい試合＝勝利数は0から）
        this.app.cpuOpponent = nextCpuOpponent(this.app.cpuPlayer, this.app.cpuOpponent);
        return this.app.startGame(this.mode, 'cpu');
      case 'select':
        this.app.bus.stopEffects();
        if (this.kind === 'watch') return this.app.setScene(new WatchSettingsScene(this.app));
        // CPU対戦は現在の1Pキャラを選択位置にして戻る
        if (this.kind === 'cpu') return this.app.setScene(new CpuCharacterSelectScene(this.app, this.mode, this.app.cpuPlayer));
        return this.app.setScene(new CharacterSelectScene(this.app, this.mode));
      case 'rematch': {
        // CPU観戦の再戦：同じ設定・新しいseed（開発用固定seedの指定時だけ同じseed）
        if (this.kind === 'watch') return this.app.startWatch();
        const before = s.game;
        if (s instanceof Match) s.rematch();
        else s.restart();
        this.app.bus.playBgm(this.bgm);
        if (s.game !== before) this.onNewRound();
        return;
      }
    }
  }

  // ---- 進行・描画 ----

  /** 開始前待機中か（自動検証用に公開） */
  get preStartHolding(): boolean {
    return this.holdMs !== null;
  }

  private updateHold(dtMs: number): boolean {
    if (this.holdMs === null) return false;
    // 人の入力は読み捨てる（キーのキュー・パッドの押下状態を更新）。CPU は思考させない
    for (const c of this.controllers) if (!(c instanceof CpuController)) c.poll(this.game);
    if (this.holdRendered) this.holdMs -= dtMs;
    if (this.holdMs > 0) return true;
    this.holdMs = null;
    for (const c of this.controllers) c.reset?.();
    return true;
  }

  update(dtMs: number): void {
    if (this.updateHold(dtMs)) return;
    // ゲームパッドの入力は毎フレーム取得（ロジックは固定ステップ）
    // v3.2.0 r：フレームの時刻を渡し、追いつき処理の各tickに実時刻を対応させる（低fps時の入力受付）
    this.driver.advance(dtMs, this.app.nowMs);
    this.director.sync();
    this.roleNames.update();
    this.staging.update();
    // CPU観戦：敗者→勝者の結果演出の完了（決定を受け付けられる時点）から1500ms保持して次ラウンドへ自動進行
    const s = this.session;
    if (this.kind === 'watch' && s instanceof Match && s.state === 'roundResult' && this.staging.acceptReady) {
      this.watchHoldMs += dtMs;
      if (this.watchHoldMs >= WATCH_ROUND_HOLD_MS) this.confirmQueued = true;
    }
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
      labels: this.devices.length === 2 ? [this.playerLabel(0), this.playerLabel(1)] : undefined,
      result: this.staging.plan,
      // v3.2.0：最終結果でも勝敗演出中は中央「対戦結果」を出さない（左右の勝利・敗北と重ねない）。
      // 「対戦結果」は演出後の結果パネルの見出しとして表示し、再戦・戻る操作は従来どおり
      matchOver: false,
      // v3.2.0 出せるピースの補助表示：人間のプレイヤーだけ（オプションで共通ON/OFF）
      assist: this.app.settings.assist ? this.humans() : [],
      noReset: g.mode === 'mode2' && g.result ? (g as Mode2Game).noResetAchiever() : null,
      characters: this.characters,
      roleLogo: (p, tick) => this.roleNames.logoAt(p, Math.floor(tick)),
      preStart: this.holdMs !== null,
    };
    this.view.render(ctx, t);
    this.holdRendered = true;
    const A = this.app.assets;
    const phase = (['A', 'B', 'C'] as const)[Math.floor(ms / 90) % 3];
    if (g.result && this.staging.acceptReady) {
      if (this.finished || (s instanceof SingleSession && s.state === 'result')) this.drawResult(ctx, phase);
      else if (this.kind !== 'watch') drawText(ctx, '決定（A／Enter／発射）で次のラウンドへ', 320, 18, { align: 'center', size: 10, box: true });
    }
    // CPU観戦中と分かる小さな見出し（中央上部の MODE 表示と場のカードの間。既存表示に掛けない）
    if (this.kind === 'watch' && !this.finished) drawText(ctx, 'CPU観戦中', 320, 24, { align: 'center', size: 10, color: TEXT_COLORS.secondary });
    for (const q of this.quit) {
      const x = q.player === 0 ? 16 : 336;
      drawConfirm(ctx, A, this.kind === 'watch' ? '観戦をやめて設定へ戻りますか？' : `${q.player + 1}P：メニューへ戻りますか？`, ['続ける', '終了する'], q.cursor, x, 110, 'ゲームは止まっていません');
    }
  }

  private playerLabel(p: PlayerId): string {
    const d = this.devices[p];
    const who = d.kind === 'cpu' ? deviceLabel(d).replace('NPC', 'CPU') : `${p + 1}P`;
    return `${who} ${CHARACTER_NAME[this.characters[p]]}`;
  }

  private drawResult(ctx: CanvasRenderingContext2D, phase: 'A' | 'B' | 'C'): void {
    const s = this.session;
    const g = this.game;
    const A = this.app.assets;
    const r = this.app.records;
    const lines: string[] = [];
    let head: string | null = 'show_result';
    let choices = this.finalChoices().map((c) => c.label);
    let hint = '';
    if (s instanceof Match) {
      head = 'extra:result_match_ja'; // 対戦（CPU・2P）の最終結果
      const w = s.matchWinner;
      if (this.kind === 'watch') {
        const lv = (p: PlayerId) => DIFFICULTY_LABEL[p === 0 ? this.watch!.leftLevel : this.watch!.rightLevel];
        lines.push(w === null ? '引分け' : `${w === 0 ? '左' : '右'} ${CHARACTER_NAME[this.characters[w]]}（${lv(w)}）の勝ち`);
      } else if (this.kind === 'cpu') {
        const opp = CHARACTER_NAME[this.characters[1]];
        lines.push(w === 0 ? `勝利！　次の相手：${CHARACTER_NAME[nextCpuOpponent(this.app.cpuPlayer, this.app.cpuOpponent)]}` : `${w === null ? '引分け' : '敗北'}　相手：${opp}`);
      } else lines.push(w === null ? '引分け' : `${w + 1}P WIN　${2 - w}P LOSE`);
      lines.push(`${s.wins[0]} − ${s.wins[1]}（${s.settings.firstTo}本先取・${this.mode === 'mode1' ? 'MODE1' : 'MODE2'}）`);
    } else if (g.mode === 'mode2') {
      const m2 = g as Mode2Game;
      head = 'show_all_clear';
      const up = this.mode2Submit;
      lines.push(`クリアタイム ${formatTime(m2.elapsedMs())}`);
      if (r.mode2Single) lines.push(`ベスト ${formatTime(r.mode2Single.bestMs)}${up?.total ? '　新記録！' : ''}`);
      // ノーリセット達成時だけ専用ベストと更新を出す（更新ありのクリアでは専用欄を出さない）
      if (m2.noResetAchiever() === 0 && r.mode2NoResetBest) lines.push(`ノーリセットクリア！　専用ベスト ${formatTime(r.mode2NoResetBest.bestMs)}${up?.noReset ? '　新記録！' : ''}`);
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
