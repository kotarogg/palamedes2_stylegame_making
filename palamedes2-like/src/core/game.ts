// MODE1（役・攻撃あり）の固定ステップロジック。対戦（2人）とシングル（1人：ひたすら／ステージクリア）。
// 描画FPS・補間コールバック・音声には一切依存しない。両プレイヤーは独立して進行する（ターン制ではない）。
// 1tick内の処理順：
//   1. 基準到達（到達tick昇順、同一tickは1P優先）  2. 帰還完了
//   3. 役処理フェーズの進行（攻撃送信は双方の相殺計算後にまとめて反映）  3b. シングルのステージクリア確定
//   4. 入力（1P→2P。移動終了時の保持入力を先に処理）  5. 連続取得・役連鎖タイマー
//   6. 自然上昇・危険猶予  7. 攻撃波（1段ずつ0/200/400ms）  8. 敗北判定（同一tickの両者敗北は引分け）
import {
  addAttackLines,
  computeAttack,
  resolveCounter,
  stepFits,
  waveReserve,
  type AttackBreakdown,
  type CounterResult,
} from './attack';
import { addLevelProgress, applyMultiplier, levelDef, MODE1_BALANCE, scoreMultiplier, STAGE_COUNT, stageDef, type Mode1Balance } from './balance';
import { Board } from './board';
import { DEFAULT_CONFIG, msToTicks, streakPercent, type GameConfig } from './config';
import { isLaunchSuccess, PieceFactory } from './pieces';
import { evaluateStock, roleLogoIndices, type RoleResult } from './roles';
import { createSeededRng, type Rng } from './rng';
import { pushRoleStock } from './stock';
import type { Piece, PlayerId } from './types';

export type Action = 'left' | 'right' | 'launch' | 'rotate' | 'declare' | 'manualRise';

/** 左右移動中に1回分だけ保持する入力（確定：最後の入力で上書き） */
const BUFFERABLE: ReadonlySet<Action> = new Set<Action>(['left', 'right', 'launch', 'rotate', 'declare']);

export type Command =
  | { player: PlayerId; type: Action }
  /** 検証用イベント注入（待機攻撃ストックへの直接加算。開発ビルドのみ） */
  | { player: PlayerId; type: 'debugAttack'; lines: number };

export type RiseKind = 'natural' | 'manual' | 'attack';

export type LockKind = 'launch' | 'pack' | 'rotate' | 'declareFail';

export type RoundOutcome = 'win' | 'draw' | 'stageClear' | 'allStagesClear' | 'gameOver' | 'clear';

export type ScoreCause = 'launch' | 'line' | 'allClear' | 'stageClear';

export type GameEvent =
  | { type: 'move'; tick: number; player: PlayerId; from: number; to: number; endTick: number }
  | { type: 'launch'; tick: number; player: PlayerId; col: number; piece: Piece; arriveTick: number }
  | {
      type: 'arrive';
      tick: number;
      player: PlayerId;
      col: number;
      piece: Piece;
      success: boolean;
      baseBefore: Piece;
      /** 成功時：上詰めされる列の残りピースID（上から）と終了tick */
      packedIds: number[];
      packEndTick: number;
      heightBefore: number;
      heightAfter: number;
      /** 失敗時：山なり開始・終了・下降終了tick */
      arcStartTick: number;
      arcEndTick: number;
      returnEndTick: number;
      discarded: Piece | null;
      /** 成功時の連続取得数 */
      streak: number;
    }
  /** instant：役成立による瞬間帰還 */
  | { type: 'returned'; tick: number; player: PlayerId; col: number; piece: Piece; instant: boolean }
  | { type: 'rotate'; tick: number; player: PlayerId; col: number; movedId: number; otherIds: number[]; endTick: number }
  | {
      type: 'rise';
      tick: number;
      player: PlayerId;
      kind: RiseKind;
      rows: number;
      heightBefore: number;
      heightAfter: number;
      endTick: number;
    }
  | {
      type: 'declare';
      tick: number;
      player: PlayerId;
      result: RoleResult;
      logos: number[];
      consumed: Piece[];
      chainCount: number;
      streak: number;
      streakPercent: number;
      introEndTick: number;
    }
  | { type: 'declareFail'; tick: number; player: PlayerId; reason: 'too_few' | 'no_role'; lockEnd: number }
  /** 役ストックが「宣言可能な成立状態」へ変化した（非成立→成立の時だけ） */
  | { type: 'roleAvailable'; tick: number; player: PlayerId }
  | {
      type: 'lineClear';
      tick: number;
      player: PlayerId;
      /** 何ライン目か（1始まり）と予定ライン数 */
      index: number;
      planned: number;
      removed: Array<{ col: number; piece: Piece }>;
      heightBefore: number;
      heightAfter: number;
      clearEnd: number;
      shiftEnd: number;
    }
  | { type: 'attack'; tick: number; player: PlayerId; breakdown: AttackBreakdown; counter: CounterResult; linesCleared: number }
  | { type: 'roleEnd'; tick: number; player: PlayerId }
  | { type: 'attackStock'; tick: number; player: PlayerId; stock: number; delta: number; cause: 'receive' | 'wave' | 'counter' | 'debug' }
  /** 攻撃波の開始（この波の段数を予約） */
  | { type: 'waveStart'; tick: number; player: PlayerId; waveId: number; lines: number }
  /** 波の1段：applied=false は容量不足で破棄（着弾音を鳴らさない）。firstApplied＝その波で最初に実際に追加した段 */
  | { type: 'attackRow'; tick: number; player: PlayerId; waveId: number; step: number; applied: boolean; firstApplied: boolean }
  | { type: 'danger'; tick: number; player: PlayerId; state: 'grace' | 'release' | 'defeat'; graceEnd: number }
  | { type: 'score'; tick: number; player: PlayerId; delta: number; total: number; cause: ScoreCause }
  | { type: 'progress'; tick: number; player: PlayerId; units: number; total: number }
  | { type: 'levelUp'; tick: number; player: PlayerId; level: number; max: boolean }
  | { type: 'allClear'; tick: number; player: PlayerId; bonus: number }
  | { type: 'quotaReached'; tick: number; player: PlayerId; stage: number }
  | { type: 'stageClear'; tick: number; player: PlayerId; stage: number; bonus: number; final: boolean }
  | { type: 'roundEnd'; tick: number; winner: PlayerId | null; outcome: RoundOutcome };

