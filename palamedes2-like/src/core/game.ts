// 固定ステップの対戦ロジック。描画FPS・補間コールバックには一切依存しない。
// 1tick内の処理順（技術的な順序であり、G04の同時イベント全順序を確定するものではない）：
//   1. 入力（1P→2P）  2. 基準到達（到達tick昇順、同一tickは1P優先）  3. 帰還完了
//   4. 宣言演出終了  5. 自然上昇  6. 攻撃波
import { addAttackLines, waveLines } from './attack';
import { Board } from './board';
import { DEFAULT_CONFIG, msToTicks, type GameConfig } from './config';
import { isLaunchSuccess, PieceFactory } from './pieces';
import { evaluateStock, roleLogoIndices, type RoleResult } from './roles';
import { createSeededRng, type Rng } from './rng';
import { pushRoleStock } from './stock';
import { COLS, PLAYERS, type Piece, type PlayerId } from './types';

export type Action = 'left' | 'right' | 'launch' | 'rotate' | 'declare' | 'manualRise';

export type Command =
  | { player: PlayerId; type: Action }
  /** 検証用イベント注入（攻撃量算式が未確定のため、通常プレイでは攻撃は発生しない） */
  | { player: PlayerId; type: 'debugAttack'; lines: number };

export type RiseKind = 'natural' | 'manual' | 'attack';

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
      /** 失敗時：山なり終了・下降終了tick */
      arcStartTick: number;
      arcEndTick: number;
      returnEndTick: number;
      discarded: Piece | null;
    }
  | { type: 'returned'; tick: number; player: PlayerId; col: number; piece: Piece }
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
  | { type: 'declare'; tick: number; player: PlayerId; result: RoleResult; logos: number[]; endTick: number; consumed: Piece[] }
  | { type: 'declareEnd'; tick: number; player: PlayerId }
  | { type: 'notice'; tick: number; player: PlayerId; code: NoticeCode }
  | { type: 'attackStock'; tick: number; player: PlayerId; stock: number; delta: number };

export type NoticeCode =
  | 'G04_NO_ROLE'
  | 'G04_TIE'
  | 'G04_MULTI_LAUNCH'
  | 'G03_OVERFLOW_PENDING'
  | 'ATTACK_WAIT_DECLARE'
  | 'ATTACK_HOLD_CAPACITY';

export interface Flight {
  piece: Piece;
  player: PlayerId;
  col: number;
  launchTick: number;
  arriveTick: number;
  state: 'outbound' | 'returning';
  returnEndTick: number;
}

export interface PlayerState {
  id: PlayerId;
  board: Board;
  roleStock: Piece[];
  attackStock: number;
  selectedCol: number;
  charMoveEndTick: number;
  /** 上詰め・B入替TWEEN中の列（検証用の入力受付制御） */
  colBusyUntil: number[];
  /** 役宣言など、プレイヤー全体ロックの終了tick */
  lockedUntil: number;
  nextRiseTick: number | null;
  /** 宣言演出中に停止した自然上昇タイマーの残り */
  pausedRiseRemaining: number | null;
  nextWaveTick: number | null;
  overflowPending: boolean;
  rng: Rng;
}

export interface GameOptions {
  seed?: number;
  config?: GameConfig;
  /** テスト用：盤面・基準の初期状態を差し替える */
  setup?: (g: Game) => void;
  /** 乱数源の差し替え（既定は seed からの mulberry32） */
  rngFactory?: (stream: 'base' | 'p1' | 'p2') => Rng;
}

export class Game {
  readonly config: GameConfig;
  readonly seed: number;
  readonly factory = new PieceFactory();
  readonly players: [PlayerState, PlayerState];
  readonly flights: Flight[] = [];
  readonly events: GameEvent[] = [];
  base: Piece;
  tick = 0;
  readonly playStartTick: number;
  private readonly baseRng: Rng;
  private readonly t: Record<keyof GameConfig['timing'], number>;

  constructor(opts: GameOptions = {}) {
    this.config = opts.config ?? DEFAULT_CONFIG;
    this.seed = opts.seed ?? 1;
    const mk =
      opts.rngFactory ??
      ((s: 'base' | 'p1' | 'p2') => createSeededRng((this.seed * 2654435761 + { base: 0, p1: 1, p2: 2 }[s] * 97) >>> 0));
    this.baseRng = mk('base');
    const tk = {} as Record<keyof GameConfig['timing'], number>;
    for (const [k, v] of Object.entries(this.config.timing)) tk[k as keyof GameConfig['timing']] = this.ticks(v);
    this.t = tk;
    this.playStartTick = this.t.readyMs;
    this.players = [this.makePlayer(0, mk('p1')), this.makePlayer(1, mk('p2'))];
    this.base = this.factory.create(this.baseRng);
    for (const p of this.players) for (let r = 0; r < this.config.initialRows; r++) p.board.appendRow(this.newRow(p));
    opts.setup?.(this);
  }

