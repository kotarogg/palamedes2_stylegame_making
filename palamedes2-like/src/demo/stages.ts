// 遊び方・放置デモの「舞台」：教材（LessonRunner）・SINGLE自動・対戦デモ・MODE2説明を、本編と同じ表示（GameView）・
// 効果音とボイス（SoundDirector・RoleNameDirector・Staging）で進める。成績・設定は保存しない（記録処理を呼ばない）。
// 舞台は毎フレーム update で自分の時間だけを進める。破棄後に満了するタイマーを持たない（終了・割り込みで舞台ごと捨てる）。
import type { AudioBus } from '../audio/audioBus';
import type { BgmId, Character } from '../audio/audioMap';
import { DEFAULT_DIRECTOR_OPTIONS, SoundDirector } from '../audio/director';
import { FixedStepDriver } from '../core/driver';
import type { Game, GameEvent } from '../core/game';
import { Match, SingleSession, type AnyGame } from '../core/match';
import type { Mode2Game } from '../core/mode2';
import type { PlayerId, Suit } from '../core/types';
import type { Controller } from '../input/controller';
import { CpuController } from '../input/cpu';
import type { Assets } from '../view/assets';
import { measureBitmap } from '../view/bitmapFont';
import { chainFocusBox } from '../view/chainHud';
import { GameView, type HudInfo } from '../view/gameView';
import { RoleNameDirector, Staging } from '../view/presentation';
import { Mode2LessonRunner, MODE2_LESSON } from './mode2Lesson';
import { LessonRunner, pageText, pieceKind, READ_MS, TUTORIAL_SCRIPT, type LessonDef, type PageKey, type Reading } from './lesson';
import { drawFocus, drawTutorialPanel, PANEL, type HintLayout, type PanelContent } from './panel';
import { SingleAutoController } from './singleAuto';

/** 放置デモの固定値（設計書 第3・7節）。ゲーム設定ではない */
export const DEMO = {
  /** タイトルの無操作でデモ開始 */
  idleMs: 20000,
  fadeOutMs: 600,
  blackMs: 300,
  fadeInMs: 600,
  singleMs: 35000,
  versusMs: 60000,
  /** 進行中処理の区切り待ちの上限 */
  breakWaitMs: 5000,
  /** 決着後、結果演出を見せてから次へ */
  resultHoldMs: 1500,
  lessonSeed: 20261026,
  singleSeed: 7301,
  /** 対戦デモの seed（v3.2.0 の CPU 設定で seed 1〜300 を同じ条件で選び直し：攻撃・相殺が両者とも見え、60秒以内に決着した 60 を選定。旧 92） */
  versusSeed: 60,
  versusCharacters: ['akane', 'zunko'] as const,
} as const;

export interface Stage {
  /** 戻る案内の形式（シングル形式＝右下2行、対戦形式＝中央1行） */
  readonly hint: HintLayout;
  readonly finished: boolean;
  update(dtMs: number): void;
  render(ctx: CanvasRenderingContext2D, ms: number): void;
}

export interface StageHost {
  assets: Assets;
  bus: AudioBus;
}

/** 本編の表示・音の組み合わせ（GameScene と同じ部品） */
class Presenter {
  readonly view: GameView;
  readonly director: SoundDirector;
  readonly roleNames: RoleNameDirector;
  readonly staging: Staging;

  constructor(
    host: StageHost,
    game: AnyGame,
    readonly characters: readonly Character[],
    seed: number,
    skipStart: boolean,
  ) {
    this.view = new GameView(game, host.assets);
    this.roleNames = new RoleNameDirector(game, host.bus, characters, undefined, seed ^ 0x5a5a);
    this.director = new SoundDirector(host.bus, game, characters, {
      ...DEFAULT_DIRECTOR_OPTIONS,
      voiceWithDeclare: (p, tick) => this.roleNames.voiceStartsNow(p, tick),
      roleVoiceImminent: () => this.roleNames.roleVoiceImminent(),
      seed: seed ^ 0xa5a5,
    });
    this.staging = new Staging(game, host.bus, { announcer: characters[characters.length - 1], characters, humans: [], skipStart });
  }

  sync(): void {
    this.director.sync();
    this.roleNames.update();
    this.staging.update();
  }

