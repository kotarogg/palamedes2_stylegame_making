// MODE2（スピード特化の有限盤面）：共通の場のカードへ、自分の6列の候補から出せるピースを打ち上げ続け、
// 先に自分の盤面を空にした側が勝つ。シングルは自分の盤面を空にしてクリア。
// MODE1とは独立したルール層。役・ライン消去・攻撃・相殺・各ストック・役連鎖・B入れ替え・自然／手動上昇は存在しない。
// 打ち上げの成功条件・予約／帰還・発射硬直・上詰め硬直・移動中の入力保持は MODE1 と同じ。
// 1tick内の処理順：1. 到達（同一tickは1P優先） 2. 帰還完了 3. 詰まり判定・帰還待ち・カウントダウン・場の更新
//                  4. 入力 5. 勝敗判定（同一tickの両者完了は引分け）
import { MODE1_BALANCE } from './balance';
import { Board } from './board';
import { DEFAULT_CONFIG, DEFAULT_MODE2_CONFIG, msToTicks, type GameConfig, type Mode2Config } from './config';
import type { Command, Flight, LockKind, RoundResult } from './game';
import { isLaunchSuccess, kindFromIndex, PieceFactory } from './pieces';
import { clear as clearHeld, MOVE_ACTIONS, offer, resolveTick, take, type InputLogEntry } from './inputBuffer';
import { createSeededRng, randomInt, type Rng } from './rng';
import type { Piece, PlayerId } from './types';

type Mode2Action = 'left' | 'right' | 'launch';
const MODE2_ACTIONS: ReadonlySet<string> = new Set(['left', 'right', 'launch']);

export type Mode2Phase = 'play' | 'waitReturn' | 'countdown';

export type Mode2Event =
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
      packedIds: number[];
      packEndTick: number;
      heightBefore: number;
      heightAfter: number;
      arcStartTick: number;
      arcEndTick: number;
      returnEndTick: number;
      discarded: null;
      streak: number;
    }
  | { type: 'returned'; tick: number; player: PlayerId; col: number; piece: Piece; instant: boolean }
  /** 出せるピースなし：操作停止（帰還中があれば帰還完了を待つ） */
  | { type: 'stuck'; tick: number }
  /** カウントダウンの数字切替（3→2→1）。endTick＝この数字の表示終了 */
  | { type: 'countdown'; tick: number; value: number; endTick: number }
  /** 場のカードの更新確定（操作再開） */
  | { type: 'cardRefresh'; tick: number; base: Piece; baseBefore: Piece }
  | { type: 'remaining'; tick: number; player: PlayerId; remaining: number }
  | { type: 'roundEnd'; tick: number; winner: PlayerId | null; outcome: RoundResult['outcome'] };

export interface Mode2Player {
  id: PlayerId;
  board: Board;
  selectedCol: number;
  charMoveEndTick: number;
  buffered: Mode2Action | null;
  /** v3.2.0 保持の受付tick・自動反復か（MODE1 と同じ先行入力） */
  bufferedTick: number;
  bufferedRepeat: boolean;
  lockUntil: number;
  lockKind: LockKind | null;
  /** シングルの完了tick（経過時間の記録用） */
  finishedTick: number | null;
}

export interface Mode2Options {
  seed?: number;
  config?: GameConfig;
  mode2?: Mode2Config;
  /** 1＝シングル、2＝対戦 */
  players?: 1 | 2;
  /** 初期盤面のピース数（6の倍数）。既定は数値設計JSONの mode2_initial_pieces（42） */
  initialPieces?: number;
  setup?: (g: Mode2Game) => void;
}

/** 列の候補：最上段のピース。帰還予約の列は確定済みの戻り先（帰還中ピース） */
export function columnCandidates(board: Board, flights: readonly Flight[], player: PlayerId): Piece[] {
  const out: Piece[] = [];
  board.cols.forEach((col, c) => {
    const s = col[0];
    if (!s) return;
    if (s.kind === 'piece') {
      out.push(s.piece);
      return;
    }
    const f = flights.find((x) => x.player === player && x.col === c && x.piece.id === s.pieceId);
    if (f && f.state === 'returning') out.push(f.piece);
  });
  return out;
}