  ticks(ms: number): number {
    return msToTicks(ms, this.config.tickRate);
  }

  get tickMs(): number {
    return 1000 / this.config.tickRate;
  }

  get playing(): boolean {
    return this.tick >= this.playStartTick;
  }

  private makePlayer(id: PlayerId, rng: Rng): PlayerState {
    const interval = this.config.naturalRiseIntervalMs;
    return {
      id,
      board: new Board(),
      roleStock: [],
      attackStock: 0,
      selectedCol: 2,
      charMoveEndTick: 0,
      colBusyUntil: Array(COLS).fill(0),
      lockedUntil: 0,
      nextRiseTick: interval === null ? null : this.t.readyMs + this.ticks(interval),
      pausedRiseRemaining: null,
      nextWaveTick: null,
      overflowPending: false,
      rng,
    };
  }

  private newRow(p: PlayerState): Piece[] {
    return Array.from({ length: COLS }, () => this.factory.create(p.rng));
  }

  isLocked(p: PlayerState): boolean {
    return this.tick < p.lockedUntil;
  }

  /** 1tick進める。commands はこのtickに適用する入力 */
  step(commands: readonly Command[] = []): void {
    this.tick++;
    if (this.playing) {
      const ordered = [...commands].sort((a, b) => a.player - b.player);
      for (const c of ordered) this.apply(c);
    }
    this.processArrivals();
    this.processReturns();
    for (const p of this.players) this.processDeclareEnd(p);
    if (this.playing) {
      for (const p of this.players) this.processNaturalRise(p);
      for (const p of this.players) this.processAttackWave(p);
    }
  }

  private emit(e: GameEvent): void {
    this.events.push(e);
  }

  private apply(c: Command): void {
    const p = this.players[c.player];
    if (c.type === 'debugAttack') {
      const before = p.attackStock;
      p.attackStock = addAttackLines(p.attackStock, c.lines);
      this.emit({ type: 'attackStock', tick: this.tick, player: p.id, stock: p.attackStock, delta: p.attackStock - before });
      return;
    }
    if (this.isLocked(p)) return; // 役宣言中は宣言者だけ操作不能
    if (c.type === 'declare') return this.declare(p);
    if (c.type === 'manualRise') return this.manualRise(p);
    if (this.tick < p.charMoveEndTick) return; // G04 列移動中の追加入力：受け付けない（検証用）
    switch (c.type) {
      case 'left':
      case 'right': {
        const to = Math.max(0, Math.min(COLS - 1, p.selectedCol + (c.type === 'left' ? -1 : 1)));
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
    }
  }

  private columnOperable(p: PlayerState, col: number): boolean {
    const top = p.board.top(col);
    if (!top || top.kind !== 'piece') return false; // 空列（G04）・帰還待ち列（予約中）は不可
    return this.tick >= p.colBusyUntil[col];
  }

  private launch(p: PlayerState): void {
    const col = p.selectedCol;
    if (!this.columnOperable(p, col)) return;
    if (this.flights.some((f) => f.player === p.id && f.state === 'outbound')) {
      this.emit({ type: 'notice', tick: this.tick, player: p.id, code: 'G04_MULTI_LAUNCH' });
      return;
    }
    const piece = p.board.reserveTop(col);
    const arriveTick = this.tick + this.t.launchMs;
    this.flights.push({ piece, player: p.id, col, launchTick: this.tick, arriveTick, state: 'outbound', returnEndTick: -1 });
    this.emit({ type: 'launch', tick: this.tick, player: p.id, col, piece, arriveTick });
  }

  private rotate(p: PlayerState): void {
    const col = p.selectedCol;
    if (!this.columnOperable(p, col) || p.board.cols[col].length < 2) return;
    const ids = p.board.cols[col].map((s) => (s.kind === 'piece' ? s.piece.id : s.pieceId));
    p.board.rotate(col);
    p.colBusyUntil[col] = this.tick + this.t.rotateMs;
    this.emit({ type: 'rotate', tick: this.tick, player: p.id, col, movedId: ids[0], otherIds: ids.slice(1), endTick: p.colBusyUntil[col] });
  }

  private declare(p: PlayerState): void {
    const ev = evaluateStock(p.roleStock);
    if (ev.kind === 'too_few') return;
    if (ev.kind !== 'ok') {
      this.emit({ type: 'notice', tick: this.tick, player: p.id, code: ev.kind === 'tie' ? 'G04_TIE' : 'G04_NO_ROLE' });
      return;
    }
    const consumed = p.roleStock;
    p.roleStock = []; // 採択外を含めストック全体を消費
    p.lockedUntil = this.tick + this.t.declareMs;
    if (p.nextRiseTick !== null) {
      p.pausedRiseRemaining = Math.max(0, p.nextRiseTick - this.tick);
      p.nextRiseTick = null;
    }
    // 攻撃量（G01）・ライン消去（G02）は未確定のため発生させない
    this.emit({
      type: 'declare',
      tick: this.tick,
      player: p.id,
      result: ev.result,
      logos: roleLogoIndices(ev.result),
      endTick: p.lockedUntil,
      consumed,
    });
  }

  private processDeclareEnd(p: PlayerState): void {
    if (p.lockedUntil !== this.tick) return;
    if (p.pausedRiseRemaining !== null) {
      p.nextRiseTick = this.tick + p.pausedRiseRemaining;
      p.pausedRiseRemaining = null;
    }
    this.emit({ type: 'declareEnd', tick: this.tick, player: p.id });
  }

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
    if (p.board.height() + 1 > this.config.manualRiseMaxHeight) return;
    this.addRows(p, 1, 'manual');
  }

