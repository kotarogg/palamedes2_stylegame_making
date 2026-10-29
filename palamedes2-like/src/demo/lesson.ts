// 遊び方・放置デモの教材（固定盤面・補充日程・台本）を、本編の Game（役判定・消去・タイマー・上昇）で実行する。
// 教材はゲームの入力（Command）と上昇の行供給（rowSource）だけで盤面を進め、ゲーム状態を直接書き換えない
// （初期盤面・場の設定だけは教材の開始状態として setup で与える）。描画・音声に依存しない（単体テスト対象）。
import { MODE1_BALANCE, type Mode1Balance } from '../core/balance';
import { DEFAULT_CONFIG, type GameConfig } from '../core/config';
import { Game, type Action, type Command, type GameEvent, type RiseKind } from '../core/game';
import type { PlayerId, Suit } from '../core/types';
import script from '../data/tutorial_script_v1.json';

export type PageKey = keyof typeof script.pages;

export interface PageText {
  heading: string;
  /** 承認済みの原文（V320-FIX-04 付録A） */
  text: string;
  /** 表示用：ページ（パネル）ごとの行。原文の改行・ページ分割だけ */
  panels: readonly (readonly string[])[];
}

export const TUTORIAL_SCRIPT = script;

export function pageText(key: PageKey): PageText {
  return script.pages[key];
}

/** V320-FIX-04 第13章：説明ページの読書時間（実時間）。この後に送り案内を出す（手動）／次へ進む（放置デモ） */
export const READ_MS = 5000;

/** 読書中の説明：頁・パネル番号と、読み終えた後の行き先（実演へ／次へ） */
export interface Reading {
  page: PageKey;
  panel: number;
  prompt: 'demo' | 'next';
}

/** 読書区間の状態（パネルを順に読み、最後のパネルの後は promptAfter の行き先） */
export class ReadingState {
  current: Reading | null = null;
  private after: 'demo' | 'next' = 'next';
  /** 読み始めた説明の数（自動検証用：パネル単位） */
  count = 0;

  start(page: PageKey, after: 'demo' | 'next'): void {
    this.after = after;
    this.current = { page, panel: 0, prompt: pageText(page).panels.length > 1 ? 'next' : after };
    this.count++;
  }

  /** 読み終えた：次のパネルへ、無ければ読書を終える。戻り値：読書が続くか */
  release(): boolean {
    const c = this.current;
    if (!c) return false;
    const n = pageText(c.page).panels.length;
    if (c.panel + 1 < n) {
      this.current = { page: c.page, panel: c.panel + 1, prompt: c.panel + 2 < n ? 'next' : this.after };
      this.count++;
      return true;
    }
    this.current = null;
    return false;
  }
}

const SUIT: Record<string, Suit> = { s: 'spade', d: 'diamond', c: 'club', h: 'heart' };
const SUIT_MARK: Record<string, Suit> = { '♠': 'spade', '♦': 'diamond', '♣': 'club', '♥': 'heart' };

/** '4s' または '4♠' → 種類 */
export function pieceKind(code: string): { n: number; suit: Suit } {
  const n = Number(code[0]);
  const suit = SUIT[code[1]] ?? SUIT_MARK[code[1]];
  if (!(n >= 1 && n <= 6) || !suit) throw new Error(`bad piece code: ${code}`);
  return { n, suit };
}

/** 上から並べた行（設計書の表記）→ 列ごとの配列 */
function rowsToCols(rows: readonly (readonly string[])[]): string[][] {
  return Array.from({ length: 6 }, (_, c) => rows.map((r) => r[c]));
}

// ---------------------------------------------------------------- 台本の命令