  render(ctx: CanvasRenderingContext2D, t: number, hud: HudInfo): void {
    this.view.hud = {
      characters: this.characters,
      roleLogo: (p, tick) => this.roleNames.logoAt(p, Math.floor(tick)),
      result: this.staging.plan,
      ...hud,
    };
    this.view.render(ctx, t);
  }
}

const FULL = '０１２３４５６７８９';
export const fullDigits = (n: number): string => String(n).replace(/[0-9]/g, (d) => FULL[Number(d)]);

/** 役の正式名（役名ロゴの表示順 R01〜R16。本体の表示名の対応 roleLogoIndices を使う） */
export function roleDisplayName(logos: readonly number[]): string {
  const names = logos.map((l) => TUTORIAL_SCRIPT.role_list.roles.find((r) => r.logo === l)?.name ?? '');
  return names.filter(Boolean).join('＋');
}

/** 頁ごとの操作アイコン・例ピース（台本の補助。数値は持たない） */
const PAGE_EXTRAS: Partial<Record<PageKey, { icons?: string[]; pieces?: string[] }>> = {
  basic_move: { icons: ['move_left', 'move_right'] },
  rotate: { icons: ['column_cycle'] },
  success1: { icons: ['launch'] },
  success2: { pieces: ['3♠', '6♠'] },
  adjacent_wrap: { pieces: ['1♥', '6♦'] },
  rise: { icons: ['raise'] },
  limit: { icons: ['raise'] },
  natural: { icons: ['raise'] },
  declare: { icons: ['declare_role'] },
  avoid: { icons: ['declare_role'] },
};

export function pageContent(key: PageKey, panel = 0): PanelContent {
  const t = pageText(key);
  const x = PAGE_EXTRAS[key];
  return { heading: t.heading, lines: t.panels[Math.min(panel, t.panels.length - 1)], icons: x?.icons, pieces: x?.pieces?.map(pieceKind) };
}

/**
 * V320-FIX-04 第13.1節 読書の関門：説明ページごとに実時間 READ_MS を確保する。
 * 手動（遊び方）：READ_MS 後に送り案内を出し、新しい決定押下で進む（早い決定は無視・予約しない。押しっぱなしで送らない）。
 * 放置デモ：READ_MS 後に自動で進む。ゲーム時計は止まり、この実時間だけが進む
 */
export class ReadingGate {
  private key = '';
  /** 現在の説明を表示してからの実時間（ms） */
  ms = 0;
  /** 進んだ説明の記録（自動検証用：頁・パネル・表示した実時間・進め方） */
  readonly log: { page: PageKey; panel: number; ms: number; by: 'auto' | 'confirm' }[] = [];

  constructor(readonly manual: boolean) {}

  private sync(r: Reading | null): void {
    const k = r ? `${r.page}#${r.panel}#${this.log.length}` : '';
    if (k !== this.key) {
      this.key = k;
      this.ms = 0;
    }
  }

  /** 実時間を進める。放置デモで読み終えたら true（呼出し側が release） */
  update(r: Reading | null, dtMs: number): boolean {
    this.sync(r);
    if (!r) return false;
    this.ms += dtMs;
    if (!this.manual && this.ms >= READ_MS) {
      this.log.push({ page: r.page, panel: r.panel, ms: this.ms, by: 'auto' });
      return true;
    }
    return false;
  }

  /** 決定押下（手動）。読書時間を満たしていれば true（呼出し側が release）。早い押下は捨てる */
  confirm(r: Reading | null): boolean {
    this.sync(r);
    if (!r || !this.manual || this.ms < READ_MS) return false;
    this.log.push({ page: r.page, panel: r.panel, ms: this.ms, by: 'confirm' });
    return true;
  }

  /** 送り案内（手動で読書時間を満たした後だけ） */
  prompt(r: Reading | null): string | null {
    this.sync(r);
    if (!r || !this.manual || this.ms < READ_MS) return null;
    return TUTORIAL_SCRIPT.advance_hint[r.prompt];
  }
}

/** 読書区間を持つ舞台（遊び方の手動送り・放置デモの自動送り） */
export interface ReadingStage extends Stage {
  readonly gate: ReadingGate;
  readonly reading: Reading | null;
  /** 決定押下（遊び方）。読み終えていなければ何もしない */
  confirm(): void;
}

// ---------------------------------------------------------------- 教材

interface Focus {
  kind: 'col' | 'streak' | 'stock' | 'chain';
  col?: number;
  untilTick: number;
}

