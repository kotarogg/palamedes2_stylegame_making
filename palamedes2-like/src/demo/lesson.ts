// 遊び方・放置デモの教材（固定盤面・補充日程・台本）を、本編の Game（役判定・消去・タイマー・上昇）で実行する。
// 教材はゲームの入力（Command）と上昇の行供給（rowSource）だけで盤面を進め、ゲーム状態を直接書き換えない
// （初期盤面・場の設定だけは教材の開始状態として setup で与える）。描画・音声に依存しない（単体テスト対象）。
import { MODE1_BALANCE, type Mode1Balance } from '../core/balance';
import { DEFAULT_CONFIG, type GameConfig } from '../core/config';
import { Game, type Action, type Command, type GameEvent, type RiseKind } from '../core/game';
import type { PlayerId, Suit } from '../core/types';
import script from '../data/tutorial_script_v1.json';
import helpTiming from '../data/help_timing_fix06.json';

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

/**
 * V320-FIX-06 第7章：説明項目の最低表示時間。項目へ入った時点を経過0とし、
 * 「その項目の実演に属する全処理の完了」かつ「最低表示時間の経過」で次の項目へ進む（決定入力は使わない）。
 * 初期値＝max（floorMs, baseMs＋本文の文字数÷charsPerSec 秒）。設定は src/data/help_timing_fix06.json（項目別の上書き可）
 */
export const HELP_TIMING = helpTiming as { floorMs: number; baseMs: number; charsPerSec: number; perPageMs: Partial<Record<string, number>> };

/** 本文の文字数（句読点を数え、空白・全角空白・改行を除く） */
export function countTextChars(text: string): number {
  return [...text.replace(/[\s\u3000]/g, '')].length;
}

/**
 * 項目の最低表示時間（ms。小数を含む）。項目内で別の頁の説明へ切り替える場合（V320-FIX-06-R1）は、
 * 項目に属する説明すべての文字数で初期式を計算する。perPageMs に項目の頁（最初の頁）があればその値
 */
export function minDisplayMs(page: PageKey, also: readonly PageKey[] = []): number {
  const o = HELP_TIMING.perPageMs[page];
  if (o !== undefined) return o;
  const pages = [...new Set([page, ...also])];
  const chars = pages.reduce((n, p) => n + countTextChars(pageText(p).text), 0);
  return Math.max(HELP_TIMING.floorMs, HELP_TIMING.baseMs + (chars / HELP_TIMING.charsPerSec) * 1000);
}

/** 項目の最低表示時間（tick、切り上げ） */
export function minDisplayTicks(page: PageKey, tickRate = 60, also: readonly PageKey[] = []): number {
  return Math.ceil((minDisplayMs(page, also) * tickRate) / 1000 - 1e-9);
}

/** 照合用に記録する実イベントの種類 */
const SYNC_EVENTS = new Set(['move', 'rotate', 'launch', 'arrive', 'returned', 'rise', 'roleAvailable', 'declare', 'lineClear', 'attack', 'roleEnd', 'streakCut', 'pinchWarn', 'danger', 'roundEnd', 'stuck', 'countdown', 'cardRefresh']);

/** 実イベント（MODE1・MODE2 共通の最小形） */
export interface SyncEvent {
  type: string;
  tick: number;
  [k: string]: unknown;
}

/**
 * V320-FIX-06-R1 説明の切替（実イベント同期）：項目の中で、条件のイベントが起きた時点で説明を切り替える。
 * 手順は順番に評価する（前の切替が起きるまで次の条件は数えない）。page 省略時は項目の頁、panel 省略時は0
 */
export interface TextStep {
  on: string;
  match?: (e: SyncEvent) => boolean;
  /** 何回目の一致で切り替えるか（既定1） */
  count?: number;
  page?: PageKey;
  panel?: number;
}