export interface Flight {
  piece: Piece;
  player: PlayerId;
  col: number;
  launchTick: number;
  arriveTick: number;
  state: 'outbound' | 'returning';
  returnEndTick: number;
}

/** 成立役の処理（宣言者ごとに独立したフェーズ） */
export interface RoleProcess {
  result: RoleResult;
  logos: number[];
  startTick: number;
  stage: 'intro' | 'clear' | 'shift' | 'outro';
  stageEnd: number;
  linesPlanned: number;
  linesCleared: number;
  chainCount: number;
  streakPercent: number;
  /** シングル：宣言成立時の得点倍率スナップショット（1ライン100点に掛ける） */
  scoreMul: { num: number; den: number };
}

/** 進行中の攻撃波（開始時に段数を予約し、1段ずつSNAP適用） */
export interface WaveProgress {
  id: number;
  remaining: number;
  nextStepTick: number;
  step: number;
  anyApplied: boolean;
}

export interface PlayerState {
  id: PlayerId;
  board: Board;
  roleStock: Piece[];
  /** 役ストックが宣言可能な成立状態か（音の「非成立→成立」判定用） */
  roleReady: boolean;
  attackStock: number;
  wave: WaveProgress | null;
  selectedCol: number;
  charMoveEndTick: number;
  /** 左右移動中に保持している入力（1回分） */
  buffered: Action | null;
  /** 操作硬直の終了tick（発射・上詰め・B入替・不成立） */
  lockUntil: number;
  lockKind: LockKind | null;
  role: RoleProcess | null;
  /** 自然上昇の通常周期（tick）。null＝自然上昇なし。シングルはステージ・Lvで変わる */
  riseIntervalTicks: number | null;
  /** 次の自然上昇までの残りtick（役処理中は停止） */
  riseCountdown: number;
  /** 自然上昇を危険状態で保留中 */
  riseHeld: boolean;
  manualRiseEndTick: number;
  /** 危険猶予の残りtick（null＝猶予中でない） */
  graceRemaining: number | null;
  streakCount: number;
  /** 連続取得の受付残りtick（成功取得で2秒に更新。自分の成立役の処理中は停止） */
  streakRemaining: number;
  chainCount: number;
  /** 役連鎖の受付残りtick（自分の成立役の処理中は停止） */
  chainRemaining: number;
  nextWaveTick: number | null;
  defeated: boolean;
  rng: Rng;
}

export type SingleKind = 'endless' | 'stage';

/** ステージ間の引継ぎ（得点・連続取得数・役連鎖数。受付残時間は最大へ戻す） */
export interface SingleCarry {
  score: number;
  streakCount: number;
  chainCount: number;
}

export interface SingleOptions {
  kind: SingleKind;
  /** ステージクリアの面番号（1〜10） */
  stage?: number;
  carry?: SingleCarry;
  balance?: Mode1Balance;
}

export interface SingleState {
  kind: SingleKind;
  stage: number;
  quota: number;
  /** この面のノルマ進捗（表示はノルマでクランプする） */
  progress: number;
  level: number;
  levelProgress: number;
  /** 実際の成功・消去の累計（統計。ノルマ表示とは別） */
  totalClears: number;
  score: number;
  clearPending: boolean;
  /** 盤面が非空だったか（全消しは「非空→空」の変化で1回だけ） */
  wasNonEmpty: boolean;
}

export interface GameOptions {
  seed?: number;
  config?: GameConfig;
  /** シングル（1人）。省略時は2人対戦 */
  single?: SingleOptions;
  /** テスト用：盤面・基準の初期状態を差し替える */
  setup?: (g: Game) => void;
  /** 乱数源の差し替え（既定は seed からの mulberry32） */
  rngFactory?: (stream: 'base' | 'p1' | 'p2') => Rng;
}

export interface RoundResult {
  /** null＝引分け（シングルでは勝者なし） */
  winner: PlayerId | null;
  tick: number;
  outcome: RoundOutcome;
}