export class Mode2Game {
  readonly mode = 'mode2' as const;
  readonly config: GameConfig;
  readonly mode2: Mode2Config;
  readonly seed: number;
  readonly factory = new PieceFactory();
  readonly players: Mode2Player[];
  readonly flights: Flight[] = [];
  readonly events: Mode2Event[] = [];
  base: Piece;
  tick = 0;
  result: RoundResult | null = null;
  phase: Mode2Phase = 'play';
  /** カウントダウンの開始tick */
  countdownStart = 0;
  /** v3.2.0 詰まり解消のための場の更新（cardRefresh）の回数。成功による通常の場の変化は数えない。ラウンドごと */
  refreshCount = 0;
  readonly playStartTick: number;
  private readonly baseRng: Rng;
  private readonly t: Record<keyof GameConfig['timing'], number>;

  constructor(opts: Mode2Options = {}) {
    this.config = opts.config ?? DEFAULT_CONFIG;
    this.mode2 = opts.mode2 ?? DEFAULT_MODE2_CONFIG;
    this.seed = opts.seed ?? 1;
    const mk = (k: number) => createSeededRng((this.seed * 2654435761 + k * 97 + 0x4d32) >>> 0);
    this.baseRng = mk(0);
    const tk = {} as Record<keyof GameConfig['timing'], number>;
    for (const [k, v] of Object.entries(this.config.timing)) tk[k as keyof GameConfig['timing']] = this.ticks(v);
    this.t = tk;
    this.playStartTick = this.t.readyMs;
    const n = opts.players ?? 2;
    this.players = Array.from({ length: n }, (_, i) => this.makePlayer(i as PlayerId));
    this.base = this.factory.create(this.baseRng);
    const rows = Math.round((opts.initialPieces ?? MODE1_BALANCE.mode2_initial_pieces) / 6);
    this.players.forEach((p, i) => {
      const rng = mk(i + 1);
      for (let r = 0; r < rows; r++) p.board.appendRow(Array.from({ length: 6 }, () => this.factory.create(rng)));
    });
    opts.setup?.(this);
  }

  get kind(): 'versus' | 'single' {
    return this.players.length === 1 ? 'single' : 'versus';
  }

  ticks(ms: number): number {
    return msToTicks(ms, this.config.tickRate);
  }

  get tickMs(): number {
    return 1000 / this.config.tickRate;
  }

  get playing(): boolean {
    return this.tick >= this.playStartTick && !this.result;
  }

  /** 経過時間（ms）：GOから。シングル完了後は完了時点で止める */
  elapsedMs(p: Mode2Player = this.players[0]): number {
    const end = p.finishedTick ?? this.tick;
    return Math.max(0, end - this.playStartTick) * this.tickMs;
  }

  /**
   * v3.2.0 ノーリセットクリア：ラウンド開始から最後の成功確定まで、詰まり解消の場の更新が0回で全ピースを出し切り、
   * シングルのクリア、または対戦の勝利になった（引分けは対象外）。打ち上げ失敗は失格条件にしない。達成者を返す
   */
  noResetAchiever(): PlayerId | null {
    const r = this.result;
    if (!r || this.refreshCount !== 0) return null;
    if (r.outcome === 'clear') return 0;
    if (r.outcome === 'win' && r.winner !== null) return r.winner;
    return null;
  }

  remaining(p: Mode2Player): number {
    // 盤面上のピース＋予約空白（飛行中のピースはまだ盤面から出ていない扱い）
    return p.board.allIds().length;
  }

  private makePlayer(id: PlayerId): Mode2Player {
    return { id, board: new Board(), selectedCol: 2, charMoveEndTick: 0, buffered: null, bufferedTick: -1, bufferedRepeat: false, lockUntil: 0, lockKind: null, finishedTick: null };
  }

  isLocked(p: Mode2Player): boolean {
    return this.tick < p.lockUntil || this.phase !== 'play';
  }

  isMoving(p: Mode2Player): boolean {
    return this.tick < p.charMoveEndTick;
  }

  /** そのプレイヤーに、現在の場のカードへ出せる候補があるか */
  canPlay(p: Mode2Player): boolean {
    return columnCandidates(p.board, this.flights, p.id).some((c) => isLaunchSuccess(c, this.base));
  }

  step(commands: readonly Command[] = []): void {
    this.tick++;
    if (this.result) return;
    this.processArrivals();
    this.processReturns();
    this.resolveFinish();
    if (this.result || !this.playing) return;
    this.processStuck();
    if (this.phase === 'play') {
      for (const p of this.players) this.processInputs(p, commands.filter((c) => c.player === p.id));
    }
  }

  private emit(e: Mode2Event): void {
    this.events.push(e);
  }

  // ---- 詰まり判定・カウントダウン・場の更新 ----