/** 表示した説明の区間（照合用） */
export interface TextSegment {
  page: PageKey;
  panel: number;
  /** 表示開始（項目時計 tick）と、その時のゲーム tick */
  startTick: number;
  gameTick: number;
  /** 切替のきっかけ：start（項目開始）／time（文字だけの項目の文字数按分）／イベント種類@ゲームtick */
  trigger: string;
  endTick: number | null;
}

/** 1項目の記録（検証・報告用。tick は項目時計＝舞台の開始からの tick） */
export interface ItemRecord {
  page: PageKey;
  startTick: number;
  minTicks: number;
  /** 実演に属する全処理が完了した tick（文字だけの項目は開始と同じ） */
  doneTick: number | null;
  /** 次の項目へ移った（または教材を終えた）tick */
  endTick: number | null;
  /** 表示した説明の区間（頁・パネル・時刻・きっかけ） */
  segments: TextSegment[];
  /** 項目中の実イベント（照合用：種類・ゲームtick・取り込んだ項目時計 tick・要約） */
  events: { type: string; gameTick: number; tick: number; detail: string }[];
}

const eventDetail = (e: SyncEvent): string => {
  const keys = ['col', 'success', 'streak', 'state', 'reason', 'count', 'value', 'chainCount', 'index', 'planned', 'heightAfter', 'kind', 'outcome', 'logos'];
  return keys
    .filter((k) => e[k] !== undefined)
    .map((k) => `${k}=${Array.isArray(e[k]) ? (e[k] as unknown[]).join('+') : String(e[k])}`)
    .join(' ');
};

/**
 * 項目の時計（V320-FIX-06／R1）：舞台の1tickごとに clock を進める（実演の停止中も進む）。
 * 説明の切替は、手順（steps）があれば実イベントに同期し、無い複数パネルの頁（文字だけの項目）は最低表示時間を文字数で按分した時刻。
 * 最後の説明は項目の終わりまで表示する
 */
export class ItemClock {
  clock = 0;
  current: ItemRecord | null = null;
  readonly log: ItemRecord[] = [];
  private offsets: number[] = [0];
  private steps: readonly TextStep[] = [];
  private stepIndex = 0;
  private stepHits = 0;
  private gameTick = 0;

  constructor(readonly tickRate = 60) {}

  begin(page: PageKey, steps: readonly TextStep[] = [], gameTick = 0): void {
    this.close();
    // V320-FIX-06-R2：最低表示時間は項目開始時に確定する。項目内で切り替える別の頁の本文も文字数に含める（途中で別の期限を追加しない）
    const also = steps.map((st) => st.page).filter((x): x is PageKey => !!x);
    const minTicks = minDisplayTicks(page, this.tickRate, also);
    this.steps = steps;
    this.stepIndex = 0;
    this.stepHits = 0;
    this.gameTick = gameTick;
    const panels = pageText(page).panels.map((l) => countTextChars(l.join('')));
    const total = panels.reduce((a, b) => a + b, 0) || 1;
    let acc = 0;
    // 手順が無い複数パネルの頁だけ時間で按分（手順がある頁はイベントで切り替える）
    this.offsets = steps.length
      ? [0]
      : panels.map((n) => {
          const o = Math.floor((minTicks * acc) / total);
          acc += n;
          return o;
        });
    this.current = { page, startTick: this.clock, minTicks, doneTick: null, endTick: null, segments: [{ page, panel: 0, startTick: this.clock, gameTick, trigger: 'start', endTick: null }], events: [] };
    this.log.push(this.current);
  }

  /** 舞台の1tick（実演の停止中も呼ぶ）。文字だけの複数パネルの頁は按分した時刻にパネルを切り替える */
  advance(): void {
    this.clock++;
    void this.text;
  }

  /** ゲーム tick の通知（時間按分の区間の記録用） */
  setGameTick(t: number): void {
    this.gameTick = t;
  }