export class Game {
  readonly mode = 'mode1' as const;
  readonly config: GameConfig;
  readonly seed: number;
  readonly factory = new PieceFactory();
  readonly players: PlayerState[];
  readonly flights: Flight[] = [];
  readonly events: GameEvent[] = [];
  readonly single: SingleState | null;
  base: Piece;
  tick = 0;
  result: RoundResult | null = null;
  readonly playStartTick: number;
  private readonly baseRng: Rng;
  private readonly t: Record<keyof GameConfig['timing'], number>;
  private readonly balance: Mode1Balance;
  private pendingSends: Array<{ to: PlayerId; lines: number }> = [];
  private waveSeq = 0;

  constructor(opts: GameOptions = {}) {
    this.config = opts.config ?? DEFAULT_CONFIG;
    this.seed = opts.seed ?? 1;
    this.balance = opts.single?.balance ?? MODE1_BALANCE;
    const mk =
      opts.rngFactory ??
      ((s: 'base' | 'p1' | 'p2') => createSeededRng((this.seed * 2654435761 + { base: 0, p1: 1, p2: 2 }[s] * 97) >>> 0));
    this.baseRng = mk('base');
    const tk = {} as Record<keyof GameConfig['timing'], number>;
    for (const [k, v] of Object.entries(this.config.timing)) tk[k as keyof GameConfig['timing']] = this.ticks(v);
    this.t = tk;
    this.playStartTick = this.t.readyMs;
    this.single = opts.single ? this.makeSingle(opts.single) : null;
    this.players = this.single ? [this.makePlayer(0, mk('p1'))] : [this.makePlayer(0, mk('p1')), this.makePlayer(1, mk('p2'))];
    this.base = this.factory.create(this.baseRng);
    const initialRows = this.single ? Math.round(this.initialPieces() / 6) : this.config.initialRows;
    for (const p of this.players) for (let r = 0; r < initialRows; r++) p.board.appendRow(this.newRow(p));
    const carry = opts.single?.carry;
    if (carry && this.single) {
      const p = this.players[0];
      const tr = this.balance.stage_transition;
      this.single.score = carry.score;
      p.streakCount = carry.streakCount;
      p.streakRemaining = carry.streakCount > 0 ? this.ticks(tr.restore_streak_remaining_ms) : 0;
      p.chainCount = carry.chainCount;
      p.chainRemaining = carry.chainCount > 0 ? this.ticks(tr.restore_chain_remaining_ms) : 0;
    }
    opts.setup?.(this);
    for (const p of this.players) p.roleReady = evaluateStock(p.roleStock).kind === 'ok';
  }

  get kind(): 'versus' | 'single' {
    return this.single ? 'single' : 'versus';
  }

  ticks(ms: number): number {
    return msToTicks(ms, this.config.tickRate);
  }

  get tickMs(): number {
    return 1000 / this.config.tickRate;
  }

  /** 入力受付中（READY後・勝敗確定前） */
  get playing(): boolean {
    return this.tick >= this.playStartTick && !this.result;
  }

  private makeSingle(o: SingleOptions): SingleState {
    const stage = o.kind === 'stage' ? (o.stage ?? 1) : 0;
    return {
      kind: o.kind,
      stage,
      quota: o.kind === 'stage' ? stageDef(stage, this.balance).quota : 0,
      progress: 0,
      level: 1,
      levelProgress: 0,
      totalClears: 0,
      score: 0,
      clearPending: false,
      wasNonEmpty: true,
    };
  }

  private initialPieces(): number {
    const s = this.single;
    if (!s) return this.config.initialRows * 6;
    return s.kind === 'stage' ? stageDef(s.stage, this.balance).initial_pieces : this.balance.mode1_initial_pieces;
  }

  /** 自然上昇の通常周期（ms）。シングルはステージ・Lvの表、対戦は難易度。テスト設定で null なら無効 */
  private naturalIntervalMs(): number | null {
    if (this.config.naturalRiseIntervalMs === null) return null;
    const s = this.single;
    if (!s) return this.config.naturalRiseIntervalMs;
    return s.kind === 'stage' ? stageDef(s.stage, this.balance).natural_rise_ms : levelDef(s.level, this.balance).natural_rise_ms;
  }

  private makePlayer(id: PlayerId, rng: Rng): PlayerState {
    const ms = this.naturalIntervalMs();
    const interval = ms === null ? null : this.ticks(ms);
    return {
      id,
      board: new Board(),
      roleStock: [],
      roleReady: false,
      attackStock: 0,
      wave: null,
      selectedCol: 2,
      charMoveEndTick: 0,
      buffered: null,
      lockUntil: 0,
      lockKind: null,
      role: null,
      riseIntervalTicks: interval,
      riseCountdown: interval === null ? Number.POSITIVE_INFINITY : interval,
      riseHeld: false,
      manualRiseEndTick: 0,
      graceRemaining: null,
      streakCount: 0,
      streakRemaining: 0,
      chainCount: 0,
      chainRemaining: 0,
      nextWaveTick: null,
      defeated: false,
      rng,
    };
  }

  private newRow(p: PlayerState): Piece[] {
    return Array.from({ length: 6 }, () => this.factory.create(p.rng));
  }