  private processStuck(): void {
    switch (this.phase) {
      case 'play': {
        // 判定は関係する盤面に行き飛行中のピースがない時だけ。対戦は両者とも出せない時だけ
        if (this.flights.some((f) => f.state === 'outbound')) return;
        if (this.players.some((p) => this.canPlay(p))) return;
        this.phase = 'waitReturn';
        this.clearInputBuffers();
        this.emit({ type: 'stuck', tick: this.tick });
        this.processStuck();
        return;
      }
      case 'waitReturn': {
        if (this.flights.length > 0) return; // 帰還中は確定済みの戻り先への帰還完了を待つ
        // 完了直前に状態を再検査
        if (this.players.some((p) => this.canPlay(p))) {
          this.phase = 'play';
          return;
        }
        this.phase = 'countdown';
        this.countdownStart = this.tick;
        this.emitCountdown(0);
        return;
      }
      case 'countdown': {
        const step = this.ticks(this.mode2.countdownStepMs);
        const k = Math.floor((this.tick - this.countdownStart) / step);
        if ((this.tick - this.countdownStart) % step !== 0) return;
        if (k < this.mode2.countdownFrom) {
          this.emitCountdown(k);
          return;
        }
        this.refreshCard();
        return;
      }
    }
  }

  private emitCountdown(k: number): void {
    const step = this.ticks(this.mode2.countdownStepMs);
    this.emit({ type: 'countdown', tick: this.tick, value: this.mode2.countdownFrom - k, endTick: this.countdownStart + (k + 1) * step });
  }

  /**
   * 場のカードの更新：現在見えている確定候補のうち少なくとも1つが出せるカードを選ぶ（無限に繰り返さない）。
   * 24種のうち条件を満たす種類から盤面用とは別の乱数で1つ選ぶ。
   */
  private refreshCard(): void {
    const candidates = this.players.flatMap((p) => columnCandidates(p.board, this.flights, p.id));
    const options: number[] = [];
    for (let i = 0; i < 24; i++) {
      const k = kindFromIndex(i);
      if (candidates.some((c) => isLaunchSuccess(c, k))) options.push(i);
    }
    const before = this.base;
    if (options.length > 0) {
      const k = kindFromIndex(options[randomInt(this.baseRng, options.length)]);
      this.base = this.factory.make(k.n, k.suit);
    }
    this.phase = 'play';
    this.refreshCount++;
    this.emit({ type: 'cardRefresh', tick: this.tick, base: this.base, baseBefore: before });
  }

  // ---- 入力 ----

  /** v3.2.0 入力の予約・消費・破棄の記録（開発時の検査用。最新500件） */
  readonly inputLog: InputLogEntry[] = [];

  private inputLogger(p: Mode2Player) {
    return (e: Omit<InputLogEntry, 'tick' | 'player'>) => {
      this.inputLog.push({ tick: this.tick, player: p.id, ...e });
      if (this.inputLog.length > 500) this.inputLog.splice(0, this.inputLog.length - 500);
    };
  }

  /** 予約の破棄（詰まり・ラウンド終了・画面遷移・フォーカス喪失） */
  clearInputBuffers(): void {
    for (const p of this.players) {
      if (p.buffered) this.inputLogger(p)({ event: 'discard', action: p.buffered, reason: 'state' });
      clearHeld(p);
    }
  }

  private processInputs(p: Mode2Player, cmds: readonly Command[]): void {
    if (p.finishedTick !== null) return;
    const log = this.inputLogger(p);
    // v3.2.0 r：当該tickの解除・新規方向・同時押しを、旧予約の実行より先に反映する
    const now = resolveTick(p, cmds, !this.isMoving(p), log);
    if (p.buffered && !this.isMoving(p)) {
      const a = take(p, this.tick, this.config.moveBufferTicks, log);
      if (a) {
        if (this.isLocked(p)) log({ event: 'discard', action: a, reason: 'locked' });
        else if (MOVE_ACTIONS.has(a) && ((a === 'left' && p.selectedCol === 0) || (a === 'right' && p.selectedCol === 5))) log({ event: 'discard', action: a, reason: 'edge' });
        else {
          log({ event: 'consume', action: a });
          this.act(p, a);
        }
      }
    }
    for (const c of now) {
      if (!MODE2_ACTIONS.has(c.type)) continue; // MODE2にB・宣言・手動上昇はない
      const a = c.type as Mode2Action;
      if (this.isLocked(p)) continue;
      if (this.isMoving(p)) {
        offer(p, a, 'repeat' in c && !!c.repeat, this.tick, log);
        continue;
      }
      this.act(p, a);
    }
  }

