// 放置デモ（タイトル無操作20秒・オプション「デモ再生」）と遊び方（目次・説明実演・役一覧・MODE2説明）の画面。
// 放置デモ：説明（基本操作→役成立〜打上連鎖・役連鎖→ピンチ）→MODE1 SINGLE ひたすら→MODE1 対戦→暗転してタイトル。
// 終了：新しいキー入力・パッドのボタン／方向・マウスクリック（保持入力・スティックの小さな傾きでは終了しない）。終了操作は消費し、
// タイトルの決定へ連鎖させない。暗転中も受け付ける。非アクティブになったら進行と音を止め、復帰でタイトルへ。音量・倍率は設定を継承し、何も保存しない。
import type { App, Scene } from '../app';
import { computeAttack } from '../core/attack';
import { DEFAULT_CONFIG } from '../core/config';
import { Game } from '../core/game';
import { evaluateSubset, roleLogoIndices } from '../core/roles';
import type { PadSource } from '../input/controller';
import type { NavEvent } from '../ui/menuInput';
import { drawBackground, drawFooter, drawMenuItems, drawMenuTitle, MENU_ITEM } from '../ui/screens';
import { drawFrame } from '../view/assets';
import { drawBitmapText, TUTORIAL_COLORS } from '../view/bitmapFont';
import { GameView } from '../view/gameView';
import { LESSON_BASIC, LESSON_CRACK, LESSON_M1_SINGLE, LESSON_M1_VERSUS, LESSON_PINCH, pieceKind, rolesLesson, TUTORIAL_SCRIPT } from './lesson';
import { drawReturnHint, drawTutorialPanel, PANEL, type HintLayout } from './panel';
import { DEMO, fullDigits, LessonStage, Mode2Stage, SingleDemoStage, VersusDemoStage, type Stage } from './stages';

/**
 * パッドの「新しい」操作だけを拾う（開始時に押していたボタン・傾きは、一度離すまで数えない）。
 * スティックは AXIS_ON を超えた瞬間だけ（小さな傾き・ドリフトでは反応しない）
 */
export class PadEdges {
  static readonly AXIS_ON = 0.7;
  static readonly AXIS_OFF = 0.4;
  private prev = new Map<string, boolean>();

  constructor(private readonly pads: PadSource) {
    this.poll(); // 開始時点の押下を基準にする（開始に使った決定入力を持ち越さない）
  }

  /** 新しく押された入力があれば true */
  poll(): boolean {
    let hit = false;
    for (let i = 0; i < 4; i++) {
      const s = this.pads(i);
      if (!s) continue;
      s.buttons.forEach((b, n) => {
        const id = `${i}:b${n}`;
        const down = !!b?.pressed;
        if (down && !this.prev.get(id) && this.prev.has(id)) hit = true;
        this.prev.set(id, down);
      });
      s.axes.forEach((v, n) => {
        const id = `${i}:a${n}`;
        const was = this.prev.get(id);
        const down = Math.abs(v) >= PadEdges.AXIS_ON || (!!was && Math.abs(v) > PadEdges.AXIS_OFF);
        if (down && was === false) hit = true;
        this.prev.set(id, down);
      });
    }
    return hit;
  }
}

type Phase = 'play' | 'fadeOut' | 'black' | 'fadeIn';

/** 暗転の段階と黒の濃さ（0〜1） */
export function fadeAlpha(phase: Phase, ms: number): number {
  if (phase === 'fadeOut') return Math.min(1, ms / DEMO.fadeOutMs);
  if (phase === 'black') return 1;
  if (phase === 'fadeIn') return Math.max(0, 1 - ms / DEMO.fadeInMs);
  return 0;
}