  /** 操作硬直中か（役処理中を含む） */
  isLocked(p: PlayerState): boolean {
    return this.tick < p.lockUntil || p.role !== null;
  }

  isMoving(p: PlayerState): boolean {
    return this.tick < p.charMoveEndTick;
  }

  /** 連続取得が受付時間内か */
  streakActive(p: PlayerState): boolean {
    return p.streakRemaining > 0;
  }

  /** 現在の連続取得の攻撃倍率×100（受付時間切れなら×1.0） */
  currentStreakPercent(p: PlayerState): number {
    return this.streakActive(p) ? streakPercent(this.config.streakAttackTable, p.streakCount) : 100;
  }

  /** 現在の得点倍率（シングル表示用。受付時間切れなら×1） */
  currentScoreMultiplier(p: PlayerState): { num: number; den: number } {
    return scoreMultiplier(this.streakActive(p) ? p.streakCount : 0, this.balance);
  }

  /** 1tick進める。commands はこのtickに適用する入力 */
  step(commands: readonly Command[] = []): void {
    this.tick++;
    if (this.result) return; // 勝敗確定後はロジックを止める（表示のみ進む）
    this.processArrivals();
    this.processReturns();
    for (const p of this.players) this.advanceRole(p);
    this.flushSends();
    this.finalizeStageClear();
    if (this.result || !this.playing) return;
    for (const p of this.players) {
      const mine = commands.filter((c) => c.player === p.id);
      this.processInputs(p, mine);
    }
    // 連続取得・役連鎖の受付時間：自分の成立役の処理中は停止（不成立ペナルティ中は継続）
    if (!this.single?.clearPending) {
      for (const p of this.players) {
        if (p.role) continue;
        if (p.chainRemaining > 0) p.chainRemaining--;
        if (p.streakRemaining > 0) p.streakRemaining--;
      }
    }
    for (const p of this.players) this.processRise(p);
    for (const p of this.players) this.processAttackWave(p);
    if (this.single && !this.players[0].board.isEmpty()) this.single.wasNonEmpty = true;
    this.resolveDefeat();
  }

  private emit(e: GameEvent): void {
    this.events.push(e);
  }

  // ---- 入力 ----

  private processInputs(p: PlayerState, cmds: readonly Command[]): void {
    if (this.single?.clearPending) return; // ノルマ達成後は新たな操作を受け付けない
    if (p.buffered && !this.isMoving(p)) {
      const a = p.buffered;
      p.buffered = null;
      // 保持規則は移動中だけ。移動終了時に別の操作禁止状態なら破棄する
      if (!this.isLocked(p) && !p.defeated) this.act(p, a);
    }
    for (const c of cmds) this.apply(p, c);
  }

  private apply(p: PlayerState, c: Command): void {
    if (c.type === 'debugAttack') {
      if (!this.single) this.receiveAttack(p, c.lines, 'debug');
      return;
    }
    if (p.defeated || this.isLocked(p)) return; // 発射中・上詰め/B入替中・不成立硬直中・役処理中は操作不可
    if (c.type === 'manualRise') return this.manualRise(p); // 保持対象外：移動中も即時（N5：既存挙動を維持）
    if (this.isMoving(p)) {
      if (BUFFERABLE.has(c.type)) p.buffered = c.type;
      return;
    }
    this.act(p, c.type);
  }

  private act(p: PlayerState, a: Action): void {
    switch (a) {
      case 'left':
      case 'right': {
        const to = Math.max(0, Math.min(5, p.selectedCol + (a === 'left' ? -1 : 1)));
        if (to === p.selectedCol) return;
        p.charMoveEndTick = this.tick + this.t.charMoveMs;
        this.emit({ type: 'move', tick: this.tick, player: p.id, from: p.selectedCol, to, endTick: p.charMoveEndTick });
        p.selectedCol = to;
        return;
      }
      case 'launch':
        return this.launch(p);
      case 'rotate':
        return this.rotate(p);
      case 'declare':
        return this.declare(p);
      case 'manualRise':
        return this.manualRise(p);
    }
  }

  private lock(p: PlayerState, ticks: number, kind: LockKind): void {
    const until = this.tick + ticks;
    if (until > p.lockUntil) {
      p.lockUntil = until;
      p.lockKind = kind;
    }
  }

  private launch(p: PlayerState): void {
    const col = p.selectedCol;
    const top = p.board.top(col);
    if (!top || top.kind !== 'piece') return; // 空列は無効入力（ペナルティなし）・帰還予約のある列は禁止
    const piece = p.board.reserveTop(col);
    const arriveTick = this.tick + this.t.launchMs;
    this.lock(p, this.t.launchMs, 'launch'); // 発射モーション＝操作硬直＝行きの飛行時間
    this.flights.push({ piece, player: p.id, col, launchTick: this.tick, arriveTick, state: 'outbound', returnEndTick: -1 });
    this.emit({ type: 'launch', tick: this.tick, player: p.id, col, piece, arriveTick });
  }