  private act(p: Mode2Player, a: Mode2Action): void {
    if (a === 'launch') return this.launch(p);
    const to = Math.max(0, Math.min(5, p.selectedCol + (a === 'left' ? -1 : 1)));
    if (to === p.selectedCol) return;
    p.charMoveEndTick = this.tick + this.t.charMoveMs;
    this.emit({ type: 'move', tick: this.tick, player: p.id, from: p.selectedCol, to, endTick: p.charMoveEndTick });
    p.selectedCol = to;
  }

  private lock(p: Mode2Player, ticks: number, kind: LockKind): void {
    const until = this.tick + ticks;
    if (until > p.lockUntil) {
      p.lockUntil = until;
      p.lockKind = kind;
    }
  }

  private launch(p: Mode2Player): void {
    const col = p.selectedCol;
    const top = p.board.top(col);
    if (!top || top.kind !== 'piece') return; // 空列・帰還予約の列は無効入力
    const piece = p.board.reserveTop(col);
    const arriveTick = this.tick + this.t.launchMs;
    this.lock(p, this.t.launchMs, 'launch');
    this.flights.push({ piece, player: p.id, col, launchTick: this.tick, arriveTick, state: 'outbound', returnEndTick: -1 });
    this.emit({ type: 'launch', tick: this.tick, player: p.id, col, piece, arriveTick });
  }

  // ---- 到達・帰還・勝敗 ----

  private processArrivals(): void {
    const arriving = this.flights
      .filter((f) => f.state === 'outbound' && f.arriveTick === this.tick)
      .sort((a, b) => a.player - b.player || a.launchTick - b.launchTick);
    for (const f of arriving) {
      const p = this.players[f.player];
      const baseBefore = this.base;
      const success = isLaunchSuccess(f.piece, this.base);
      const heightBefore = p.board.height();
      let packedIds: number[] = [];
      let packEndTick = this.tick;
      if (success) {
        this.base = f.piece;
        p.board.releaseReservation(f.col, f.piece.id);
        packedIds = p.board.cols[f.col].map((s) => (s.kind === 'piece' ? s.piece.id : s.pieceId));
        packEndTick = this.tick + this.t.packMs;
        this.lock(p, this.t.packMs, 'pack');
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
        discarded: null,
        streak: 0,
      });
      if (success) this.emit({ type: 'remaining', tick: this.tick, player: p.id, remaining: this.remaining(p) });
    }
  }

  private processReturns(): void {
    for (const f of this.flights.filter((x) => x.state === 'returning' && x.returnEndTick === this.tick)) {
      this.players[f.player].board.fillReservation(f.col, f.piece);
      this.flights.splice(this.flights.indexOf(f), 1);
      this.emit({ type: 'returned', tick: this.tick, player: f.player, col: f.col, piece: f.piece, instant: false });
    }
  }

  /** 盤面が空（予約・飛行中なし）になったプレイヤーが完了。対戦で同一tickに両者完了なら引分け */
  private resolveFinish(): void {
    const done = this.players.filter((p) => p.board.isEmpty() && !this.flights.some((f) => f.player === p.id));
    if (done.length === 0) return;
    for (const p of done) p.finishedTick ??= this.tick;
    if (this.players.length === 1) {
      this.result = { winner: 0, tick: this.tick, outcome: 'clear' };
      this.clearInputBuffers(); // v3.2.0 ラウンド終了で移動の予約を破棄
    } else {
      const winner = done.length === 2 ? null : done[0].id;
      this.result = { winner, tick: this.tick, outcome: winner === null ? 'draw' : 'win' };
      this.clearInputBuffers(); // v3.2.0 ラウンド終了で移動の予約を破棄
    }
    this.emit({ type: 'roundEnd', tick: this.tick, winner: this.result.winner, outcome: this.result.outcome });
  }

  snapshot(): string {
    return JSON.stringify({
      tick: this.tick,
      base: this.base,
      phase: this.phase,
      result: this.result,
      flights: this.flights.map((f) => [f.piece.id, f.player, f.col, f.state, f.arriveTick, f.returnEndTick]),
      players: this.players.map((p) => ({
        cols: p.board.cols.map((c) => c.map((s) => (s.kind === 'piece' ? `${s.piece.id}:${s.piece.n}${s.piece.suit[0]}` : `R${s.pieceId}`))),
        sel: p.selectedCol,
        lock: p.lockUntil,
      })),
    });
  }
}
