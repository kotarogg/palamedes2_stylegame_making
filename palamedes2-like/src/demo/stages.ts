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
import { GameView, type HudInfo } from '../view/gameView';
import { RoleNameDirector, Staging } from '../view/presentation';
import { LessonRunner, pageText, pieceKind, TUTORIAL_SCRIPT, type LessonDef, type PageKey } from './lesson';
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
  /** 対戦デモの seed（seed 1〜120 を試し、攻撃・相殺が両者とも見え、60秒以内に決着した 92 を選定） */
  versusSeed: 92,
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
  success2: { pieces: ['3♠', '6♠', '1♥', '6♦'] },
  rise: { icons: ['raise'] },
  limit: { icons: ['raise'] },
  natural: { icons: ['raise'] },
  declare: { icons: ['declare_role'] },
  avoid: { icons: ['declare_role'] },
};

export function pageContent(key: PageKey): PanelContent {
  const t = pageText(key);
  const x = PAGE_EXTRAS[key];
  return { heading: t.heading, lines: t.lines, icons: x?.icons, pieces: x?.pieces?.map(pieceKind) };
}

// ---------------------------------------------------------------- 教材

interface Focus {
  kind: 'col' | 'streak' | 'stock' | 'chain';
  col?: number;
  untilTick: number;
}

/** 教材の舞台（基本操作・4/4/6・ピンチ）。単一プレイヤーのシングル表示（右パネルを説明に使う） */
export class LessonStage implements Stage {
  readonly hint: HintLayout = 'single';
  readonly runner: LessonRunner;
  private readonly presenter: Presenter;
  private readonly driver: FixedStepDriver;
  private cursor = 0;
  private roleInfo: { heading: string; han: number; pieces: { n: number; suit: Suit }[]; clearOnPage: boolean } | null = null;
  private focus: Focus | null = null;
  private advanced = false;
  readonly bgm: BgmId = 'single';

  constructor(
    private readonly host: StageHost,
    readonly def: LessonDef,
    /** 手動閲覧（遊び方）では最後に止まる。放置デモでは finished で次へ */
    seed: number = DEMO.lessonSeed,
  ) {
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

  update(dtMs: number): void {
    this.advanced = false;
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
    const base = page ? pageContent(page) : {};
    const r = this.roleInfo;
    if (!r) return base;
    const fits = measureBitmap(this.host.assets.tutorial?.font.def ?? { glyphs: {}, cell: [16, 16], line_height: 22, format: '' }, r.heading) <= PANEL.heading.w;
    return {
      heading: fits ? r.heading : (base.heading ?? ''),
      lines: [...(base.lines ?? []).slice(0, PANEL.body.maxLines - 1), `${TUTORIAL_SCRIPT.role_list.labels.clear}${fullDigits(r.han)}${TUTORIAL_SCRIPT.role_list.labels.lines_unit}`],
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
    else if (f.kind === 'streak') {
      const s = v.streakHudLayout(0);
      drawFocus(ctx, this.host.assets, pad({ x: s.label.x, y: s.label.y, w: Math.max(s.label.w, 96), h: s.numbers.y + s.numbers.h - s.label.y }));
    } else if (f.kind === 'chain') {
      const c = v.roleChainHudLayout(0);
      drawFocus(ctx, this.host.assets, pad({ x: c.label.x, y: c.label.y, w: c.label.w, h: c.digitsY + c.digitsH - c.label.y }, 2));
    }
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

  render(ctx: CanvasRenderingContext2D): void {
    this.presenter.render(ctx, this.game.tick + this.driver.alpha, { wins: this.match.wins, firstTo: 1, round: this.match.round, matchOver: this.match.state === 'matchResult' });
  }
}

// ---------------------------------------------------------------- MODE2 説明（遊び方のみ）

const MODE2_PAGES: PageKey[] = ['mode2_success', 'mode2_goal', 'mode2_refresh', 'mode2_flight', 'mode2_none'];

/** MODE2 の説明（遊び方のみ）：同じ説明パネルと左フィールド。シングルを既存CPU（中級）で進め、頁を順に表示 */
export class Mode2Stage implements Stage {
  readonly hint: HintLayout = 'single';
  readonly session: SingleSession;
  private readonly cpu: CpuController;
  private readonly presenter: Presenter;
  private readonly driver: FixedStepDriver;
  private ms = 0;
  static readonly PAGE_MS = 4500;

  constructor(
    private readonly host: StageHost,
    seed = 4242,
  ) {
    this.session = new SingleSession({ mode: 'mode2', seed });
    this.cpu = new CpuController(0, 'normal', seed, 'kotaro');
    this.presenter = new Presenter(host, this.session.game, ['kotaro'], seed, false);
    this.driver = new FixedStepDriver({ tickMs: this.session.game.tickMs, step: () => this.session.step(this.cpu.poll(this.session.game), false) });
    host.bus.playBgm('single');
  }

  get page(): PageKey {
    return MODE2_PAGES[Math.min(MODE2_PAGES.length - 1, Math.floor(this.ms / Mode2Stage.PAGE_MS))];
  }

  get finished(): boolean {
    return this.ms >= Mode2Stage.PAGE_MS * MODE2_PAGES.length + 1000 || (!!this.session.game.result && this.ms >= Mode2Stage.PAGE_MS * MODE2_PAGES.length);
  }

  update(dtMs: number): void {
    this.driver.advance(dtMs);
    this.presenter.sync();
    this.ms += dtMs;
  }

  render(ctx: CanvasRenderingContext2D): void {
    const g = this.session.game as Mode2Game;
    this.presenter.render(ctx, g.tick + this.driver.alpha, { hideSingleInfo: true });
    drawTutorialPanel(ctx, this.host.assets, pageContent(this.page));
  }
}

export type { PlayerId };