  private rotate(p: PlayerState): void {
    const col = p.selectedCol;
    const c = p.board.cols[col];
    if (c.length < 2 || p.board.hasReservation(col)) return; // 空列は無効入力・帰還予約のある列は禁止
    const ids = c.map((s) => (s.kind === 'piece' ? s.piece.id : s.pieceId));
    p.board.rotate(col);
    this.lock(p, this.t.rotateMs, 'rotate');
    this.emit({ type: 'rotate', tick: this.tick, player: p.id, col, movedId: ids[0], otherIds: ids.slice(1), endTick: this.tick + this.t.rotateMs });
  }

  private refreshRoleReady(p: PlayerState): void {
    const ready = evaluateStock(p.roleStock).kind === 'ok';
    if (ready && !p.roleReady) this.emit({ type: 'roleAvailable', tick: this.tick, player: p.id });
    p.roleReady = ready;
  }

  private declare(p: PlayerState): void {
    const ev = evaluateStock(p.roleStock);
    if (ev.kind !== 'ok') {
      if (ev.kind === 'too_few' && !this.config.declareBelowMinIsFailure) return;
      // 不成立：モーション・失敗効果音・約0.5秒の硬直。ストック維持、帰還継続、各タイマーは継続
      this.lock(p, this.t.declareFailLockMs, 'declareFail');
      this.emit({ type: 'declareFail', tick: this.tick, player: p.id, reason: ev.kind, lockEnd: p.lockUntil });
      return;
    }
    // 成立：自分の帰還中ピースをすべて瞬間帰還させてから役処理へ
    for (const f of this.flights.filter((x) => x.player === p.id && x.state === 'returning')) this.completeReturn(f, true);
    const consumed = p.roleStock;
    p.roleStock = []; // 採択外を含めストック全体を消費
    p.roleReady = false;
    p.chainCount = p.chainRemaining > 0 ? p.chainCount + 1 : 1;
    p.chainRemaining = this.ticks(this.config.chainWindowMs); // 成立ごとに受付時間を更新（処理中は停止）
    const pct = this.currentStreakPercent(p);
    const introEnd = this.tick + this.t.roleIntroMs;
    p.role = {
      result: ev.result,
      logos: roleLogoIndices(ev.result),
      startTick: this.tick,
      stage: 'intro',
      stageEnd: introEnd,
      linesPlanned: ev.result.han, // 消去ライン数＝合計翻数
      linesCleared: 0,
      chainCount: p.chainCount,
      streakPercent: pct,
      scoreMul: this.currentScoreMultiplier(p),
    };
    p.buffered = null;
    this.emit({
      type: 'declare',
      tick: this.tick,
      player: p.id,
      result: ev.result,
      logos: p.role.logos,
      consumed,
      chainCount: p.chainCount,
      streak: this.streakActive(p) ? p.streakCount : 0,
      streakPercent: pct,
      introEndTick: introEnd,
    });
  }

  // ---- 役処理フェーズ ----

  private advanceRole(p: PlayerState): void {
    const r = p.role;
    if (!r || this.tick < r.stageEnd) return;
    switch (r.stage) {
      case 'intro':
      case 'shift':
        return this.nextLineOrAttack(p, r);
      case 'clear':
        r.stage = 'shift'; // 処理効果音 → 足場・キャラの段数推移TWEEN
        r.stageEnd = this.tick + this.t.lineShiftMs;
        return;
      case 'outro':
        p.role = null;
        this.emit({ type: 'roleEnd', tick: this.tick, player: p.id });
        return;
    }
  }

  /** 消去残数確認：残りがあり盤面が空でなければ1ライン消去、なければ攻撃処理へ */
  private nextLineOrAttack(p: PlayerState, r: RoleProcess): void {
    if (r.linesCleared < r.linesPlanned && !p.board.isEmpty()) {
      const heightBefore = p.board.height();
      const removed = p.board.removeTopRow();
      r.linesCleared++;
      r.stage = 'clear';
      r.stageEnd = this.tick + this.t.lineClearMs;
      this.emit({
        type: 'lineClear',
        tick: this.tick,
        player: p.id,
        index: r.linesCleared,
        planned: r.linesPlanned,
        removed,
        heightBefore,
        heightAfter: p.board.height(),
        clearEnd: r.stageEnd,
        shiftEnd: r.stageEnd + this.t.lineShiftMs,
      });
      if (this.single) {
        // 実行された1ライン：空マスを含め消去数6、得点は100×宣言時の得点倍率（盤面が空で実行されない分は加算しない）
        this.addScore(p, applyMultiplier(this.balance.scoring.actual_line_clear_base, r.scoreMul), 'line');
        this.addClearUnits(p, this.balance.units.actual_line_clear_event_clears);
        this.checkAllClear(p);
      }
      return;
    }
    // 攻撃計算 → 相殺 → 送信（盤面が空で予定ライン数を消せなくても基本攻撃量は減らさない）
    const breakdown = computeAttack(r.result.han, r.streakPercent, r.chainCount, this.config.chainBonusMax);
    if (this.single) {
      // シングルは送り先がない（攻撃ストック・送信なし）
      this.emit({ type: 'attack', tick: this.tick, player: p.id, breakdown, counter: { usedPower: 0, canceled: 0, sent: 0, discarded: 0 }, linesCleared: r.linesCleared });
    } else {
      const counter = resolveCounter(breakdown.power, p.attackStock, this.config.counterPerLine);
      if (counter.canceled > 0) {
        p.attackStock -= counter.canceled;
        if (p.attackStock === 0) p.nextWaveTick = null;
        this.emit({ type: 'attackStock', tick: this.tick, player: p.id, stock: p.attackStock, delta: -counter.canceled, cause: 'counter' });
      }
      if (counter.sent > 0) this.pendingSends.push({ to: (1 - p.id) as PlayerId, lines: counter.sent });
      this.emit({ type: 'attack', tick: this.tick, player: p.id, breakdown, counter, linesCleared: r.linesCleared });
    }
    r.stage = 'outro';
    r.stageEnd = this.tick + this.t.roleOutroMs;
  }