export type LessonOp =
  /**
   * 説明の頁（見出し・本文）。V320-FIX-04：安定状態（飛行・移動・上詰め・役処理・上昇の途中でない）を待ってから
   * ゲームを止めて読書区間に入る（教材の時計・飛行・猶予は進めない）。読み終える条件は呼出し側（手動＝決定、放置デモ＝時間）
   */
  | { op: 'page'; page: PageKey }
  /** ゲームを進めたまま待つ */
  | { op: 'wait'; ms: number }
  /** 左右移動で列 col（0〜5）へ（操作可能になるたびに1歩） */
  | { op: 'move'; col: number }
  /** 操作可能になったら1回だけ入力（rotate・launch・declare など） */
  | { op: 'act'; action: Action }
  /** 起点（直前の成功・役終了など）から ms 後に「成功（到達）」するよう発射する。列は事前に move しておく */
  | { op: 'launchAt'; col: number; atMs: number }
  /** 起点から ms 後に入力 */
  | { op: 'actAt'; action: Action; atMs: number }
  /** 起点を直前の成功到達／役処理終了／現在へ */
  | { op: 'anchor'; on: 'success' | 'roleEnd' | 'now' }
  /** 起点から ms 後に、固定行を供給して手動上昇（手動上昇の重複・上限は本編どおり） */
  | { op: 'riseAt'; row: readonly string[] | null; atMs: number }
  /** イベントが起きるまでゲームを進める（maxMs で打ち切り＝教材の失敗として記録） */
  | { op: 'until'; event: GameEvent['type']; maxMs: number; match?: (e: GameEvent) => boolean }
  /** 教材の終わり */
  | { op: 'end' };

export interface LessonDef {
  id: 'basic' | 'roles' | 'pinch' | 'crack' | 'm1single' | 'm1versus';
  /** 教材の開始状態（場・盤面・手役は空）。盤面は上から並べた行 */
  base: string;
  rows: readonly (readonly string[])[];
  /** 最初に選んでいる列（本編の初期値と同じ 2＝3列目） */
  startCol?: number;
  /** 自然上昇（null＝この教材では起きない。値はシングル本編の Lv1 周期をそのまま使う） */
  naturalRise: boolean;
  /** 自然上昇の最初の残り時間（ms）。省略時は本編の周期どおり */
  firstNaturalRiseMs?: number;
  ops: readonly LessonOp[];
}

/**
 * 教材用のシングル設定：本編のシングル（ひたすら Lv1）と同じ処理を使い、Lv進行だけを止める
 * （Lv上昇の音・周期変化を説明に混ぜない。得点・ベストは表示も保存もしない）。数値の転記はしない
 */
export function lessonBalance(b: Mode1Balance = MODE1_BALANCE): Mode1Balance {
  return { ...b, endless: { ...b.endless, levels: b.endless.levels.map((l) => (l.level === 1 ? { ...l, required_clears_to_next: null } : l)) } };
}

export function lessonConfig(def: LessonDef, base: GameConfig = DEFAULT_CONFIG): GameConfig {
  return { ...base, naturalRiseIntervalMs: def.naturalRise ? base.naturalRiseIntervalMs : null };
}

export interface LessonProblem {
  op: number;
  tick: number;
  message: string;
}

/**
 * 教材の実行：毎tick commands() で入力を作り、Game.step へ渡す。page 命令は onPage で通知。
 * pause 中は paused＝true（呼出し側はゲームを進めない）。行の供給は rowSource を Game へ渡す。
 */
export class LessonRunner {
  readonly game: Game;
  private pc = 0;
  private anchorTick = 0;
  private lastSuccessTick = 0;
  private lastRoleEndTick = 0;
  private cursor = 0;
  private waitUntil: number | null = null;
  private untilStart: number | null = null;
  private moveIssuedTick = -1;
  private actIssued = false;
  private readonly rowsQueued: (readonly string[])[] = [];
  readonly problems: LessonProblem[] = [];
  /** 教材の進行記録（検証用）：発射・宣言・上昇を出した tick */
  readonly log: { tick: number; op: string }[] = [];
  page: PageKey | null = null;
  done = false;
  /** 読書区間（V320-FIX-04）。読書中はゲームを進めない */
  readonly reading = new ReadingState();