/** 教材の舞台（基本操作・4/4/6・ピンチ）。単一プレイヤーのシングル表示（右パネルを説明に使う） */
export class LessonStage implements ReadingStage {
  readonly hint: HintLayout = 'single';
  readonly runner: LessonRunner;
  private readonly presenter: Presenter;
  private readonly driver: FixedStepDriver;
  private cursor = 0;
  private roleInfo: { heading: string; han: number; pieces: { n: number; suit: Suit }[]; clearOnPage: boolean } | null = null;
  private focus: Focus | null = null;
  private advanced = false;
  readonly bgm: BgmId = 'single';
  readonly gate: ReadingGate;

  constructor(
    private readonly host: StageHost,
    readonly def: LessonDef,
    /** 手動閲覧（遊び方）：説明は決定で送る。放置デモ：説明は時間で送る */
    manual = false,
    seed: number = DEMO.lessonSeed,
  ) {
    this.gate = new ReadingGate(manual);
    this.runner = new LessonRunner(def, () => {
      if (this.roleInfo?.clearOnPage) this.roleInfo = null;
    }, { seed });
    this.presenter = new Presenter(host, this.runner.game, ['kotaro'], seed, true);
    this.driver = new FixedStepDriver({ tickMs: this.runner.game.tickMs, step: () => (this.advanced = this.runner.tick() || this.advanced) });
    host.bus.playBgm(this.bgm);
  }

  get finished(): boolean {
    return this.runner.done;
  }

  get game(): Game {
    return this.runner.game;
  }

  get reading(): Reading | null {
    return this.runner.reading.current;
  }

  confirm(): void {
    if (this.gate.confirm(this.reading)) this.runner.releaseReading();
  }

  update(dtMs: number): void {
    this.advanced = false;
    // 読書中はゲームを進めない（教材の時計・飛行・猶予は止まり、読書の実時間だけが進む）
    if (this.gate.update(this.reading, dtMs)) this.runner.releaseReading();
    this.driver.advance(dtMs);
    this.presenter.sync();
    this.scan();
  }

  private scan(): void {
    const g = this.game;
    const ev = g.events as GameEvent[];
    const T = (ms: number) => g.tick + g.ticks(ms);
    for (; this.cursor < ev.length; this.cursor++) {
      const e = ev[this.cursor];
      switch (e.type) {
        case 'rotate':
        case 'launch':
          if (this.def.id === 'basic') this.focus = { kind: 'col', col: e.col, untilTick: T(700) };
          break;
        case 'arrive':
          if (e.success && this.def.id === 'roles') this.focus = { kind: 'streak', untilTick: T(900) };
          break;
        case 'roleAvailable':
          this.focus = { kind: 'stock', untilTick: T(60000) };
          break;
        case 'declare':
          this.roleInfo = { heading: roleDisplayName(e.logos), han: e.result.han, pieces: e.result.subset.map((p) => ({ n: p.n, suit: p.suit })), clearOnPage: false };
          this.focus = { kind: 'chain', untilTick: T(1500) };
          break;
        case 'roleEnd':
          if (this.roleInfo) this.roleInfo.clearOnPage = true;
          break;
        default:
          break;
      }
    }
    if (this.focus && g.tick >= this.focus.untilTick) this.focus = null;
  }

  /** 現在のパネル内容（頁＋宣言中の役名・実例・実際の消去数） */
  panel(): PanelContent {
    const page = this.runner.page;
    const rd = this.reading;
    const base = page ? pageContent(page, rd && rd.page === page ? rd.panel : pageText(page).panels.length - 1) : {};
    const r = this.roleInfo;
    if (!r) return base;
    const fits = measureBitmap(this.host.assets.tutorial?.font.def ?? { glyphs: {}, cell: [16, 16], line_height: 22, format: '' }, r.heading) <= PANEL.heading.w;
    return {
      heading: fits ? r.heading : (base.heading ?? ''),
      // V320-FIX-04：承認済み本文を途中で切らない（宣言前に読書済み）。役処理中は役名・消去数・採択ピースだけを示す
      lines: [`${TUTORIAL_SCRIPT.role_list.labels.clear}${fullDigits(r.han)}${TUTORIAL_SCRIPT.role_list.labels.lines_unit}`],
      pieces: r.pieces,
    };
  }