  /** 同一tickの送信は、双方の相殺計算が終わってから反映する（処理順で有利不利を作らない） */
  private flushSends(): void {
    const sends = this.pendingSends;
    this.pendingSends = [];
    for (const s of sends) this.receiveAttack(this.players[s.to], s.lines, 'receive');
  }

  /** 受信攻撃は役処理中でも待機ストックへ即加算。第1波は最初の受信から2秒後（追加受信で延ばさない） */
  private receiveAttack(p: PlayerState, lines: number, cause: 'receive' | 'debug'): void {
    const before = p.attackStock;
    p.attackStock = addAttackLines(p.attackStock, lines);
    if (before === 0 && p.attackStock > 0 && p.nextWaveTick === null) p.nextWaveTick = this.tick + this.ticks(this.config.firstWaveDelayMs);
    this.emit({ type: 'attackStock', tick: this.tick, player: p.id, stock: p.attackStock, delta: p.attackStock - before, cause });
  }

  // ---- シングル：消去数・得点・Lv・ステージ ----

  private addScore(p: PlayerState, delta: number, cause: ScoreCause): void {
    const s = this.single;
    if (!s || delta <= 0) return;
    s.score += delta;
    this.emit({ type: 'score', tick: this.tick, player: p.id, delta, total: s.score, cause });
  }

  /** 消去数の加算（成功1・実行された1ライン6）。ステージはノルマ、ひたすらはLv進捗 */
  private addClearUnits(p: PlayerState, units: number): void {
    const s = this.single;
    if (!s) return;
    s.totalClears += units;
    if (s.kind === 'stage') {
      s.progress += units;
      this.emit({ type: 'progress', tick: this.tick, player: p.id, units, total: s.progress });
      if (!s.clearPending && s.progress >= s.quota) {
        // ノルマ達成：クリア予約を1回だけ立てる。新たな操作・自然上昇・危険進行を止め、実行中の役は完了させる
        s.clearPending = true;
        this.emit({ type: 'quotaReached', tick: this.tick, player: p.id, stage: s.stage });
      }
      return;
    }
    const r = addLevelProgress(s.level, s.levelProgress, units, this.balance);
    s.level = r.level;
    s.levelProgress = r.progress;
    this.emit({ type: 'progress', tick: this.tick, player: p.id, units, total: s.totalClears });
    for (const lv of r.ups) this.emit({ type: 'levelUp', tick: this.tick, player: p.id, level: lv, max: lv >= this.balance.endless.max_level });
    if (r.ups.length > 0) {
      const ms = this.naturalIntervalMs();
      p.riseIntervalTicks = ms === null ? null : this.ticks(ms);
      // 昇格時は自然上昇の残時間を新Lvの全周期へ。危険猶予中・保留中はその状態を維持（延長・解除しない）
      if (p.riseIntervalTicks !== null && p.graceRemaining === null && !p.riseHeld) p.riseCountdown = p.riseIntervalTicks;
    }
  }

  /** 全消し：プレイ中の成功・実消去で盤面が非空→空へ変化した時に1回（予約・飛行の未解決時は確定させない） */
  private checkAllClear(p: PlayerState): void {
    const s = this.single;
    if (!s || !s.wasNonEmpty || !p.board.isEmpty()) return;
    if (this.flights.some((f) => f.player === p.id)) return;
    s.wasNonEmpty = false;
    const bonus = this.balance.scoring.all_clear_bonus;
    this.emit({ type: 'allClear', tick: this.tick, player: p.id, bonus });
    this.addScore(p, bonus, 'allClear');
  }

  /** クリア予約後、実行中の役処理が終わった時点でステージクリアを確定（ボーナス加算・結果） */
  private finalizeStageClear(): void {
    const s = this.single;
    if (!s || !s.clearPending || this.result) return;
    const p = this.players[0];
    if (p.role || p.defeated) return;
    const def = stageDef(s.stage, this.balance);
    const final = s.stage >= STAGE_COUNT;
    this.emit({ type: 'stageClear', tick: this.tick, player: p.id, stage: s.stage, bonus: def.stage_clear_bonus, final });
    this.addScore(p, def.stage_clear_bonus, 'stageClear');
    this.result = { winner: 0, tick: this.tick, outcome: final ? 'allStagesClear' : 'stageClear' };
    this.emit({ type: 'roundEnd', tick: this.tick, winner: 0, outcome: this.result.outcome });
  }

  // ---- 上昇・危険・攻撃波 ----