  constructor(
    readonly def: LessonDef,
    private readonly onPage: (p: PageKey) => void = () => undefined,
    opts: { seed?: number; config?: GameConfig } = {},
  ) {
    const cfg = opts.config ?? lessonConfig(def);
    this.game = new Game({
      seed: opts.seed ?? 20261026,
      config: cfg,
      single: { kind: 'endless', balance: lessonBalance() },
      rowSource: (_p: PlayerId, kind: RiseKind) => (kind === 'manual' && this.rowsQueued.length ? this.rowsQueued.shift()!.map(pieceKind) : null),
      setup: (g) => {
        const p = g.players[0];
        const k = pieceKind(def.base);
        g.base = g.factory.make(k.n, k.suit);
        rowsToCols(def.rows).forEach((codes, c) => {
          p.board.cols[c] = codes.map((code) => ({ kind: 'piece' as const, piece: g.factory.make(pieceKind(code).n, pieceKind(code).suit) }));
        });
        p.selectedCol = def.startCol ?? p.selectedCol;
        if (def.firstNaturalRiseMs !== undefined && p.riseIntervalTicks !== null) p.riseCountdown = g.ticks(def.firstNaturalRiseMs);
      },
    });
    // READY／GO は教材では出さない：入力受付の開始（playStartTick）まで進めてから始める（その間ゲームは何も起きない）
    while (!this.game.playing) this.game.step();
    this.cursor = this.game.events.length;
    this.anchorTick = this.game.tick;
  }

  /** 読書中（ゲームは止まっている） */
  get paused(): boolean {
    return this.reading.current !== null;
  }

  /** 読み終えた（呼出し側の条件を満たした）：次のパネルへ、または読書を終えて台本を進める */
  releaseReading(): void {
    this.reading.release();
  }

  /** 1tick 分の進行（読書中はゲームを進めない）。戻り値：このtickにゲームを進めたか */
  tick(): boolean {
    if (this.done) return false;
    this.scanEvents();
    if (this.paused) return false;
    const cmds = this.run();
    if (this.done || this.paused) return false;
    this.game.step(cmds);
    return true;
  }

  /** 読書区間を置ける安定状態：飛行・移動・上詰め等の硬直・役処理・手動上昇の途中でない */
  private stable(): boolean {
    const g = this.game;
    const p = g.players[0];
    return !g.flights.some((f) => f.player === 0) && !g.isMoving(p) && !g.isLocked(p) && !p.role && g.tick + 1 >= p.manualRiseEndTick;
  }

  /** 頁の後の行き先：次の頁（または終わり）までに実演（操作・待ち）があれば「実演へ」 */
  private promptAfter(from: number): 'demo' | 'next' {
    for (let i = from; i < this.def.ops.length; i++) {
      const op = this.def.ops[i];
      if (op.op === 'page' || op.op === 'end') return 'next';
      if (op.op !== 'anchor') return 'demo';
    }
    return 'next';
  }

  private scanEvents(): void {
    const ev = this.game.events;
    for (; this.cursor < ev.length; this.cursor++) {
      const e = ev[this.cursor];
      if (e.type === 'arrive' && e.success) this.lastSuccessTick = e.tick;
      else if (e.type === 'roleEnd') this.lastRoleEndTick = e.tick;
    }
  }

  private problem(message: string): void {
    this.problems.push({ op: this.pc, tick: this.game.tick, message });
  }