  render(ctx: CanvasRenderingContext2D): void {
    const g = this.game;
    const t = this.runner.paused ? g.tick : g.tick + this.driver.alpha;
    this.presenter.render(ctx, t, { hideStartBanner: true, hideSingleInfo: true, streakRate: 'attack' });
    drawTutorialPanel(ctx, this.host.assets, this.panel());
    const f = this.focus;
    if (!f) return;
    const v = this.presenter.view;
    const pad = (r: { x: number; y: number; w: number; h: number }, n = 4) => ({ x: r.x - n, y: r.y - n, w: r.w + 2 * n, h: r.h + 2 * n });
    if (f.kind === 'col' && f.col !== undefined) drawFocus(ctx, this.host.assets, pad(v.topPieceRect(0, f.col, t)));
    else if (f.kind === 'stock') drawFocus(ctx, this.host.assets, pad(this.host.assets.layout.pRect(0, 'stock_background'), 2));
    // V320-FIX-03：注目枠は連鎖HUDの縦帯（chainHud.ts の同じ定義）へ追従。教材はシングル表示のため攻撃加算は含めない
    else if (f.kind === 'streak' || f.kind === 'chain') drawFocus(ctx, this.host.assets, pad(chainFocusBox(0, f.kind, !v.isSingleView), 1));
  }
}

// ---------------------------------------------------------------- MODE1 SINGLE ひたすら（自動プレイ）

/** 放置デモ「MODE1 SINGLE ひたすら」：コタロー、Lv1開始。35秒＋区切り待ち最大5秒（ゲームオーバーなら結果演出の後） */
export class SingleDemoStage implements Stage {
  readonly hint: HintLayout = 'single';
  readonly session: SingleSession;
  readonly auto: SingleAutoController;
  private readonly presenter: Presenter;
  private readonly driver: FixedStepDriver;
  private elapsedMs = 0;
  private resultMs = 0;

  constructor(
    private readonly host: StageHost,
    seed: number = DEMO.singleSeed,
  ) {
    this.session = new SingleSession({ mode: 'endless', seed });
    this.session.resultMinMs = 0;
    this.auto = new SingleAutoController(seed ^ 0x1234);
    this.presenter = new Presenter(host, this.session.game, ['kotaro'], seed, false);
    this.driver = new FixedStepDriver({ tickMs: this.session.game.tickMs, step: () => this.session.step(this.auto.poll(this.session.game), false) });
    host.bus.playBgm('single');
  }

  get game(): Game {
    return this.session.game as Game;
  }

  /** 区切り：役処理・飛行中のピースがない */
  atBreak(): boolean {
    const g = this.game;
    return !g.players[0].role && g.flights.length === 0;
  }

  get finished(): boolean {
    if (this.game.result) return this.presenter.staging.acceptReady && this.resultMs >= DEMO.resultHoldMs;
    return (this.elapsedMs >= DEMO.singleMs && this.atBreak()) || this.elapsedMs >= DEMO.singleMs + DEMO.breakWaitMs;
  }

  update(dtMs: number): void {
    this.driver.advance(dtMs);
    this.presenter.sync();
    if (this.game.playing) this.elapsedMs += dtMs;
    if (this.game.result && this.presenter.staging.acceptReady) this.resultMs += dtMs;
  }

  render(ctx: CanvasRenderingContext2D): void {
    this.presenter.render(ctx, this.game.tick + this.driver.alpha, { hideSingleInfo: true });
    drawTutorialPanel(ctx, this.host.assets, pageContent('single_intro'));
  }
}

// ---------------------------------------------------------------- MODE1 対戦（アカネ中級 対 ずん子中級）

/** 放置デモ「MODE1 対戦」：1ラウンド、未決着なら60秒＋区切り待ち最大5秒。勝敗補正なし（既存キャラ設定の中級CPU） */
export class VersusDemoStage implements Stage {
  readonly hint: HintLayout = 'versus';
  readonly match: Match;
  readonly cpus: Controller[];
  private readonly presenter: Presenter;
  private readonly driver: FixedStepDriver;
  private elapsedMs = 0;
  private resultMs = 0;