/** 放置デモの章（順番に新しく作る＝前の章の状態・タイマーを持ち越さない） */
export const DEMO_CHAPTERS: readonly { id: string; make: (app: App) => Stage }[] = [
  { id: 'basic', make: (a) => new LessonStage(a, LESSON_BASIC) },
  { id: 'roles', make: (a) => new LessonStage(a, rolesLesson('all')) },
  { id: 'pinch', make: (a) => new LessonStage(a, LESSON_PINCH) },
  { id: 'single', make: (a) => new SingleDemoStage(a) },
  { id: 'versus', make: (a) => new VersusDemoStage(a) },
];

export class DemoScene implements Scene {
  readonly rawKeys = true;
  private idx = 0;
  stage: Stage | null = null;
  phase: Phase = 'fadeIn';
  private phaseMs = 0;
  /** 終了へ向かっている（割り込み・完走） */
  ending = false;
  /** 暗転中の案内の形式（前の章の形式を保つ） */
  private hintLayout: HintLayout = 'single';
  private suspended = false;
  private readonly pads: PadEdges;
  /** 章の世代（自動検証用）。章を作り直すたびに増える */
  generation = 0;
  readonly startedBy: 'idle' | 'option';

  constructor(
    private readonly app: App,
    startedBy: 'idle' | 'option',
    private readonly chapters = DEMO_CHAPTERS,
  ) {
    this.startedBy = startedBy;
    this.pads = new PadEdges(app.deps.pads);
    app.bus.stopEffects();
    this.startChapter(0);
  }

  get chapterId(): string {
    return this.chapters[this.idx]?.id ?? 'end';
  }

  private startChapter(i: number): void {
    this.idx = i;
    this.app.bus.stopEffects();
    this.stage = this.chapters[i].make(this.app);
    this.hintLayout = this.stage.hint;
    this.generation++;
    this.phase = 'fadeIn';
    this.phaseMs = 0;
  }

  /** 割り込み：入力は消費し、暗転してタイトルへ（区切り待ちより優先） */
  interrupt(): void {
    if (this.ending) return;
    this.ending = true;
    if (this.phase === 'play' || this.phase === 'fadeIn') {
      // 現在の濃さから暗転を続ける（明るさを跳ねさせない）
      const a = fadeAlpha(this.phase, this.phaseMs);
      this.phase = 'fadeOut';
      this.phaseMs = a * DEMO.fadeOutMs;
    }
  }

  onKey(_code: string, repeat: boolean): boolean {
    if (!repeat) this.interrupt();
    return true; // 終了操作は消費する（タイトルの決定へ渡さない）
  }

  onNav(_ev: NavEvent): void {
    // パッドは PadEdges で扱う（MenuInput の操作はここでは使わない）
  }

  onPointer(): void {
    this.interrupt();
  }

  /** 非アクティブ：進行と音を止める。復帰でタイトルへ */
  onVisibility(hidden: boolean): void {
    if (hidden) {
      this.suspended = true;
      this.app.bus.stopEffects();
      this.app.bus.stopBgm();
    } else if (this.suspended) this.toTitle();
  }

  private toTitle(): void {
    this.stage = null;
    this.app.bus.stopEffects();
    this.app.toTitle(true);
  }

  update(dtMs: number): void {
    if (this.suspended) return;
    if (this.pads.poll()) this.interrupt();
    this.phaseMs += dtMs;
    switch (this.phase) {
      case 'fadeIn':
        this.stage?.update(dtMs);
        if (this.phaseMs >= DEMO.fadeInMs) this.go('play');
        return;
      case 'play':
        this.stage?.update(dtMs);
        if (this.stage?.finished) {
          if (this.idx >= this.chapters.length - 1) this.ending = true;
          this.go('fadeOut');
        }
        return;
      case 'fadeOut':
        this.stage?.update(dtMs);
        if (this.phaseMs >= DEMO.fadeOutMs) {
          this.app.bus.stopEffects();
          this.go('black');
        }
        return;
      case 'black':
        if (this.phaseMs < DEMO.blackMs) return;
        if (this.ending) return this.toTitle();
        return this.startChapter(this.idx + 1);
    }
  }

  private go(p: Phase): void {
    this.phase = p;
    this.phaseMs = 0;
  }