  private push(page: PageKey, panel: number, trigger: string, gameTick: number): void {
    const c = this.current!;
    const last = c.segments[c.segments.length - 1];
    last.endTick = this.clock;
    c.segments.push({ page, panel, startTick: this.clock, gameTick, trigger, endTick: null });
  }

  /** 実イベントの取り込み：照合用に記録し、次の手順の条件なら説明を切り替える */
  onEvent(e: SyncEvent): void {
    const c = this.current;
    if (!c) return;
    if (SYNC_EVENTS.has(e.type)) c.events.push({ type: e.type, gameTick: e.tick, tick: this.clock, detail: eventDetail(e) });
    const st = this.steps[this.stepIndex];
    if (!st || st.on !== e.type || (st.match && !st.match(e))) return;
    if (++this.stepHits < (st.count ?? 1)) return;
    this.stepIndex++;
    this.stepHits = 0;
    this.push(st.page ?? c.page, st.panel ?? 0, `${e.type}@${e.tick}`, e.tick);
  }

  /** 現在の項目の経過 tick */
  get elapsed(): number {
    return this.current ? this.clock - this.current.startTick : 0;
  }

  /** 表示中の説明（頁・パネル・表示開始のゲーム tick）。項目外は直前の項目の最後の説明 */
  get text(): { page: PageKey; panel: number; gameTick: number } | null {
    const c = this.current;
    if (c && !this.steps.length && this.offsets.length > 1) {
      let i = 0;
      for (let k = 0; k < this.offsets.length; k++) if (this.elapsed >= this.offsets[k]) i = k;
      const last = c.segments[c.segments.length - 1];
      if (last.panel < i) this.push(c.page, i, 'time', this.gameTick);
    }
    const r = c ?? this.log[this.log.length - 1];
    if (!r) return null;
    const s = r.segments[r.segments.length - 1];
    return { page: s.page, panel: s.panel, gameTick: s.gameTick };
  }

  /** 実演の全処理が完了した（最初の1回だけ記録） */
  markDone(): void {
    if (this.current && this.current.doneTick === null) this.current.doneTick = this.clock;
  }

  /**
   * 最低表示時間の経過（V320-FIX-06-R2）：項目開始から、開始時に確定した最低表示時間だけを数える。
   * 項目内の説明の切替では数え直さない。移行時刻＝max（項目開始＋最低表示時間, 実演の全処理完了）
   */
  get minElapsed(): boolean {
    const c = this.current;
    return !c || this.elapsed >= c.minTicks;
  }