  private processNaturalRise(p: PlayerState): void {
    if (p.nextRiseTick === null || this.tick < p.nextRiseTick) return;
    if (p.board.height() >= this.config.dangerHeight) {
      // G03：8段到達・猶予・敗北は未確定。上昇を保留して通知のみ
      if (!p.overflowPending) this.emit({ type: 'notice', tick: this.tick, player: p.id, code: 'G03_OVERFLOW_PENDING' });
      p.overflowPending = true;
      return;
    }
    p.overflowPending = false;
    this.addRows(p, 1, 'natural');
    p.nextRiseTick = this.tick + this.ticks(this.config.naturalRiseIntervalMs ?? 0);
  }

  private processAttackWave(p: PlayerState): void {
    if (p.attackStock <= 0) {
      p.nextWaveTick = null;
      return;
    }
    if (p.nextWaveTick === null) p.nextWaveTick = this.tick + this.ticks(this.config.firstWaveDelayMs);
    if (this.tick < p.nextWaveTick) return;
    if (this.isLocked(p)) return; // 被攻撃者の役演出中はWAIT。終了後に再評価
    const lines = waveLines(p.attackStock, p.board.height(), this.config.waveRules);
    if (lines === 0) return; // 容量不足：破棄せず保持し、空きができ次第適用
    this.addRows(p, lines, 'attack');
    p.attackStock -= lines;
    this.emit({ type: 'attackStock', tick: this.tick, player: p.id, stock: p.attackStock, delta: -lines });
    p.nextWaveTick = p.attackStock > 0 ? this.tick + this.ticks(this.config.waveIntervalMs) : null;
  }

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
        p.board.releaseReservation(f.col, f.piece.id);
        packedIds = p.board.cols[f.col].map((s) => (s.kind === 'piece' ? s.piece.id : s.pieceId));
        packEndTick = this.tick + this.t.packMs;
        p.colBusyUntil[f.col] = Math.max(p.colBusyUntil[f.col], packEndTick);
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
      });
    }
  }

  private processReturns(): void {
    for (const f of this.flights.filter((x) => x.state === 'returning' && x.returnEndTick === this.tick)) {
      this.players[f.player].board.fillReservation(f.col, f.piece);
      this.flights.splice(this.flights.indexOf(f), 1);
      this.emit({ type: 'returned', tick: this.tick, player: f.player, col: f.col, piece: f.piece });
    }
  }

  /** 決定性検証用：ゲーム結果に関わる状態の要約 */
  snapshot(): string {
    return JSON.stringify({
      tick: this.tick,
      base: this.base,
      flights: this.flights.map((f) => [f.piece.id, f.player, f.col, f.state, f.arriveTick, f.returnEndTick]),
      players: PLAYERS.map((id) => {
        const p = this.players[id];
        return {
          cols: p.board.cols.map((c) => c.map((s) => (s.kind === 'piece' ? `${s.piece.id}:${s.piece.n}${s.piece.suit[0]}` : `R${s.pieceId}`))),
          stock: p.roleStock.map((x) => x.id),
          atk: p.attackStock,
          sel: p.selectedCol,
          locked: p.lockedUntil,
          rise: p.nextRiseTick,
          wave: p.nextWaveTick,
        };
      }),
    });
  }
}