  render(ctx: CanvasRenderingContext2D, ms: number): void {
    const a = fadeAlpha(this.phase, this.phaseMs);
    if (this.stage && this.phase !== 'black') this.stage.render(ctx, ms);
    if (a > 0) {
      ctx.save();
      ctx.globalAlpha = a;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, 640, 360);
      ctx.restore();
    }
    // 戻る案内は暗転より手前。フェード・点滅・消灯をしない
    drawReturnHint(ctx, this.app.assets, this.hintLayout);
  }
}

// ---------------------------------------------------------------- 遊び方

type HelpTopic = 'basic' | 'mode1' | 'streak' | 'roles' | 'mode2' | 'text';

/** v3.2.0 目次の順：操作一覧→基本操作→連鎖説明→役一覧→MODE1→MODE2（表示名は台本データ、行き先は同じ順の対応） */
const HELP_TOPICS: readonly HelpTopic[] = ['text', 'basic', 'streak', 'roles', 'mode1', 'mode2'];
export const HELP_ITEMS: { topic: HelpTopic; label: string }[] = TUTORIAL_SCRIPT.help_menu.map((label, i) => ({ topic: HELP_TOPICS[i], label }));

/** 遊び方の目次。呼出元（メインメニュー／オプション）へ戻る */
export class HelpMenuScene implements Scene {
  cursor = 0;

  constructor(
    private readonly app: App,
    readonly from: 'menu' | 'options',
    cursor = 0,
  ) {
    this.cursor = cursor;
    app.bus.playBgm('menu');
  }

  onNav(ev: NavEvent): void {
    const bus = this.app.bus;
    const n = HELP_ITEMS.length;
    if (ev.key === 'up' || ev.key === 'down') {
      this.cursor = (this.cursor + (ev.key === 'up' ? n - 1 : 1)) % n;
      bus.playSfx('ui_move');
    } else if (ev.key === 'confirm') {
      bus.playSfx('ui_confirm');
      this.open(HELP_ITEMS[this.cursor].topic);
    } else if (ev.key === 'back') {
      bus.playSfx('ui_cancel');
      this.app.leaveHelp(this.from);
    }
  }

  private open(t: HelpTopic): void {
    const back = () => this.app.setScene(new HelpMenuScene(this.app, this.from, this.cursor));
    if (t === 'roles') return this.app.setScene(new RoleListScene(this.app, back));
    if (t === 'text') return this.app.openHelpText(back);
    // V320-FIX-06：説明と実演は自動で始まり、実演の全処理完了＋最低表示時間で自動で進む（決定入力は使わない）。
    // MODE1 は「シングル」「対戦」（静止見本の説明）と「ピンチとゲームオーバー」（実演）。連鎖説明はヒビの独立例を含む
    const stages: Record<Exclude<HelpTopic, 'roles' | 'text'>, ((a: App) => Stage)[]> = {
      basic: [(a) => new LessonStage(a, LESSON_BASIC)],
      mode1: [(a) => new LessonStage(a, LESSON_M1_SINGLE), (a) => new LessonStage(a, LESSON_M1_VERSUS), (a) => new LessonStage(a, LESSON_PINCH)],
      streak: [(a) => new LessonStage(a, rolesLesson('all')), (a) => new LessonStage(a, LESSON_CRACK)],
      mode2: [(a) => new Mode2Stage(a)],
    };
    this.app.setScene(new HelpLessonScene(this.app, stages[t], back));
  }

  update(): void {}