  private addRows(p: PlayerState, rows: number, kind: RiseKind): void {
    const heightBefore = p.board.height();
    for (let i = 0; i < rows; i++) p.board.appendRow(this.newRow(p));
    this.emit({
      type: 'rise',
      tick: this.tick,
      player: p.id,
      kind,
      rows,
      heightBefore,
      heightAfter: p.board.height(),
      endTick: kind === 'attack' ? this.tick : this.tick + this.t.riseMs,
    });
  }

  private manualRise(p: PlayerState): void {
    if (this.tick < p.manualRiseEndTick) return; // 手動上昇の重複は受け付けない
    if (p.board.height() + 1 > this.config.manualRiseMaxHeight) return;
    this.addRows(p, 1, 'manual');
    p.manualRiseEndTick = this.tick + this.t.riseMs;
  }

  private processRise(p: PlayerState): void {
    if (p.riseIntervalTicks === null || p.defeated) return;
    if (this.single?.clearPending) return; // ノルマ達成後は自然上昇・危険進行を止める
    const danger = this.config.dangerHeight;
    if (p.graceRemaining !== null && p.board.height() < danger) {
      // 猶予中に6段以下へ戻れば解除（成立役の消去による解除を含む）
      p.graceRemaining = null;
      if (!this.config.releaseExecutesHeldRise) {
        p.riseHeld = false;
        p.riseCountdown = p.riseIntervalTicks;
      }
      this.emit({ type: 'danger', tick: this.tick, player: p.id, state: 'release', graceEnd: this.tick });
    }
    if (p.role) return; // 成立役の処理中は自然上昇・危険猶予を停止
    if (p.graceRemaining !== null) {
      if (--p.graceRemaining <= 0) {
        // 猶予終了時も7段：8段目の追加直前に敗北（通常の上昇は実行しない）
        p.defeated = true;
        this.emit({ type: 'danger', tick: this.tick, player: p.id, state: 'defeat', graceEnd: this.tick });
      }
      return;
    }
    if (p.riseCountdown > 0) p.riseCountdown--;
    // 手動上昇完了時：残り時間を max(現在の残り時間, 最低間隔) へ補正（通常周期へはリセットしない）
    if (this.tick === p.manualRiseEndTick) p.riseCountdown = Math.max(p.riseCountdown, this.ticks(this.config.riseMinGapMs));
    if (p.riseCountdown > 0) return;
    if (this.tick < p.manualRiseEndTick) return; // 手動上昇中は自然上昇の実行を待機（重ねて実行しない）
    if (p.board.height() >= danger) {
      // 7段のまま自然上昇時刻：上昇を保留し、3秒の危険猶予を開始
      p.riseHeld = true;
      p.graceRemaining = this.ticks(this.config.dangerGraceMs);
      this.emit({ type: 'danger', tick: this.tick, player: p.id, state: 'grace', graceEnd: this.tick + p.graceRemaining });
      return;
    }
    p.riseHeld = false;
    this.addRows(p, 1, 'natural');
    p.riseCountdown = p.riseIntervalTicks;
  }

  /**
   * 攻撃波（2026-10-20確定）：波の開始時に最大3段を予約し、1段目0ms・2段目200ms・3段目400msにSNAP適用。
   * 各段で容量を再確認し、入りきらない段は破棄（後続波の分は保持）。
   * 自分の役処理中は次段を保留し、終了後に200ms以上の間隔で再開（同一tickへ詰め込まない）。
   * 波は重ねて進行させず、遅れた波を一度に追いつかせない。
   */
  private processAttackWave(p: PlayerState): void {
    if (p.defeated) return;
    if (p.wave) {
      if (p.role) return; // 適用禁止中は保留（予約済みの段は後続受信と区別して保持）
      if (this.tick < p.wave.nextStepTick) return;
      this.applyWaveStep(p);
      return;
    }
    if (p.attackStock <= 0 || p.nextWaveTick === null) return;
    if (this.tick < p.nextWaveTick) return; // 待ち時間は役処理中も経過する
    if (p.role) return; // 盤面への適用は自分の役処理終了まで待機
    const lines = waveReserve(p.attackStock, this.config.waveRules);
    p.attackStock -= lines;
    const id = ++this.waveSeq;
    p.wave = { id, remaining: lines, nextStepTick: this.tick, step: 0, anyApplied: false };
    this.emit({ type: 'attackStock', tick: this.tick, player: p.id, stock: p.attackStock, delta: -lines, cause: 'wave' });
    this.emit({ type: 'waveStart', tick: this.tick, player: p.id, waveId: id, lines });
    p.nextWaveTick = p.attackStock > 0 ? this.tick + this.ticks(this.config.waveIntervalMs) : null;
    this.applyWaveStep(p);
  }

  private applyWaveStep(p: PlayerState): void {
    const w = p.wave;
    if (!w) return;
    const stepTicks = this.ticks(this.config.attackStepMs);
    const applied = stepFits(p.board.height(), this.config.waveRules);
    if (applied) this.addRows(p, 1, 'attack');
    const firstApplied = applied && !w.anyApplied;
    if (applied) w.anyApplied = true;
    this.emit({ type: 'attackRow', tick: this.tick, player: p.id, waveId: w.id, step: w.step, applied, firstApplied });
    w.step++;
    w.remaining--;
    if (w.remaining > 0) {
      w.nextStepTick = this.tick + stepTicks;
      return;
    }
    p.wave = null;
    if (p.nextWaveTick !== null) p.nextWaveTick = Math.max(p.nextWaveTick, this.tick + stepTicks);
  }