  /** 項目を閉じる（次の項目へ・終了） */
  close(): void {
    if (this.current) {
      void this.text;
      this.current.endTick = this.clock;
      this.current.segments[this.current.segments.length - 1].endTick = this.clock;
    }
    this.current = null;
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
   * 説明の項目の始まり（見出し・本文）。V320-FIX-06：直前の項目の実演に属する全処理（飛行・帰還・移動・上詰め・入替・役処理・上昇・
   * 締めの演出）が終わり、かつ直前の項目の最低表示時間が経過したら、この項目を表示して続く実演を同じ tick から始める。
   * 実演完了後に最低時間の残りを待つ間はゲームを止め、完了画面と説明を保つ
   */
  | { op: 'page'; page: PageKey; steps?: readonly TextStep[] }
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
 * V320-FIX-06：項目の進行は ItemClock（実演の全処理完了＋最低表示時間）。最低時間の残りを待つ間は holding＝true（ゲームを進めない）。
 * 行の供給は rowSource を Game へ渡す。
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
  /** V320-FIX-06 項目の時計と記録 */
  readonly items = new ItemClock();
  /** 実演完了後、最低表示時間の残りを待っている（ゲームを進めない） */
  holding = false;
  /** 締めの演出（結果演出など）が続いているか（舞台が与える。既定はなし） */
  private readonly busy: () => boolean;

  constructor(
    readonly def: LessonDef,
    private readonly onPage: (p: PageKey) => void = () => undefined,
    opts: { seed?: number; config?: GameConfig; busy?: () => boolean } = {},
  ) {
    this.busy = opts.busy ?? (() => false);
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

  /** 1tick 分の進行（項目の時計は毎回進む）。戻り値：このtickにゲームを進めたか */
  tick(): boolean {
    if (this.done) return false;
    this.items.setGameTick(this.game.tick);
    this.items.advance();
    this.scanEvents();
    this.holding = false;
    const cmds = this.run();
    if (this.done || this.holding) return false;
    this.game.step(cmds);
    this.scanEvents(); // R1：このtickのイベントで同じフレームに説明を切り替える
    return true;
  }

  /**
   * 項目の実演が完了した状態：飛行（打上・跳ね返り・帰還）・移動・上詰め／入替／不成立の硬直・役処理（宣言〜消去・足場移動・攻撃・戻し）・
   * 手動上昇の途中でない。決着後は締めの演出（busy）が終わっていること。BGM・待機モーション・ボイスは条件に含めない
   */
  private demoComplete(): boolean {
    const g = this.game;
    if (g.result) return !this.busy();
    const p = g.players[0];
    return !g.flights.some((f) => f.player === 0) && !g.isMoving(p) && !g.isLocked(p) && !p.role && g.tick + 1 >= p.manualRiseEndTick;
  }

  /** 項目の区切り（page／end）：実演完了と最低表示時間を確かめる。戻り値：区切りを越えてよいか */
  private atBoundary(): boolean {
    if (!this.demoComplete()) return false; // 実演の処理が続いている：ゲームを進める
    this.items.markDone();
    if (!this.items.minElapsed) {
      this.holding = true; // 完了画面と説明を保ち、自然上昇などを始めさせない
      return false;
    }
    return true;
  }

  private scanEvents(): void {
    const ev = this.game.events;
    for (; this.cursor < ev.length; this.cursor++) {
      const e = ev[this.cursor];
      this.items.onEvent(e as unknown as SyncEvent);
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
      const op = this.def.ops[this.pc] ?? ({ op: 'end' } as const);
      switch (op.op) {
        case 'page':
          // 直前の項目の実演が完了し、最低表示時間が経過してから次の項目へ（実演の途中に停止を挟まない）
          if (this.items.current && !this.atBoundary()) return [];
          this.items.begin(op.page, op.steps, g.tick);
          this.page = op.page;
          this.onPage(op.page);
          this.pc++;
          continue;
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
          if (this.items.current && !this.atBoundary()) return [];
          this.items.close();
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
    // R1：2枚目（戻るまで打ち上げできない）は失敗の到達（跳ね返り開始）で表示
    { op: 'page', page: 'fail', steps: [{ on: 'arrive', match: (e) => e.success === false, panel: 1 }] },
    { op: 'move', col: 2 },
    { op: 'wait', ms: 1500 },
    { op: 'act', action: 'launch' },
    { op: 'until', event: 'returned', maxMs: 3000 },
    { op: 'wait', ms: 500 },
    { op: 'page', page: 'rise' },
    { op: 'act', action: 'manualRise' },
    { op: 'wait', ms: 1500 },
    { op: 'end' },
  ],
};

/**
 * 4/4/6 共用教材の取得・宣言の時間（設計書 第6節「時間」。教材の台本値でゲーム設定ではない）。
 * V320-FIX-06：3回目の宣言（スーパーストレート＝消去4）の前に補充行G（rowG_Ms）を追加し、宣言を declare3Ms（800→1050）へ
 */
export const ROLES_TIMING = { successGapMs: 1200, declare1Ms: 300, declare2Ms: 500, declare3Ms: 1050, rowA_Ms: 250, rowB_Ms: 0, rowC_Ms: 300, rowD_Ms: 150, rowE_Ms: 400, rowG_Ms: 650, rowF_Ms: 0 } as const;

/** 4/4/6 共用教材の補充行（設計書 第6節） */
export const ROLES_ROWS = {
  A: ['6♦', '1♣', '5♦', '2♣', '5♥', '6♠'],
  B: ['1♥', '2♠', '3♥', '4♠', '2♦', '5♣'],
  C: ['5♦', '1♣', '6♦', '2♣', '3♣', '1♦'],
  D: ['2♣', '6♦', '1♣', '5♦', '4♣', '2♦'],
  E: ['6♦', '3♣', '2♦', '1♣', '5♦', '4♣'],
  F: ['3♠', '1♥', '5♣', '2♦', '4♥', '6♣'],
  /** V320-FIX-06 追加：3回目の宣言（消去4）で盤面を空にしないための補充（E と同じ並び。宣言後に列5・6へ1個ずつ残る） */
  G: ['6♦', '3♣', '2♦', '1♣', '5♦', '4♣'],
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
  // V320-FIX-06-R1：説明を実イベントへ同期。2個目の取得で2枚目（役ができると光る。3・4個目の取得と成立光をその説明中に見せる）、
  // 宣言の前に説明を読める待ち（ゲームは進行・成立光は点灯）、宣言の項目内で最初のライン消去に「ライン消去」の説明、
  // 3回目の宣言（3連鎖）で「3連鎖達成」。終わった動作の説明を後から始めない
  const first: LessonOp[] = [
    { op: 'page', page: 'role_ready', steps: [{ on: 'arrive', match: (e) => e.success === true, count: 2, panel: 1 }] },
    { op: 'move', col: 0 },
    { op: 'wait', ms: 200 },
    ...acquire([0, 1, 2, 3], 'now', g),
    { op: 'page', page: 'declare', steps: [{ on: 'lineClear', page: 'line_clear' }] },
    { op: 'wait', ms: 2500 },
    { op: 'act', action: 'declare' },
    { op: 'until', event: 'roleEnd', maxMs: 6000 },
  ];
  if (part === 'first') return { ...ROLES_BASE, ops: [...first, { op: 'end' }] };
  return {
    ...ROLES_BASE,
    ops: [
      ...first,
      { op: 'page', page: 'streak', steps: [{ on: 'arrive', match: (e) => e.success === true, count: 2, panel: 1 }] },
      ...acquire([0, 1, 2, 3], 'roleEnd', g, { 3: 'streak_rate' }),
      { op: 'anchor', on: 'success' },
      { op: 'riseAt', row: ROLES_ROWS.A, atMs: T.rowA_Ms },
      { op: 'page', page: 'flush' },
      { op: 'wait', ms: 2500 },
      { op: 'act', action: 'declare' },
      { op: 'until', event: 'roleEnd', maxMs: 6000 },
      { op: 'page', page: 'chain', steps: [{ on: 'declare', match: (e) => e.chainCount === 3, page: 'chain3' }] },
      { op: 'anchor', on: 'roleEnd' },
      { op: 'riseAt', row: ROLES_ROWS.B, atMs: T.rowB_Ms },
      { op: 'riseAt', row: ROLES_ROWS.C, atMs: T.rowC_Ms },
      ...acquire([0, 1, 2, 3, 4, 5], 'roleEnd', g),
      { op: 'anchor', on: 'success' },
      { op: 'riseAt', row: ROLES_ROWS.D, atMs: T.rowD_Ms },
      { op: 'riseAt', row: ROLES_ROWS.E, atMs: T.rowE_Ms },
      { op: 'riseAt', row: ROLES_ROWS.G, atMs: T.rowG_Ms },
      { op: 'actAt', action: 'declare', atMs: T.declare3Ms },
      { op: 'until', event: 'roleEnd', maxMs: 6000 },
      { op: 'anchor', on: 'roleEnd' },
      { op: 'riseAt', row: ROLES_ROWS.F, atMs: T.rowF_Ms },
      { op: 'wait', ms: 1000 },
      { op: 'end' },
    ],
  };
}

/**
 * V320-FIX-06：1回目のフォーカードが消去2（旧1翻＝1ライン）になったため、2行目に消去用の行を1行追加した（5段）。
 * 1回目の宣言後の盤面（222233）と、2回目の取得に使う♥の行は旧教材と同じ。追加行は打ち上げずに役の消去で消える
 */
const ROLES_BASE: Omit<LessonDef, 'ops'> = {
  id: 'roles',
  base: '3♠',
  rows: [
    ['4♠', '4♥', '4♠', '4♥', '2♣', '5♦'],
    ['1♦', '6♣', '2♦', '5♣', '6♦', '1♥'],
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
  // V320-FIX-06-R1：自然上昇の説明を実際の自然上昇より前に読めるよう、最初の自然上昇を 4000→7500ms（ゲーム内時間）
  firstNaturalRiseMs: 7500,
  ops: [
    // 7段到達で2枚目（積み上がりすぎに注意）
    { op: 'page', page: 'limit', steps: [{ on: 'rise', match: (e) => (e.heightAfter as number) >= 7, panel: 1 }] },
    { op: 'act', action: 'manualRise' },
    { op: 'wait', ms: 1000 },
    { op: 'act', action: 'manualRise' },
    { op: 'wait', ms: 1000 },
    { op: 'act', action: 'manualRise' },
    { op: 'wait', ms: 600 },
    // R1：自然上昇→ピンチ開始で「ピンチ」、猶予の2で「6段以下へ戻そう」、ゲームオーバーで「ゲームオーバー」（同じ項目内で切替）
    {
      op: 'page',
      page: 'natural',
      steps: [
        { on: 'pinchWarn', match: (e) => e.state === 'start', page: 'pinch' },
        { on: 'pinchWarn', match: (e) => e.state === 'count' && e.value === 2, page: 'avoid' },
        { on: 'roundEnd', page: 'miss' },
      ],
    },
    { op: 'until', event: 'pinchWarn', maxMs: 12000, match: (e) => e.type === 'pinchWarn' && e.state === 'start' },
    { op: 'until', event: 'roundEnd', maxMs: 6000 },
    // 対戦のピンチ（実演なしの補足）は終了後に文字だけで
    { op: 'page', page: 'attack_pinch' },
    { op: 'end' },
  ],
};

/**
 * 連鎖切り予約（ヒビ）の独立例：場3♠。V320-FIX-05：2♠成功（打上連鎖1）→4♦失敗でヒビ（切り予約）→1♥成功（連鎖2、ヒビは残る）→5♣失敗で連鎖が切れる。
 * 時間の経過では切れない（待ちだけで切れる実演はしない）。成功継続の 4/4/6 教材とは別の盤面（4/4/6 を壊さない）
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
    // V320-FIX-06-R1：ヒビ発生（1枚目）→ 予約中の成功でヒビが残る（2枚目）→ 次の打ち上げ（失敗して切れる）で3枚目。
    // 各説明を読める間隔にするため、ヒビ後・成功後の待ちを 600→1800／2400ms
    {
      op: 'page',
      page: 'streak_crack',
      steps: [
        { on: 'streakCut', match: (e) => e.state === 'reserved', panel: 0 },
        { on: 'arrive', match: (e) => e.success === true, panel: 1 },
        { on: 'launch', panel: 2 },
      ],
    },
    { op: 'act', action: 'launch' },
    { op: 'until', event: 'arrive', maxMs: 1000 },
    { op: 'move', col: 2 },
    { op: 'act', action: 'launch' },
    { op: 'until', event: 'streakCut', maxMs: 1000, match: (e) => e.type === 'streakCut' && e.state === 'reserved' },
    { op: 'wait', ms: 1800 },
    { op: 'move', col: 1 },
    { op: 'act', action: 'launch' },
    { op: 'until', event: 'arrive', maxMs: 1000, match: (e) => e.type === 'arrive' && e.success },
    { op: 'wait', ms: 2400 },
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