  render(ctx: CanvasRenderingContext2D): void {
    const A = this.app.assets;
    drawBackground(ctx, A);
    drawMenuTitle(ctx, '遊び方');
    const pos = { x: MENU_ITEM.x, y: MENU_ITEM.y - 20, pitch: MENU_ITEM.pitch };
    // 既存メニュー項目の枠を再利用し、文字は遊び方用の共通フォントで描く
    drawMenuItems(ctx, A, HELP_ITEMS.map(() => ''), this.cursor, [], pos);
    HELP_ITEMS.forEach((it, i) =>
      drawBitmapText(ctx, A.tutorial?.font, it.label, MENU_ITEM.x + MENU_ITEM.w / 2, pos.y + i * pos.pitch + 8, { align: 'center', color: i === this.cursor ? TUTORIAL_COLORS.outline : TUTORIAL_COLORS.body }),
    );
    drawFooter(ctx, A, '上下：選択　A／Enter：実演する　B／Esc：戻る');
  }
}

/** 遊び方の説明実演（V320-FIX-06：自動進行）。B／Esc で目次へ。最後まで再生したら「もう一度」「戻る」 */
export class HelpLessonScene implements Scene {
  private i = 0;
  stage: Stage;
  /** 最後まで見た後の選択（0＝もう一度、1＝戻る） */
  choice: 0 | 1 | null = null;

  constructor(
    private readonly app: App,
    private readonly makers: ((a: App) => Stage)[],
    private readonly back: () => void,
  ) {
    app.bus.stopEffects();
    this.stage = makers[0](app);
  }

  onNav(ev: NavEvent): void {
    const bus = this.app.bus;
    if (ev.key === 'back') {
      bus.playSfx('ui_cancel');
      this.leave();
      return;
    }
    // 再生中は決定・方向を使わない（進行は自動。入場の決定を持ち越して何かを起こさない）
    if (this.choice === null) return;
    if (ev.key === 'up' || ev.key === 'down' || ev.key === 'left' || ev.key === 'right') {
      this.choice = this.choice === 0 ? 1 : 0;
      bus.playSfx('ui_move');
    } else if (ev.key === 'confirm') {
      bus.playSfx('ui_confirm');
      if (this.choice === 1) return this.leave();
      this.restart();
    }
  }

  private leave(): void {
    this.app.bus.stopEffects();
    this.back();
  }

  private restart(): void {
    this.app.bus.stopEffects();
    this.i = 0;
    this.choice = null;
    this.stage = this.makers[0](this.app);
  }

  update(dtMs: number): void {
    if (this.choice !== null) return;
    this.stage.update(dtMs);
    if (!this.stage.finished) return;
    // V320-FIX-06：説明の移行を理由に効果音・ボイスを一律に止めない（既存の優先順位に任せる）。戻る・もう一度は従来どおり止める
    if (this.i < this.makers.length - 1) this.stage = this.makers[++this.i](this.app);
    else this.choice = 0;
  }

  render(ctx: CanvasRenderingContext2D, ms: number): void {
    this.stage.render(ctx, ms);
    const A = this.app.assets;
    const font = A.tutorial?.font;
    const S = TUTORIAL_SCRIPT.help_choices;
    const o = { outline: TUTORIAL_COLORS.outline };
    if (this.choice === null) {
      // V320-FIX-06：「決定で実演へ」「決定で次へ」の送り案内は廃止。戻る案内だけ出す
      drawBitmapText(ctx, font, 'B/Esc:' + S.back, PANEL.hint.x, PANEL.hint.y + PANEL.hint.step, { ...o, color: TUTORIAL_COLORS.secondary });
      return;
    }
    [S.again, S.back].forEach((label, i) => {
      const on = this.choice === i;
      drawBitmapText(ctx, font, `${on ? '>' : ' '}${label}`, PANEL.hint.x, PANEL.hint.y + i * PANEL.hint.step, { ...o, color: on ? TUTORIAL_COLORS.heading : TUTORIAL_COLORS.body });
    });
  }
}

/** 役一覧（遊び方のみ）：1役ずつ。既存の役名ロゴ・ピースを使い、成立条件・消去・基本攻撃は本体の役データから表示 */
export class RoleListScene implements Scene {
  index = 0;
  private readonly roles = TUTORIAL_SCRIPT.role_list.roles;
  private game: Game;
  private view: GameView;