  /** 次のtickへ渡す入力。命令を進められるだけ進める */
  private run(): Command[] {
    const g = this.game;
    const p = g.players[0];
    const next = g.tick + 1; // Game.step は tick を進めてから入力を処理する
    const ready = () => !g.isLocked(p) && !g.isMoving(p) && !p.defeated && !g.result;
    for (let guard = 0; guard < 64; guard++) {
      const op = this.def.ops[this.pc];
      if (!op) {
        this.done = true;
        return [];
      }
      switch (op.op) {
        case 'page':
          // 実演の途中（飛行・3/2/1・役処理）に読書を挟まない：安定状態までゲームを進めてから読む
          if (!g.result && !this.stable()) return [];
          this.page = op.page;
          this.onPage(op.page);
          this.pc++;
          this.reading.start(op.page, this.promptAfter(this.pc));
          return [];
        case 'wait':
          this.waitUntil ??= g.tick + g.ticks(op.ms);
          if (g.tick < this.waitUntil) return [];
          this.waitUntil = null;
          this.pc++;
          continue;
        case 'anchor':
          this.anchorTick = op.on === 'success' ? this.lastSuccessTick : op.on === 'roleEnd' ? this.lastRoleEndTick : g.tick;
          this.pc++;
          continue;
        case 'move': {
          if (p.selectedCol === op.col && !g.isMoving(p)) {
            this.pc++;
            continue;
          }
          if (p.selectedCol === op.col || !ready() || this.moveIssuedTick === g.tick) return [];
          this.moveIssuedTick = g.tick;
          return [{ player: 0, type: p.selectedCol < op.col ? 'right' : 'left' }];
        }
        case 'act':
          if (this.actIssued) {
            this.actIssued = false;
            this.pc++;
            continue;
          }
          if (!ready()) return [];
          this.actIssued = true;
          this.log.push({ tick: next, op: op.action });
          return [{ player: 0, type: op.action }];
        case 'actAt':
        case 'launchAt':
        case 'riseAt': {
          if (this.actIssued) {
            this.actIssued = false;
            this.pc++;
            continue;
          }
          const lead = op.op === 'launchAt' ? g.ticks(g.config.timing.launchMs) : 0;
          const at = Math.max(this.anchorTick + 1, this.anchorTick + g.ticks(op.atMs) - lead);
          if (next < at) return [];
          if (op.op === 'launchAt' && p.selectedCol !== op.col) {
            this.problem(`launchAt: 列${op.col + 1}へ移動が間に合わない（現在 列${p.selectedCol + 1}）`);
            return [];
          }
          const action: Action = op.op === 'launchAt' ? 'launch' : op.op === 'riseAt' ? 'manualRise' : op.action;
          const can = action === 'manualRise' ? !g.isLocked(p) && next >= p.manualRiseEndTick && !g.result : ready();
          if (!can) {
            if (next === at) this.problem(`${op.op}: 予定時刻に操作できない（硬直・移動・上昇中）`);
            return [];
          }
          if (next > at) this.problem(`${op.op}: 予定より ${next - at}tick 遅れ`);
          if (op.op === 'riseAt' && op.row) this.rowsQueued.push(op.row);
          this.actIssued = true;
          this.log.push({ tick: next, op: action });
          return [{ player: 0, type: action }];
        }
        case 'until': {
          this.untilStart ??= g.tick;
          const hit = g.events.slice(this.cursorAtUntil()).some((e) => e.type === op.event && (!op.match || op.match(e)));
          if (hit) {
            this.untilStart = null;
            this.untilFrom = null;
            this.pc++;
            continue;
          }
          if (g.tick - this.untilStart >= g.ticks(op.maxMs)) {
            this.problem(`until ${op.event}: ${op.maxMs}ms 以内に起きない`);
            this.untilStart = null;
            this.untilFrom = null;
            this.pc++;
            continue;
          }
          return [];
        }
        case 'end':
          this.done = true;
          return [];
      }
    }
    return [];
  }

  private untilFrom: number | null = null;

  /** until の対象は、その until 命令に入った時点以降のイベント */
  private cursorAtUntil(): number {
    this.untilFrom ??= this.game.events.length;
    return this.untilFrom;
  }
}

// ---------------------------------------------------------------- 教材定義（設計書 第6節）