  private resolveDefeat(): void {
    const lost = this.players.filter((p) => p.defeated);
    if (lost.length === 0) return;
    if (this.single) {
      this.result = { winner: null, tick: this.tick, outcome: 'gameOver' };
      this.emit({ type: 'roundEnd', tick: this.tick, winner: null, outcome: 'gameOver' });
      return;
    }
    const winner = lost.length === 2 ? null : ((1 - lost[0].id) as PlayerId);
    this.result = { winner, tick: this.tick, outcome: winner === null ? 'draw' : 'win' };
    this.emit({ type: 'roundEnd', tick: this.tick, winner, outcome: this.result.outcome });
  }

  // ---- 到達・帰還 ----

  private processArrivals(): void {
    const arriving = this.flights
      .filter((f) => f.state === 'outbound' && f.arriveTick === this.tick)
      .sort((a, b) => a.player - b.player || a.launchTick - b.launchTick);
    for (const f of arriving) {
      const p = this.players[f.player];
      const baseBefore = this.base;
      const success = isLaunchSuccess(f.piece, this.base); // 到達時点の（更新後の）基準で判定
      const heightBefore = p.board.height();
      let packedIds: number[] = [];
      let discarded: Piece | null = null;
      let packEndTick = this.tick;
      if (success) {
        this.base = f.piece; // 基準を即更新（SNAP）
        const r = pushRoleStock(p.roleStock, f.piece);
        p.roleStock = r.stock;
        discarded = r.discarded;
        // 連続取得：成功取得から次の成功取得まで2秒以内なら継続（失敗では更新・リセットしない）
        p.streakCount = this.streakActive(p) ? p.streakCount + 1 : 1;
        p.streakRemaining = this.ticks(this.config.streakWindowMs);
        p.board.releaseReservation(f.col, f.piece.id);
        packedIds = p.board.cols[f.col].map((s) => (s.kind === 'piece' ? s.piece.id : s.pieceId));
        packEndTick = this.tick + this.t.packMs;
        this.lock(p, this.t.packMs, 'pack'); // 上詰め中はプレイヤー全体の操作を短時間制限
        this.flights.splice(this.flights.indexOf(f), 1);
      } else {
        f.state = 'returning';
        f.returnEndTick = this.tick + this.t.bounceMs + this.t.arcMs + this.t.descendMs;
      }
      this.emit({
        type: 'arrive',
        tick: this.tick,
        player: p.id,
        col: f.col,
        piece: f.piece,
        success,
        baseBefore,
        packedIds,
        packEndTick,
        heightBefore,
        heightAfter: p.board.height(),
        arcStartTick: this.tick + this.t.bounceMs,
        arcEndTick: this.tick + this.t.bounceMs + this.t.arcMs,
        returnEndTick: f.returnEndTick,
        discarded,
        streak: success ? p.streakCount : 0,
      });
      if (success) {
        this.refreshRoleReady(p);
        if (this.single) {
          // 成功確定で1回：10点×成功後の連続取得数に対応する得点倍率、消去数1
          this.addScore(p, applyMultiplier(this.balance.scoring.successful_launch_base, scoreMultiplier(p.streakCount, this.balance)), 'launch');
          this.addClearUnits(p, this.balance.units.launch_success_clears);
          this.checkAllClear(p);
        }
      }
    }
  }

  private completeReturn(f: Flight, instant: boolean): void {
    this.players[f.player].board.fillReservation(f.col, f.piece);
    this.flights.splice(this.flights.indexOf(f), 1);
    this.emit({ type: 'returned', tick: this.tick, player: f.player, col: f.col, piece: f.piece, instant });
  }

  private processReturns(): void {
    for (const f of this.flights.filter((x) => x.state === 'returning' && x.returnEndTick === this.tick)) this.completeReturn(f, false);
  }

  /** 決定性検証用：ゲーム結果に関わる状態の要約 */
  snapshot(): string {
    return JSON.stringify({
      tick: this.tick,
      base: this.base,
      result: this.result,
      single: this.single,
      flights: this.flights.map((f) => [f.piece.id, f.player, f.col, f.state, f.arriveTick, f.returnEndTick]),
      players: this.players.map((p) => ({
        cols: p.board.cols.map((c) => c.map((s) => (s.kind === 'piece' ? `${s.piece.id}:${s.piece.n}${s.piece.suit[0]}` : `R${s.pieceId}`))),
        stock: p.roleStock.map((x) => x.id),
        atk: p.attackStock,
        wave: p.wave,
        sel: p.selectedCol,
        lock: p.lockUntil,
        role: p.role ? [p.role.stage, p.role.stageEnd, p.role.linesCleared] : null,
        rise: p.riseCountdown,
        grace: p.graceRemaining,
        streak: [p.streakCount, p.streakRemaining],
        chain: [p.chainCount, p.chainRemaining],
        nextWave: p.nextWaveTick,
      })),
    });
  }
}