  constructor(
    host: StageHost,
    seed: number = DEMO.versusSeed,
  ) {
    const [a, b] = DEMO.versusCharacters;
    this.match = new Match({ firstTo: 1, difficulty: 'normal', seed, mode: 'mode1' });
    this.match.resultMinMs = 0;
    this.cpus = [new CpuController(0, 'normal', seed * 7 + 1, a), new CpuController(1, 'normal', seed * 7 + 2, b)];
    this.presenter = new Presenter(host, this.match.game, [a, b], seed, false);
    this.driver = new FixedStepDriver({
      tickMs: this.match.game.tickMs,
      step: () => {
        const g = this.match.game;
        this.match.step(this.match.state === 'round' ? [...this.cpus[0].poll(g), ...this.cpus[1].poll(g)] : [], false);
      },
    });
    host.bus.playBgm('versus');
  }

  get game(): Game {
    return this.match.game as Game;
  }

  atBreak(): boolean {
    const g = this.game;
    return g.players.every((p) => !p.role) && g.flights.length === 0;
  }

  get finished(): boolean {
    if (this.game.result) return this.presenter.staging.acceptReady && this.resultMs >= DEMO.resultHoldMs;
    return (this.elapsedMs >= DEMO.versusMs && this.atBreak()) || this.elapsedMs >= DEMO.versusMs + DEMO.breakWaitMs;
  }

  update(dtMs: number): void {
    this.driver.advance(dtMs);
    this.presenter.sync();
    if (this.game.playing) this.elapsedMs += dtMs;
    if (this.game.result && this.presenter.staging.acceptReady) this.resultMs += dtMs;
  }

  /**
   * 対戦デモの HUD。修正R1：中央の「対戦結果」見出しは出さない（matchOver を渡さない）。左右の勝利／敗北、敗者の落下、
   * 勝者モーション・ボイス、クラッカーは結果演出（hud.result）のまま。本編の結果画面は変えない
   */
  hud(): HudInfo {
    return { wins: this.match.wins, firstTo: 1, round: this.match.round, matchOver: false };
  }

  /** 描画中の GameView（検証用） */
  get view(): GameView {
    return this.presenter.view;
  }

  /** 結果演出の予定（検証用） */
  get resultPlan() {
    return this.presenter.staging.plan;
  }

  render(ctx: CanvasRenderingContext2D): void {
    this.presenter.render(ctx, this.game.tick + this.driver.alpha, this.hud());
  }
}

// ---------------------------------------------------------------- MODE2 説明（遊び方のみ）

/**
 * v3.2.0 MODE2 の説明（遊び方のみ）：指示書 第9節の固定盤面・固定入力を通常の Mode2Game で最後までクリアし、
 * 実イベント（詰まり・カウントダウン・場の更新・クリア）で説明を切り替える。CPU・固定尺のページ送りは使わない。
 * 得点・公式記録は表示も保存もしない。READY／GO は出さない
 */
export class Mode2Stage implements ReadingStage {
  readonly hint: HintLayout = 'single';
  readonly runner: Mode2LessonRunner;
  private readonly presenter: Presenter;
  private readonly driver: FixedStepDriver;
  readonly gate: ReadingGate;

  constructor(
    private readonly host: StageHost,
    manual = false,
  ) {
    this.gate = new ReadingGate(manual);
    this.runner = new Mode2LessonRunner();
    this.presenter = new Presenter(host, this.runner.game, ['kotaro'], MODE2_LESSON.seed, true);
    this.driver = new FixedStepDriver({ tickMs: this.runner.game.tickMs, step: () => void this.runner.tick() });
    host.bus.playBgm('single');
  }

  get page(): PageKey {
    return this.runner.page;
  }

  get game(): Mode2Game {
    return this.runner.game;
  }

  get finished(): boolean {
    return this.runner.done;
  }

  get reading(): Reading | null {
    return this.runner.reading.current;
  }

  confirm(): void {
    if (this.gate.confirm(this.reading)) this.runner.releaseReading();
  }

  update(dtMs: number): void {
    if (this.gate.update(this.reading, dtMs)) this.runner.releaseReading();
    this.driver.advance(dtMs);
    this.presenter.sync();
  }

  render(ctx: CanvasRenderingContext2D): void {
    const g = this.runner.game;
    const t = this.runner.paused || g.result ? g.tick : g.tick + this.driver.alpha;
    this.presenter.render(ctx, t, { hideSingleInfo: true, hideStartBanner: true });
    const rd = this.reading;
    drawTutorialPanel(ctx, this.host.assets, pageContent(this.page, rd && rd.page === this.page ? rd.panel : pageText(this.page).panels.length - 1));
  }
}

export type { PlayerId };