  constructor(
    private readonly app: App,
    private readonly back: () => void,
  ) {
    app.bus.stopEffects();
    app.bus.playBgm('single');
    this.game = this.makeGame();
    this.view = new GameView(this.game, app.assets);
  }

  /** 表示用の静止したシングル盤面（ゲームは進めない）。手役に役の実例を置き、成立光は本体の役判定で光る */
  private makeGame(): Game {
    const ex = this.roles[this.index].example.map(pieceKind);
    return new Game({
      seed: 1,
      config: { ...DEFAULT_CONFIG, naturalRiseIntervalMs: null },
      single: { kind: 'endless' },
      setup: (g) => {
        g.players[0].roleStock = ex.map((k) => g.factory.make(k.n, k.suit));
        g.players[0].board.cols.forEach((c) => (c.length = 0));
      },
    });
  }

  /** 表示する値（本体の役判定・攻撃計算から） */
  info(i = this.index): { logos: number[]; clear: number; attack: number } {
    const ex = this.roles[i].example.map((c, k) => ({ id: k + 1, ...pieceKind(c) }));
    const r = evaluateSubset(ex);
    // V320-FIX-06：数値表の消去数・基本攻撃数（連鎖なしの通常攻撃力＝基本攻撃数）
    return { logos: roleLogoIndices(r), clear: r.clear, attack: computeAttack(r.baseAttack, 0, 1, DEFAULT_CONFIG.chainBonusMax).power };
  }

  onNav(ev: NavEvent): void {
    const bus = this.app.bus;
    const n = this.roles.length;
    if (ev.key === 'left' || ev.key === 'right') {
      this.index = (this.index + (ev.key === 'left' ? n - 1 : 1)) % n;
      bus.playSfx('ui_move');
      this.game = this.makeGame();
      this.view.reset(this.game);
    } else if (ev.key === 'back') {
      bus.playSfx('ui_cancel');
      this.back();
    }
  }

  update(): void {}

  render(ctx: CanvasRenderingContext2D, ms: number): void {
    const A = this.app.assets;
    const role = this.roles[this.index];
    const L = TUTORIAL_SCRIPT.role_list;
    const v = this.info();
    const t = this.game.playStartTick + this.game.ticks(DEFAULT_CONFIG.timing.goMs) + ms / this.game.tickMs;
    this.view.hud = { hideStartBanner: true, hideSingleInfo: true, characters: ['kotaro'] };
    this.view.render(ctx, t);
    // 役名ロゴ（既存 S7、A/B/C の色替え）を左のフィールド中央に
    const board = A.layout.pRect(0, 'board');
    const letter = (['A', 'B', 'C'] as const)[Math.floor(ms / 90) % 3];
    const f = A.atlas.role(role.logo, letter);
    drawFrame(ctx, A, f, board.x + (board.w - f.w) / 2, board.y + 48);
    drawTutorialPanel(ctx, A, {
      heading: L.categories[role.category as keyof typeof L.categories],
      lines: [...role.condition, `${L.labels.clear}${fullDigits(v.clear)}${L.labels.lines_unit}`, `${L.labels.attack}${fullDigits(v.attack)}${L.labels.lines_unit}`],
      pieces: role.example.map(pieceKind),
    });
    const font = A.tutorial?.font;
    drawBitmapText(ctx, font, `${this.index + 1}/${this.roles.length}`, PANEL.heading.x + PANEL.heading.w, PANEL.heading.y + 2, { align: 'right', color: TUTORIAL_COLORS.secondary });
    const o = { outline: TUTORIAL_COLORS.outline };
    drawBitmapText(ctx, font, TUTORIAL_SCRIPT.help_choices.role_select, PANEL.hint.x, PANEL.hint.y, { ...o, color: TUTORIAL_COLORS.body });
    drawBitmapText(ctx, font, 'B/Esc:' + TUTORIAL_SCRIPT.help_choices.back, PANEL.hint.x, PANEL.hint.y + PANEL.hint.step, { ...o, color: TUTORIAL_COLORS.secondary });
  }
}