/**
 * 基本操作：場3♠、手役空。列2を3回入替→列1の2♠成功→列3の4♦失敗（場2♠）→帰還待ち→上昇。
 * V320-FIX-04：各頁は読書区間（ゲーム停止）の後に実演。打ち上げ成功の補足（同じマーク・1と6）は静止の例ピースで説明
 */
export const LESSON_BASIC: LessonDef = {
  id: 'basic',
  base: '3♠',
  rows: [
    ['2♠', '5♥', '4♦', '1♣', '6♠', '3♦'],
    ['6♥', '3♣', '5♠', '2♦', '4♥', '1♠'],
    ['3♦', '2♠', '1♥', '5♣', '2♣', '6♦'],
  ],
  naturalRise: false,
  ops: [
    { op: 'page', page: 'basic_move' },
    { op: 'move', col: 1 },
    { op: 'wait', ms: 400 },
    { op: 'move', col: 3 },
    { op: 'wait', ms: 400 },
    { op: 'move', col: 1 },
    { op: 'wait', ms: 600 },
    { op: 'page', page: 'rotate' },
    { op: 'act', action: 'rotate' },
    { op: 'wait', ms: 700 },
    { op: 'act', action: 'rotate' },
    { op: 'wait', ms: 700 },
    { op: 'act', action: 'rotate' },
    { op: 'wait', ms: 700 },
    { op: 'page', page: 'success1' },
    { op: 'move', col: 0 },
    { op: 'act', action: 'launch' },
    { op: 'until', event: 'arrive', maxMs: 1000 },
    { op: 'wait', ms: 800 },
    { op: 'page', page: 'success2' },
    { op: 'page', page: 'adjacent_wrap' },
    { op: 'page', page: 'fail' },
    { op: 'move', col: 2 },
    { op: 'act', action: 'launch' },
    { op: 'until', event: 'returned', maxMs: 3000 },
    { op: 'wait', ms: 500 },
    { op: 'page', page: 'rise' },
    { op: 'act', action: 'manualRise' },
    { op: 'wait', ms: 1500 },
    { op: 'end' },
  ],
};

/** 4/4/6 共用教材の取得・宣言の時間（設計書 第6節「時間」。教材の台本値でゲーム設定ではない） */
export const ROLES_TIMING = { successGapMs: 1200, declare1Ms: 300, declare2Ms: 500, declare3Ms: 800, rowA_Ms: 250, rowB_Ms: 0, rowC_Ms: 300, rowD_Ms: 150, rowE_Ms: 400, rowF_Ms: 0 } as const;

/** 4/4/6 共用教材の補充行（設計書 第6節） */
export const ROLES_ROWS = {
  A: ['6♦', '1♣', '5♦', '2♣', '5♥', '6♠'],
  B: ['1♥', '2♠', '3♥', '4♠', '2♦', '5♣'],
  C: ['5♦', '1♣', '6♦', '2♣', '3♣', '1♦'],
  D: ['2♣', '6♦', '1♣', '5♦', '4♣', '2♦'],
  E: ['6♦', '3♣', '2♦', '1♣', '5♦', '4♣'],
  F: ['3♠', '1♥', '5♣', '2♦', '4♥', '6♣'],
} as const;

function acquire(cols: readonly number[], firstAnchor: 'roleEnd' | 'now', gap: number, pagesAt: Partial<Record<number, PageKey>> = {}): LessonOp[] {
  const ops: LessonOp[] = [{ op: 'anchor', on: firstAnchor }];
  cols.forEach((c, i) => {
    if (i > 0) ops.push({ op: 'anchor', on: 'success' });
    ops.push({ op: 'move', col: c });
    ops.push({ op: 'launchAt', col: c, atMs: gap });
    ops.push({ op: 'until', event: 'arrive', maxMs: gap + 1000 });
    const pg = pagesAt[i + 1];
    if (pg) ops.push({ op: 'page', page: pg });
  });
  return ops;
}

/**
 * 4/4/6 共用教材（4個フォーカード→4個フラッシュ→6個スーパーストレート）。教材内で盤面を再設定しない。
 * V320-FIX-04：説明は取得前・宣言前・役処理の終了後（安定状態）に読書区間として置く。読書中はゲーム時計が止まるため、
 * 打上連鎖・役連鎖の猶予を消費しない。宣言は読書の直後（取得の起点からの固定時刻ではない）
 */
export function rolesLesson(part: 'all' | 'first' = 'all'): LessonDef {
  const T = ROLES_TIMING;
  const g = T.successGapMs;
  const first: LessonOp[] = [
    { op: 'page', page: 'role_ready' },
    { op: 'move', col: 0 },
    { op: 'wait', ms: 200 },
    ...acquire([0, 1, 2, 3], 'now', g),
    { op: 'page', page: 'declare' },
    { op: 'act', action: 'declare' },
    { op: 'until', event: 'roleEnd', maxMs: 6000 },
    { op: 'page', page: 'line_clear' },
  ];
  if (part === 'first') return { ...ROLES_BASE, ops: [...first, { op: 'end' }] };
  return {
    ...ROLES_BASE,
    ops: [
      ...first,
      { op: 'page', page: 'streak' },
      ...acquire([0, 1, 2, 3], 'roleEnd', g, { 3: 'streak_rate' }),
      { op: 'anchor', on: 'success' },
      { op: 'riseAt', row: ROLES_ROWS.A, atMs: T.rowA_Ms },
      { op: 'page', page: 'flush' },
      { op: 'act', action: 'declare' },
      { op: 'until', event: 'roleEnd', maxMs: 6000 },
      { op: 'page', page: 'chain' },
      { op: 'anchor', on: 'roleEnd' },
      { op: 'riseAt', row: ROLES_ROWS.B, atMs: T.rowB_Ms },
      { op: 'riseAt', row: ROLES_ROWS.C, atMs: T.rowC_Ms },
      ...acquire([0, 1, 2, 3, 4, 5], 'roleEnd', g),
      { op: 'anchor', on: 'success' },
      { op: 'riseAt', row: ROLES_ROWS.D, atMs: T.rowD_Ms },
      { op: 'riseAt', row: ROLES_ROWS.E, atMs: T.rowE_Ms },
      { op: 'actAt', action: 'declare', atMs: T.declare3Ms },
      { op: 'until', event: 'roleEnd', maxMs: 6000 },
      { op: 'page', page: 'chain3' },
      { op: 'anchor', on: 'roleEnd' },
      { op: 'riseAt', row: ROLES_ROWS.F, atMs: T.rowF_Ms },
      { op: 'wait', ms: 1000 },
      { op: 'end' },
    ],
  };
}

const ROLES_BASE: Omit<LessonDef, 'ops'> = {
  id: 'roles',
  base: '3♠',
  rows: [
    ['4♠', '4♥', '4♠', '4♥', '2♣', '5♦'],
    ['6♦', '1♣', '5♦', '2♣', '3♥', '1♣'],
    ['3♥', '5♥', '2♥', '6♥', '5♦', '2♣'],
    ['1♣', '6♦', '2♣', '5♦', '2♥', '4♣'],
  ],
  naturalRise: false,
};

/**
 * ピンチ：手動上昇を上限まで→（説明を読む）→自然上昇の時刻→4秒猶予（1秒後から3/2/1）→ゲームオーバー→結果の説明。
 * V320-FIX-04：猶予の3→2→1の途中に読書を挟まない（説明は直前の安定状態でまとめて読み、結果は終了後に読む）。
 * 盤面・補充行は設計書に指定がないため、教材の乱数（固定seed）で作る。自然上昇の周期・猶予は本編の値
 */
export const LESSON_PINCH: LessonDef = {
  id: 'pinch',
  base: '3♠',
  rows: [
    ['5♣', '2♦', '6♠', '1♥', '4♣', '3♦'],
    ['2♥', '6♣', '3♠', '5♦', '1♣', '4♥'],
    ['4♦', '1♠', '5♥', '2♣', '6♦', '3♣'],
    ['6♥', '3♦', '1♣', '4♠', '2♠', '5♣'],
  ],
  naturalRise: true,
  firstNaturalRiseMs: 4000,
  ops: [
    { op: 'page', page: 'limit' },
    { op: 'act', action: 'manualRise' },
    { op: 'wait', ms: 300 },
    { op: 'act', action: 'manualRise' },
    { op: 'wait', ms: 300 },
    { op: 'act', action: 'manualRise' },
    { op: 'wait', ms: 300 },
    { op: 'page', page: 'natural' },
    { op: 'page', page: 'pinch' },
    { op: 'page', page: 'attack_pinch' },
    { op: 'page', page: 'avoid' },
    { op: 'until', event: 'pinchWarn', maxMs: 8000, match: (e) => e.type === 'pinchWarn' && e.state === 'start' },
    { op: 'until', event: 'roundEnd', maxMs: 6000 },
    { op: 'page', page: 'miss' },
    { op: 'end' },
  ],
};

/**
 * V320-FIX-04 連鎖切り予約（ヒビ）の独立例：場3♠。2♠・1♥を成功（打上連鎖2）→4♦失敗でヒビ→5♣失敗で連鎖が切れる。
 * 成功継続の 4/4/6 教材とは別の盤面（4/4/6 を壊さない）
 */
export const LESSON_CRACK: LessonDef = {
  id: 'crack',
  base: '3♠',
  rows: [
    ['2♠', '1♥', '4♦', '5♣', '6♥', '3♦'],
    ['6♥', '3♣', '5♠', '2♦', '4♥', '1♠'],
    ['3♦', '2♠', '1♥', '5♣', '2♣', '6♦'],
  ],
  startCol: 0,
  naturalRise: false,
  ops: [
    { op: 'page', page: 'streak_crack' },
    { op: 'act', action: 'launch' },
    { op: 'until', event: 'arrive', maxMs: 1000 },
    { op: 'move', col: 1 },
    { op: 'act', action: 'launch' },
    { op: 'until', event: 'arrive', maxMs: 1000 },
    { op: 'move', col: 2 },
    { op: 'act', action: 'launch' },
    { op: 'until', event: 'streakCut', maxMs: 1000, match: (e) => e.type === 'streakCut' && e.state === 'reserved' },
    { op: 'wait', ms: 600 },
    { op: 'move', col: 3 },
    { op: 'act', action: 'launch' },
    { op: 'until', event: 'streakCut', maxMs: 1000, match: (e) => e.type === 'streakCut' && e.state === 'ended' },
    { op: 'wait', ms: 1500 },
    { op: 'end' },
  ],
};

/** V320-FIX-04 MODE1 の説明（静止見本）：シングル（ひたすら・ステージ・ノルマ）。実演はしない */
export const LESSON_M1_SINGLE: LessonDef = {
  id: 'm1single',
  base: '3♠',
  rows: ROLES_BASE_ROWS(),
  naturalRise: false,
  ops: [{ op: 'page', page: 'm1_single' }, { op: 'page', page: 'm1_endless' }, { op: 'page', page: 'm1_stage' }, { op: 'page', page: 'm1_quota' }, { op: 'end' }],
};

/** V320-FIX-04 MODE1 の説明（静止見本）：対戦（目的・相殺・勝利条件）。対戦を実演したとは扱わない */
export const LESSON_M1_VERSUS: LessonDef = {
  id: 'm1versus',
  base: '3♠',
  rows: ROLES_BASE_ROWS(),
  naturalRise: false,
  ops: [{ op: 'page', page: 'm1_versus' }, { op: 'page', page: 'm1_counter' }, { op: 'page', page: 'm1_win' }, { op: 'end' }],
};

function ROLES_BASE_ROWS(): string[][] {
  return ROLES_BASE.rows.map((r) => [...r]);
}
