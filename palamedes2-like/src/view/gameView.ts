// ゲーム画面の描画（MODE1対戦／MODE1シングル／MODE2対戦／MODE2シングル）。第3版採用グラフィック（graphics_manifest_v3）。
// ロジックのイベント列を読み、時間補間だけを行う（ロジックへ書き戻さない）。盤面の固定グリッド・論理座標は変更しない。
import type { Character } from '../audio/audioMap';
import { levelDef } from '../core/balance';
import { DEFAULT_VIEW_CONFIG, type ViewConfig } from '../core/config';
import type { Game, GameEvent, PlayerState } from '../core/game';
import type { AnyGame } from '../core/match';
import type { Mode2Event, Mode2Game } from '../core/mode2';
import { evaluateStock, glowSegments } from '../core/roles';
import type { Piece, PlayerId } from '../core/types';
import { drawFrame, drawNineSlice, type Assets } from './assets';
import type { ManifestFrame } from './data';
import { arcPoint, barY, CELL, cellX, columnCenterX, descentY, easeInOutSine, easeOutQuad, lerp, progress, Z, type BoardRect } from './geometry';
import { characterPose, crackerPose, type ResultPlan } from './presentation';
import { DEFAULT_STOCK_VIEW, stockGroupHeight, stockIcons, pendingGroupY, type StockViewConfig } from './stockLayout';
import { drawNumeric, drawText, formatTime, multiplierText, numericPhase, TEXT_COLORS } from './text';

/** キャラクター → モーションシート（第3版：コタローS1・アカネS2・ずん子S13。プレイヤー番号では選ばない） */
export const CHARACTER_SHEET: Record<Character, string> = { kotaro: 'S1', akane: 'S2', zunko: 'S13' };

/**
 * 役ストックのピースの描画レイヤー。役成立光は「背面→ピース→前面」（確定）のため、
 * ストックのピースを背面光55とキャラ60の間（56）に置く（N1：既存の相対描画順を維持）。
 */
export const STOCK_PIECE_Z = Z.glowBack + 1;

/** 表示の調整値（ゲーム結果に影響しない） */
export interface PlayViewConfig {
  /** カウントダウン数字の出入り（設計補完：−4→0→＋4論理px、各150ms。枠なし） */
  countdownOffsetPx: number;
  countdownFadeMs: number;
  /** 一時的な演出バナー（LEVEL UP 等）の表示時間 */
  noticeMs: number;
  /** 受攻撃ストックの列（第10章） */
  stock: StockViewConfig;
  /** 攻撃段の接着：画面下から飛来（PM指定初期値120ms）→揺れ（120ms・最大2px） */
  attachFlyMs: number;
  attachShakeMs: number;
  attachShakePx: number;
  /** 役ピースの反射光（PM指定：1コマ50ms・列ごと30ms遅延・左→右・同列同時） */
  reflectionFrameMs: number;
  reflectionColumnDelayMs: number;
}

export const DEFAULT_PLAY_VIEW: PlayViewConfig = {
  countdownOffsetPx: 4,
  countdownFadeMs: 150,
  noticeMs: 1100,
  stock: DEFAULT_STOCK_VIEW,
  attachFlyMs: 120,
  attachShakeMs: 120,
  attachShakePx: 2,
  reflectionFrameMs: 50,
  reflectionColumnDelayMs: 30,
};

const REFLECTION_FRAMES = 3;
const BURST_FRAMES = 4;

interface BarTween {
  start: number;
  end: number;
  offset: number;
  /** false：足場・キャラだけが動き、ピースは絶対位置に留まる（ライン消去後の段数推移） */
  piecesFollow: boolean;
}

interface LocalTween {
  fromK: number;
  toK: number;
  start: number;
  end: number;
  dark: boolean;
}

export interface FlightVis {
  piece: Piece;
  player: PlayerId;
  col: number;
  launchTick: number;
  arriveTick: number;
  start: [number, number];
  failed: boolean;
  arcStart: number;
  arcEnd: number;
  returnEnd: number;
}

interface FxVis {
  frames: ManifestFrame[];
  x: number;
  y: number;
  start: number;
  frameTicks: number;
}

interface VanishVis {
  piece: Piece;
  player: PlayerId;
  x: number;
  y: number;
  start: number;
  end: number;
}

interface RoleVis {
  start: number;
  introEnd: number;
  /** 攻撃処理（キャラモーション戻し）tick。未到達なら null */
  attackTick: number | null;
  consumed: Piece[];
  indices: number[];
}

/** 受攻撃ストックの表示状態（予約高さ・上詰め） */
interface StockVis {
  /** 処理中ブロックの予約高さ（px）。ブロックなしは null */
  reservedPx: number | null;
  /** ブロック終了時の待機群の位置（上詰めの起点）と終了tick */
  slideFromPx: number | null;
  endTick: number | null;
}

/** 減った分の残像（相殺＝XD顔＋小爆発、ピンチ破棄＝フェード） */
interface StockAfterimage {
  player: PlayerId;
  kind: 'counter' | 'discard';
  lines: number;
  start: number;
}

interface ReflectionVis {
  player: PlayerId;
  x: number;
  y: number;
  col: number;
  start: number;
}

interface Notice {
  /** S9 の演出ID（show_level_up 等） */
  id: string;
  start: number;
  end: number;
}

interface PlayerVis {
  height: number;
  barTweens: BarTween[];
  move: { from: number; to: number; start: number; end: number } | null;
  launchPoseStart: number;
  bPoseStart: number;
  role: RoleVis | null;
  fail: { start: number; end: number } | null;
  grace: { start: number; end: number } | null;
  pinch: { start: number; end: number } | null;
  stock: StockVis;
}

interface DrawItem {
  z: number;
  clip?: BoardRect;
  draw: (ctx: CanvasRenderingContext2D) => void;
}

/** 画面の外から渡す試合情報（勝利数・先取・ラベル・結果演出） */
export interface HudInfo {
  wins?: readonly [number, number];
  firstTo?: number;
  round?: number;
  labels?: readonly [string, string];
  result?: ResultPlan | null;
  matchOver?: boolean;
  /** プレイヤーごとのキャラクター（既定：1P コタロー／2P アカネ） */
  characters?: readonly Character[];
  /** 役名表示の予定（RoleNameDirector）。表示中のロゴと表示開始tick */
  roleLogo?: (p: PlayerId, tick: number) => { logo: number; since: number } | null;
}

export class GameView {
  private cursor = 0;
  private pv: PlayerVis[] = [];
  private readonly localTweens = new Map<number, LocalTween>();
  private readonly flights = new Map<number, FlightVis>();
  private fx: FxVis[] = [];
  private vanish: VanishVis[] = [];
  private lineFx: { player: PlayerId; y: number; start: number }[] = [];
  private afterimages: StockAfterimage[] = [];
  private reflections: ReflectionVis[] = [];
  /** 攻撃段で追加したピースID → 接着開始tick */
  private readonly attach = new Map<number, number>();
  private notices: Notice[] = [];
  private countdown: { value: number; start: number; end: number } | null = null;
  private refreshFx: number | null = null;
  private staticLayer: HTMLCanvasElement | null = null;
  private staticKey = '';
  private readonly boards: Record<PlayerId, BoardRect>;
  private readonly basePos: [number, number];
  /** 役成立光の共有時計：ラウンドを跨いでも巻き戻さない（ms） */
  private clockBaseMs = 0;
  private stockCache = { key: '', indices: null as number[] | null };
  hud: HudInfo = {};

  constructor(
    private game: AnyGame,
    private readonly assets: Assets,
    private readonly vc: ViewConfig = DEFAULT_VIEW_CONFIG,
    readonly pvc: PlayViewConfig = DEFAULT_PLAY_VIEW,
  ) {
    const L = assets.layout;
    this.boards = { 0: L.pRect(0, 'board'), 1: L.pRect(1, 'board') };
    const b = L.rect('base_piece');
    this.basePos = [b.x, b.y];
    this.resetVis();
  }

  get currentGame(): AnyGame {
    return this.game;
  }

  private get mode1(): Game | null {
    return this.game.mode === 'mode1' ? this.game : null;
  }

  private get isSingle(): boolean {
    return this.game.kind === 'single';
  }

  private resetVis(): void {
    this.pv = this.game.players.map((p) => ({
      height: p.board.height(),
      barTweens: [],
      move: null,
      launchPoseStart: -1e9,
      bPoseStart: -1e9,
      role: null,
      fail: null,
      grace: null,
      pinch: null,
      stock: { reservedPx: null, slideFromPx: null, endTick: null },
    }));
  }

  /** 新しいラウンド（ゲーム）へ差し替え。前ラウンドの演出を持ち越さない */
  reset(game: AnyGame): void {
    this.clockBaseMs += this.game.tick * this.game.tickMs;
    this.game = game;
    this.cursor = 0;
    this.localTweens.clear();
    this.flights.clear();
    this.fx = [];
    this.vanish = [];
    this.lineFx = [];
    this.afterimages = [];
    this.reflections = [];
    this.attach.clear();
    this.notices = [];
    this.countdown = null;
    this.refreshFx = null;
    this.stockCache = { key: '', indices: null };
    this.resetVis();
  }

  private ticksOf(ms: number): number {
    return (ms * this.game.config.tickRate) / 1000;
  }

  /** 役成立光の共有時計（ms） */
  glowClockMs(t: number): number {
    return this.clockBaseMs + t * this.game.tickMs;
  }

  /** 共有時計から A/B を選ぶ（phase = floor(ms/250) % 2） */
  glowPhase(t: number): 'a' | 'b' {
    return Math.floor(this.glowClockMs(t) / this.vc.glowFrameMs) % 2 === 0 ? 'a' : 'b';
  }

  // ---- 補間値 ----

  /** 足場・キャラのY */
  barVisual(p: PlayerId, t: number): number {
    return this.bar(p, t, false);
  }

  /** 盤面ピースの基準Y（ライン消去後の段数推移ではピースは動かない） */
  pieceBar(p: PlayerId, t: number): number {
    return this.bar(p, t, true);
  }

  private bar(p: PlayerId, t: number, piecesOnly: boolean): number {
    const v = this.pv[p];
    let y = barY(this.boards[p], v.height);
    for (const tw of v.barTweens) {
      if (piecesOnly && !tw.piecesFollow) continue;
      y += tw.offset * (1 - easeOutQuad(progress(t, tw.start, tw.end)));
    }
    return y;
  }

  private localK(id: number, logical: number, t: number): { k: number; tw: LocalTween | null } {
    const tw = this.localTweens.get(id);
    if (!tw || t >= tw.end) return { k: logical, tw: null };
    return { k: lerp(tw.fromK, tw.toK, easeInOutSine(progress(t, tw.start, tw.end))), tw };
  }

  characterX(p: PlayerId, t: number): number {
    const m = this.pv[p].move;
    const board = this.boards[p];
    if (m && t < m.end) return lerp(columnCenterX(board, m.from), columnCenterX(board, m.to), easeOutQuad(progress(t, m.start, m.end)));
    return columnCenterX(board, this.game.players[p].selectedCol);
  }

  /** 打ち上げ・帰還ピースの描画位置（テスト・検証用に公開） */
  flightPosition(f: FlightVis, t: number): { x: number; y: number; z: number } {
    const [bx, by] = this.basePos;
    if (!f.failed || t < f.arriveTick) {
      const u = progress(t, f.launchTick, f.arriveTick);
      return { x: lerp(f.start[0], bx, u), y: lerp(f.start[1], by, u), z: Z.launching };
    }
    const colX = cellX(this.boards[f.player], f.col);
    if (t < f.arcStart) return { x: bx + Math.sin((t - f.arriveTick) * 1.7) * 2, y: by, z: Z.launching };
    if (t < f.arcEnd) {
      const [x, y] = arcPoint(progress(t, f.arcStart, f.arcEnd), [bx, by], [colX, this.vc.arcEndY], this.vc.arcHeight);
      return { x, y, z: Z.returning };
    }
    return { x: colX, y: descentY(t, f.arcEnd, f.returnEnd, this.vc.arcEndY, this.reservedSlotY(f, t)), z: Z.returning };
  }

  /** 最新の予約空白のY（盤面上昇に追従） */
  reservedSlotY(f: FlightVis, t: number): number {
    const col = this.game.players[f.player].board.cols[f.col];
    const idx = Math.max(0, col.findIndex((s) => s.kind === 'reserved' && s.pieceId === f.piece.id));
    return this.pieceBar(f.player, t) + CELL * idx;
  }

  activeFlights(): FlightVis[] {
    return [...this.flights.values()];
  }

  /**
   * 役ストック上で光らせる位置（採用ピース）。成立している間は宣言前から発光（確定）。
   * 宣言直後の役名表示中は、消費したストックを採用位置ごと表示し続ける。
   */
  glowTargets(p: PlayerId, t: number): { pieces: Piece[]; indices: number[] } | null {
    const g = this.mode1;
    if (!g) return null;
    const r = this.pv[p].role;
    if (r && t < r.introEnd) return { pieces: r.consumed, indices: r.indices };
    const stock = g.players[p].roleStock;
    const key = `${p}:${stock.map((x) => x.id).join(',')}`;
    if (key !== this.stockCache.key) {
      const ev = evaluateStock(stock);
      this.stockCache = { key, indices: ev.kind === 'ok' ? ev.result.indices : null };
    }
    return this.stockCache.indices ? { pieces: stock, indices: this.stockCache.indices } : null;
  }

  /** 成立光の配置（区間ごとの素材と左上座標）。テスト・検証用に公開 */
  glowPlacements(p: PlayerId, indices: readonly number[], phase: 'a' | 'b') {
    const L = this.assets.layout;
    return glowSegments(indices).map((s) => {
      const slot = L.pRect(p, `stock_${s.start}`);
      const back = this.frame('S6', `role_glow_${s.length}_back_${phase}`);
      const front = this.frame('S6', `role_glow_${s.length}_front_${phase}`);
      const tr = back.target_rect ?? { x: 0, y: 0 };
      return { back, front, x: slot.x - tr.x, y: slot.y - tr.y };
    });
  }

  // ---- イベント取込 ----

  /** ロジックのイベント列を取り込む（描画前に呼ぶ。テストからも利用） */
  syncEvents(): void {
    const ev = this.game.events as ReadonlyArray<GameEvent | Mode2Event>;
    while (this.cursor < ev.length) this.onEvent(ev[this.cursor++]);
  }

  private fxFrames(...ids: string[]): ManifestFrame[] {
    return ids.map((id) => this.assets.atlas.frame('S6', id));
  }

  private notice(id: string, t: number): void {
    this.notices = this.notices.filter((n) => n.id !== id);
    this.notices.push({ id, start: t, end: t + this.ticksOf(this.pvc.noticeMs) });
  }

  private onEvent(e: GameEvent | Mode2Event): void {
    switch (e.type) {
      case 'roundEnd':
      case 'stuck':
      case 'remaining':
        return;
      case 'countdown':
        this.countdown = { value: e.value, start: e.tick, end: e.endTick };
        return;
      case 'cardRefresh':
        this.countdown = null;
        this.refreshFx = e.tick;
        return;
      case 'levelUp':
        this.notice(e.max ? 'show_max' : 'show_level_up', e.tick);
        return;
      case 'allClear':
        this.notice('show_all_clear', e.tick);
        return;
      default:
        break;
    }
    if (!('player' in e)) return;
    const v = this.pv[e.player];
    const board = this.boards[e.player];
    switch (e.type) {
      case 'move':
        v.move = { from: e.from, to: e.to, start: e.tick, end: e.endTick };
        break;
      case 'launch': {
        const start: [number, number] = [cellX(board, e.col), this.pieceBar(e.player, e.tick)];
        this.flights.set(e.piece.id, { piece: e.piece, player: e.player, col: e.col, launchTick: e.tick, arriveTick: e.arriveTick, start, failed: false, arcStart: 0, arcEnd: 0, returnEnd: 0 });
        v.launchPoseStart = e.tick;
        this.fx.push({ frames: this.fxFrames('launch_fx_1', 'launch_fx_2', 'launch_fx_3', 'launch_fx_4'), x: start[0], y: start[1] - 8, start: e.tick, frameTicks: 3 });
        break;
      }
      case 'arrive': {
        const [bx, by] = this.basePos;
        if (e.success) {
          this.flights.delete(e.piece.id);
          e.packedIds.forEach((id, i) => this.retarget(id, i + 1, i, e.tick, e.packEndTick, false));
          if (e.heightAfter !== e.heightBefore) {
            v.barTweens.push({ start: e.tick, end: e.packEndTick, offset: (e.heightAfter - e.heightBefore) * CELL, piecesFollow: true });
            v.height = e.heightAfter;
          }
          this.fx.push({ frames: this.fxFrames('hit_base_fx_1', 'hit_base_fx_2'), x: bx, y: by, start: e.tick, frameTicks: 5 });
        } else {
          const f = this.flights.get(e.piece.id);
          if (f) Object.assign(f, { failed: true, arcStart: e.arcStartTick, arcEnd: e.arcEndTick, returnEnd: e.returnEndTick });
          const n = Math.max(1, Math.round((e.arcStartTick - e.tick) / 3));
          this.fx.push({ frames: this.fxFrames('bounce_fx_1', 'bounce_fx_2', 'bounce_fx_3'), x: bx, y: by, start: e.tick, frameTicks: n });
        }
        break;
      }
      case 'returned':
        this.flights.delete(e.piece.id);
        this.fx.push({ frames: this.fxFrames('return_fx_1', 'return_fx_2'), x: cellX(board, e.col), y: this.pieceBar(e.player, e.tick), start: e.tick, frameTicks: 4 });
        break;
      case 'rotate':
        this.retarget(e.movedId, 0, e.otherIds.length, e.tick, e.endTick, true);
        e.otherIds.forEach((id, i) => this.retarget(id, i + 1, i, e.tick, e.endTick, false));
        v.bPoseStart = e.tick;
        break;
      case 'rise':
        if (e.kind !== 'attack') v.barTweens.push({ start: e.tick, end: e.endTick, offset: (e.heightAfter - e.heightBefore) * CELL, piecesFollow: true });
        v.height = e.heightAfter;
        break;
      case 'declare':
        v.role = { start: e.tick, introEnd: e.introEndTick, attackTick: null, consumed: e.consumed, indices: e.result.indices };
        v.fail = null;
        break;
      case 'declareFail':
        v.fail = { start: e.tick, end: e.tick + this.ticksOf(this.failAnimMs()) };
        break;
      case 'lineClear': {
        const y = this.pieceBar(e.player, e.tick);
        for (const r of e.removed) {
          this.vanish.push({ piece: r.piece, player: e.player, x: cellX(board, r.col), y, start: e.tick, end: e.clearEnd });
          if (this.game.mode === 'mode1') this.reflections.push({ player: e.player, x: cellX(board, r.col), y, col: r.col, start: e.tick });
        }
        this.lineFx.push({ player: e.player, y, start: e.tick });
        if (e.heightAfter !== e.heightBefore) {
          v.barTweens.push({ start: e.clearEnd, end: e.shiftEnd, offset: (e.heightAfter - e.heightBefore) * CELL, piecesFollow: false });
          v.height = e.heightAfter;
        }
        break;
      }
      case 'attack': {
        if (v.role) v.role.attackTick = e.tick;
        if (this.isSingle) break;
        // 送信の演出は受け手の列の上端（相殺の演出はストックの XD 顔＋小爆発）
        if (e.counter.sent > 0) {
          const [tx, ty] = this.pvc.stock.origin[(1 - e.player) as PlayerId];
          this.fx.push({ frames: this.fxFrames('line_send_fx_1', 'line_send_fx_2', 'line_send_fx_3'), x: tx + 8 - 24, y: ty - 30, start: e.tick, frameTicks: 6 });
        }
        break;
      }
      case 'blockStart':
        v.stock = { reservedPx: stockGroupHeight(e.lines), slideFromPx: null, endTick: null };
        break;
      case 'blockEnd': {
        const r = v.stock.reservedPx;
        v.stock = { reservedPx: null, slideFromPx: r ? r + this.pvc.stock.groupGapPx : null, endTick: e.tick };
        break;
      }
      case 'attackCancel':
        this.afterimages.push({ player: e.player, kind: 'counter', lines: e.canceled, start: e.tick });
        break;
      case 'attackDiscard':
        this.afterimages.push({ player: e.player, kind: 'discard', lines: e.lines, start: e.tick });
        break;
      case 'attackRow':
        // 盤面は1段上がり、新しい段は画面下から飛来して接着する（時間は表示のみ。ロジックは即時）
        v.barTweens.push({ start: e.tick, end: e.tick + this.ticksOf(this.pvc.attachFlyMs), offset: (e.heightAfter - e.heightBefore) * CELL, piecesFollow: true });
        for (const id of e.rowIds) this.attach.set(id, e.tick);
        break;
      case 'attackPinch':
        v.pinch = e.state === 'grace' ? { start: e.tick, end: e.graceEnd } : null;
        break;
      case 'roleEnd':
        v.role = null;
        break;
      case 'danger':
        v.grace = e.state === 'grace' ? { start: e.tick, end: e.graceEnd } : null;
        break;
      default:
        break;
    }
  }

  private failAnimMs(): number {
    const t = this.assets.atlas.manifest.recommended_timing?.['S1/fail_declare']?.durations_ms;
    return t ? t.reduce((a, b) => a + b, 0) : 560;
  }

  /** 列内の位置TWEENを（現在の見た目位置から）張り直す */
  private retarget(id: number, fromLogical: number, toK: number, start: number, end: number, dark: boolean): void {
    const cur = this.localK(id, fromLogical, start).k;
    this.localTweens.set(id, { fromK: cur, toK, start, end, dark });
  }

  // ---- 描画 ----

  render(ctx: CanvasRenderingContext2D, t: number): void {
    this.syncEvents();
    ctx.imageSmoothingEnabled = false;
    const key = `${this.game.mode}:${this.game.kind}:${this.hud.firstTo ?? 0}`;
    if (!this.staticLayer || key !== this.staticKey) {
      this.staticLayer = this.buildStaticLayer();
      this.staticKey = key;
    }
    ctx.drawImage(this.staticLayer, 0, 0);
    const items: DrawItem[] = [];
    this.game.players.forEach((_, i) => this.collectPlayer(items, i as PlayerId, t));
    this.collectCenter(items, t);
    this.collectFlights(items, t);
    this.collectFx(items, t);
    items.sort((a, b) => a.z - b.z);
    for (const it of items) {
      if (it.clip) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(it.clip.x, it.clip.y, it.clip.w, it.clip.h);
        ctx.clip();
        it.draw(ctx);
        ctx.restore();
      } else it.draw(ctx);
    }
    this.drawHud(ctx, t);
    this.prune(t);
  }

  frame(sheet: string, id: string): ManifestFrame {
    return this.assets.atlas.frame(sheet, id);
  }

  private put(items: DrawItem[], z: number, f: ManifestFrame, x: number, y: number, opts: { dark?: boolean; alpha?: number; clip?: BoardRect; flipX?: boolean } = {}): void {
    items.push({ z, clip: opts.clip, draw: (ctx) => drawFrame(ctx, this.assets, f, x, y, { dark: opts.dark, alpha: opts.alpha, flipX: opts.flipX }) });
  }

  private buildStaticLayer(): HTMLCanvasElement {
    const L = this.assets.layout;
    const c = document.createElement('canvas');
    c.width = L.data.canvas.w;
    c.height = L.data.canvas.h;
    const g = c.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    // 第3版：共通背景 background_common（640×360）。盤面枠の内側は透明のため盤面の下地を描く
    const at = (sheet: string, id: string, x: number, y: number) => drawFrame(g, this.assets, this.frame(sheet, id), x, y);
    at('background_common', 'background_common', 0, 0);
    const mode2 = this.game.mode === 'mode2';
    this.game.players.forEach((_, i) => {
      const p = i as PlayerId;
      const board = this.boards[p];
      g.fillStyle = '#132538';
      g.fillRect(board.x, board.y, board.w, board.h);
      if (mode2) at('board_frame_mode2', 'board_frame_mode2', board.x - 2, board.y - 2);
      else {
        const vf = L.rect(`p${p + 1}_visual_frame`);
        at(`player_frame_p${p + 1}`, `player_frame_p${p + 1}`, vf.x, vf.y);
      }
      const sb = L.pRect(p, 'stock_background');
      if (mode2) at('count_panel', 'count_panel', sb.x, sb.y);
      else at('stock_frame', 'stock_frame', sb.x, sb.y);
      if (!this.isSingle) {
        const wc = L.pRect(p, 'win_counter');
        at('S5', 'win_count_frame_3', wc.x, wc.y);
      }
    });
    if (this.isSingle) {
      const r = L.data.graphic_mode_rules?.single_info_rect ?? [384, 128, 192, 224];
      at('info_panel', 'info_panel', r[0], r[1]);
    }
    const bf = L.rect('base_frame');
    at('S5', 'base_piece_frame', bf.x, bf.y);
    return c;
  }

  private loop(frames: ManifestFrame[], elapsed: number, per: number): ManifestFrame {
    return frames[Math.floor(Math.max(0, elapsed) / per) % frames.length];
  }

  private once(frames: ManifestFrame[], elapsed: number, per: number): ManifestFrame {
    return frames[Math.min(frames.length - 1, Math.floor(Math.max(0, elapsed) / per))];
  }

  /** プレイヤーのキャラクター（hud.characters。未指定は 1P コタロー／2P アカネ） */
  characterOf(p: PlayerId): Character {
    return this.hud.characters?.[p] ?? (p === 0 ? 'kotaro' : 'akane');
  }

  private characterFrame(p: PlayerId, t: number): ManifestFrame {
    const sheet = CHARACTER_SHEET[this.characterOf(p)];
    const v = this.pv[p];
    const A = this.assets.atlas;
    const tk = (ms: number) => this.ticksOf(ms);
    const pose = characterPose(this.hud.result ?? null, p, t);
    const r = this.hud.result;
    if (pose.anim === 'win' && r) return this.loop(A.animation(sheet, 'win'), t - (r.winnerTick ?? r.startTick), tk(this.vc.charFrameMs.win));
    if (pose.anim === 'lose_fall' && r) return this.once(A.animation(sheet, 'lose_fall'), pose.motionTicks, tk(this.vc.charFrameMs.lose));
    if (v.role && (v.role.attackTick === null || t < v.role.attackTick)) return this.loop(A.animation(sheet, 'attack'), t - v.role.start, tk(this.vc.charFrameMs.attack));
    if (v.fail && t < v.fail.end) {
      // 不成立モーション（採用済み fail_declare 4枠、推奨時間 110/120/180/150ms）
      const frames = A.animation(sheet, 'fail_declare');
      const d = A.manifest.recommended_timing?.[`${sheet}/fail_declare`]?.durations_ms ?? [110, 120, 180, 150];
      let el = (t - v.fail.start) * this.game.tickMs;
      for (let i = 0; i < frames.length; i++) {
        if (el < d[i]) return frames[i];
        el -= d[i];
      }
      return frames[frames.length - 1];
    }
    if (t - v.bPoseStart < tk(this.game.config.timing.bPoseMs)) return A.frame(sheet, this.vc.bPoseSlotId);
    if (t - v.launchPoseStart < tk(this.game.config.timing.launchMs)) return this.once(A.animation(sheet, 'launch'), t - v.launchPoseStart, tk(this.vc.charFrameMs.launch));
    if (v.move && t < v.move.end) return this.loop(A.animation(sheet, 'walk'), t - v.move.start, tk(this.vc.charFrameMs.walk));
    return this.loop(A.animation(sheet, 'idle'), t, tk(this.vc.charFrameMs.idle));
  }

  private collectPlayer(items: DrawItem[], p: PlayerId, t: number): void {
    const L = this.assets.layout;
    const st = this.game.players[p];
    const board = this.boards[p];
    const pieceBar = this.pieceBar(p, t);
    const bar = this.barVisual(p, t);
    st.board.cols.forEach((col, c) => {
      col.forEach((slot, i) => {
        if (slot.kind !== 'piece') return;
        const { k, tw } = this.localK(slot.piece.id, i, t);
        const dark = !!tw?.dark;
        const u = tw ? progress(t, tw.start, tw.end) : 0;
        let x = cellX(board, c) + (dark ? Math.sin(Math.PI * u) * this.vc.rotateCurveX : 0);
        let y = pieceBar + CELL * k;
        const at = this.attach.get(slot.piece.id);
        if (at !== undefined) ({ x, y } = this.attachOffset(at, t, x, y));
        this.put(items, dark ? Z.darkPiece : Z.piece, this.assets.atlas.piece(slot.piece.n, slot.piece.suit), x, y, { dark, clip: at !== undefined ? undefined : board });
      });
    });
    for (const e of this.vanish) {
      if (e.player !== p || t < e.start || t >= e.end) continue;
      const u = progress(t, e.start, e.end);
      if (u < 0.5 && Math.floor((t - e.start) / 2) % 2 === 0) this.put(items, Z.piece, this.assets.atlas.piece(e.piece.n, e.piece.suit), e.x, e.y, { clip: board });
      const fr = this.fxFrames('vanish_fx_1', 'vanish_fx_2');
      this.put(items, Z.contact, fr[u < 0.5 ? 0 : 1], e.x, e.y, { clip: board });
    }
    // 役ピースの反射光（3コマ×50ms、列ごとに30ms遅延・左→右、同列は同時）
    for (const e of this.reflections) {
      if (e.player !== p) continue;
      const i = this.reflectionFrame(e, t);
      if (i !== null) this.put(items, Z.contact, this.frame('role_piece_reflection_sheet', String(i)), e.x, e.y, { clip: board });
    }
    // 1ライン消去の演出（S10 line_clear 60ms×4）
    const lineFrames = this.assets.atlas.animation('S10', 'line_clear');
    for (const e of this.lineFx) {
      if (e.player !== p) continue;
      const i = Math.floor((t - e.start) / this.ticksOf(60));
      if (i >= 0 && i < lineFrames.length) this.put(items, Z.contact, lineFrames[i], board.x, e.y, { clip: board });
    }
    // 足場の線（キャラの足元）
    items.push({
      z: Z.piece,
      draw: (ctx) => {
        ctx.fillStyle = 'rgba(127,180,240,0.85)';
        ctx.fillRect(board.x, Math.round(bar) - 2, board.w, 2);
      },
    });
    // キャラクター（結果の落下は画面外まで）
    const pose = characterPose(this.hud.result ?? null, p, t);
    if (!pose.gone) {
      const cf = this.characterFrame(p, t);
      // 原点（足元）を足場の上へ。落下はモーション終了後に最終姿勢のまま、画像矩形全体が画面外へ出るまで
      const ox = cf.origin?.[0] ?? cf.w / 2;
      const top = bar - 1 - (cf.origin?.[1] ?? cf.h - 1);
      const fallDist = 360 - top;
      const dy = pose.fall > 0 ? fallDist * pose.fall * pose.fall : 0;
      this.put(items, Z.character, cf, this.characterX(p, t) - ox, top + dy);
    }
    // 危険枠（S10 danger_border 250ms）
    if (this.game.mode === 'mode1' && st.board.height() >= this.game.config.dangerHeight) {
      const fr = this.assets.atlas.animation('S10', 'danger_border');
      this.put(items, Z.ui, this.loop(fr, t, this.ticksOf(250)), board.x - 8, board.y - 8);
    }
    if (this.game.mode === 'mode1') this.collectMode1Player(items, p, t);
    // 勝敗表示（S9 160×64）：勝敗ありの対戦のみ。勝利数加算と同時に表示
    const r = this.hud.result;
    if (r && r.kind === 'versus' && t >= r.startTick) {
      const b = L.pRect(p, 'win_lose_banner');
      const phase = this.s9Phase(t);
      this.put(items, Z.result, this.frame('S9', `show_${r.winner === p ? 'win' : 'lose'}_${phase}`), b.x, b.y);
    }
  }

  private collectMode1Player(items: DrawItem[], p: PlayerId, t: number): void {
    const g = this.mode1!;
    const L = this.assets.layout;
    const st = g.players[p] as PlayerState;
    const glow = this.glowTargets(p, t);
    const shown = glow?.pieces ?? st.roleStock;
    shown.forEach((pc, i) => {
      const r = L.pRect(p, `stock_${i}`);
      this.put(items, STOCK_PIECE_Z, this.assets.atlas.piece(pc.n, pc.suit, true), r.x, r.y);
    });
    if (glow) {
      for (const gp of this.glowPlacements(p, glow.indices, this.glowPhase(t))) {
        this.put(items, Z.glowBack, gp.back, gp.x, gp.y);
        this.put(items, Z.glowFront, gp.front, gp.x, gp.y);
      }
    }
    if (!this.isSingle) this.collectAttackStock(items, p, t);
    // 役名ロゴ（S7 A/B/C）：表示予定は RoleNameDirector（第13章）。ゲーム処理の時間とは独立
    const logo = this.hud.roleLogo?.(p, t) ?? null;
    if (logo) {
      const r = L.pRect(p, 'role_logo');
      const letter = (['A', 'B', 'C'] as const)[Math.floor((t - logo.since) / this.ticksOf(this.vc.roleFrameMs)) % 3];
      this.put(items, Z.roleName, this.assets.atlas.role(logo.logo, letter), r.x, r.y);
    }
  }

  /** 攻撃段の接着位置：画面下から飛来 → 揺れ（最大2px）。テスト・検証用に公開 */
  attachOffset(start: number, t: number, x: number, y: number): { x: number; y: number } {
    const fly = this.ticksOf(this.pvc.attachFlyMs);
    const shake = this.ticksOf(this.pvc.attachShakeMs);
    if (t < start + fly) return { x, y: Math.round(lerp(360 + 4, y, easeOutQuad(progress(t, start, start + fly)))) };
    if (t < start + fly + shake) {
      const u = progress(t, start + fly, start + fly + shake);
      return { x: x + Math.round(Math.sin(u * Math.PI * 4) * this.pvc.attachShakePx * (1 - u)), y };
    }
    return { x, y };
  }

  private reflectionFrame(e: ReflectionVis, t: number): number | null {
    const ms = (t - e.start) * this.game.tickMs - e.col * this.pvc.reflectionColumnDelayMs;
    if (ms < 0) return null;
    const i = Math.floor(ms / this.pvc.reflectionFrameMs);
    return i < REFLECTION_FRAMES ? i : null;
  }

  /**
   * 受攻撃ストック（第10章）：上＝処理中ブロック（予約高さを終了まで維持・残りアイコンを点滅枠で囲う）、
   * 下＝nextPending（予約領域の下に固定。ブロック終了で120ms上詰め）。表示の合計＝3状態の合計。
   */
  stockView(p: PlayerId, t: number): { blockLines: number; pendingLines: number; blockY: number; pendingY: number; reservedPx: number | null } {
    const g = this.mode1!;
    const s = g.players[p].incoming;
    const v = this.pv[p].stock;
    const cfg = this.pvc.stock;
    const [, oy] = cfg.origin[p];
    const blockLines = s.blockActive ? s.blockRemaining + s.waveRemaining : 0;
    // 予約高さはブロック開始時の量（blockReserved）から。終了まで縮めない
    const reservedPx = s.blockActive ? stockGroupHeight(s.blockReserved) : null;
    const sinceEnd = v.endTick === null ? null : (t - v.endTick) * g.tickMs;
    const py = pendingGroupY(reservedPx, v.slideFromPx, sinceEnd, cfg);
    return { blockLines, pendingLines: s.nextPending, blockY: oy, pendingY: oy + py, reservedPx };
  }

  /** 表示中の残像（相殺・ピンチ破棄）。テスト・検証用に公開 */
  stockAfterimages(p: PlayerId, t: number): { kind: 'counter' | 'discard'; lines: number; frame: number }[] {
    const cfg = this.pvc.stock;
    return this.afterimages
      .filter((a) => a.player === p && t >= a.start)
      .map((a) => {
        const ms = (t - a.start) * this.game.tickMs;
        return { kind: a.kind, lines: a.lines, frame: a.kind === 'counter' ? Math.floor(ms / cfg.counterFrameMs) : ms / cfg.discardFadeMs };
      })
      .filter((a) => (a.kind === 'counter' ? a.frame < BURST_FRAMES : a.frame < 1));
  }

  /** プレイヤーのモーションシート（テスト・検証用に公開） */
  characterSheet(p: PlayerId): string {
    return CHARACTER_SHEET[this.characterOf(p)];
  }

  private collectAttackStock(items: DrawItem[], p: PlayerId, t: number): void {
    const cfg = this.pvc.stock;
    const [ox] = cfg.origin[p];
    const sv = this.stockView(p, t);
    const icon = (size: 'large' | 'small', xd = false) => this.frame(`attack_stock_nekotaro_${size}${xd ? '_xd' : ''}`, '0');
    const group = (lines: number, x0: number, y0: number, opts: { xd?: boolean; alpha?: number } = {}) => {
      for (const ic of stockIcons(lines)) this.put(items, Z.ui, icon(ic.size, opts.xd), x0 + ic.x, y0 + ic.y, { alpha: opts.alpha });
    };
    group(sv.blockLines, ox, sv.blockY);
    if (sv.blockLines > 0) {
      // 残ったアイコンだけを囲う（9スライス 3px、内寸16×群の高さ）。240ms で通常／明るいを交互
      const bright = Math.floor((t * this.game.tickMs) / cfg.blinkMs) % 2 === 1;
      const f = this.frame(bright ? 'attack_stock_active_frame_bright' : 'attack_stock_active_frame', '0');
      const h = stockGroupHeight(sv.blockLines);
      items.push({ z: Z.ui + 1, draw: (ctx) => drawNineSlice(ctx, this.assets, f, 3, ox - 3, sv.blockY - 3, 22, h + 6) });
    }
    group(sv.pendingLines, ox, sv.pendingY);
    for (const a of this.afterimages) {
      if (a.player !== p) continue;
      const ms = (t - a.start) * this.game.tickMs;
      if (ms < 0) continue;
      if (a.kind === 'discard') {
        // ピンチ破棄：XD顔・SEなし。ブロックの残りの下でフェードして消える
        if (ms < cfg.discardFadeMs) group(a.lines, ox, sv.blockY + stockGroupHeight(sv.blockLines), { alpha: 1 - ms / cfg.discardFadeMs });
        continue;
      }
      // 相殺：XD顔＋小爆発（4コマ×40ms）。数量は即時に減っており、これは残像
      const fi = Math.floor(ms / cfg.counterFrameMs);
      if (fi >= BURST_FRAMES) continue;
      const y0 = sv.pendingY + stockGroupHeight(sv.pendingLines);
      group(a.lines, ox, y0, { xd: true });
      for (const ic of stockIcons(a.lines)) {
        const large = ic.size === 'large';
        const bf = this.frame(large ? 'attack_stock_cancel_burst_sheet' : 'attack_stock_cancel_burst_small_sheet', String(fi));
        const c = large ? 8 : 4;
        this.put(items, Z.ui + 2, bf, ox + ic.x + c - bf.w / 2, y0 + ic.y + c - bf.h / 2);
      }
    }
  }

  private s9Phase(t: number): 'A' | 'B' | 'C' {
    return (['A', 'B', 'C'] as const)[Math.floor(t / this.ticksOf(90)) % 3];
  }

  private collectCenter(items: DrawItem[], t: number): void {
    const L = this.assets.layout;
    const g = this.game;
    const bp = L.rect('base_piece');
    this.put(items, Z.ui, this.assets.atlas.piece(g.base.n, g.base.suit), bp.x, bp.y);
    if (this.refreshFx !== null) {
      const fr = this.assets.atlas.animation('S10', 'card_refresh');
      const i = Math.floor((t - this.refreshFx) / this.ticksOf(90));
      if (i >= 0 && i < fr.length) this.put(items, Z.contact, fr[i], bp.x + 16 - 24, bp.y + 16 - 24);
    }
    const m = L.rect('mascot');
    const A = this.assets.atlas;
    const goEnd = g.playStartTick + g.ticks(g.config.timing.goMs);
    let anim = 'idle';
    const anyGrace = g.mode === 'mode1' && this.pv.some((v) => v.grace || v.pinch);
    const anyRole = this.pv.some((v) => v.role);
    const plan = this.hud.result ?? null;
    // クラッカー：勝者演出と同時に1回だけ（4コマ×220ms）。素材は右向きのため、勝者が1P（左）なら左右反転
    const cp = crackerPose(plan, t, g.tickMs);
    if (cp) {
      this.put(items, Z.character, A.animation('S3', 'cracker')[cp.frame], m.x, m.y, { flipX: cp.toward === 0 });
    } else {
      if (g.result) {
        if (g.result.outcome === 'draw' || g.result.outcome === 'gameOver') anim = 'sad';
        else if (plan && plan.crackerTick !== null && t >= plan.crackerTick) anim = 'joy';
        else anim = 'surprise';
      } else if (t < g.playStartTick) anim = 'ready';
      else if (t < goEnd) anim = 'start';
      else if (anyGrace) anim = 'panic';
      else if (anyRole) anim = 'joy';
      else if (this.pv.some((v) => v.fail && t < v.fail.end)) anim = 'surprise';
      this.put(items, Z.character, this.loop(A.animation('S3', anim), t, this.ticksOf(this.vc.charFrameMs.idle)), m.x, m.y);
    }
    const phase = this.s9Phase(t);
    const banner = (id: string, rectId = 'ready_banner', dy = 0, alpha?: number) => {
      const r = L.rect(rectId);
      this.put(items, Z.banner, this.frame('S9', `${id}_${phase}`), r.x, r.y + dy, { alpha });
    };
    const r = this.hud.result;
    if (r && t >= r.startTick) {
      if (r.kind === 'draw') banner('show_draw');
      else if (r.kind === 'gameOver') banner('show_game_over');
      else if (r.kind === 'stageClear') banner('show_stage_clear');
      else if (r.kind === 'allStagesClear') banner('show_all_stages_complete');
      else if (r.kind === 'clear') banner('show_all_clear');
      else if (this.hud.matchOver) banner('show_result');
    } else if (t < g.playStartTick) banner('show_ready');
    else if (t < goEnd && !g.result) banner('show_go', 'go_banner');
    // MODE2 カウントダウン：数字のみ（枠・窓なし）。上から出現→停止→下へ消える。動きはコード側
    const cd = this.countdown;
    if (cd && !g.result && t >= cd.start && t < cd.end) {
      const el = (t - cd.start) * g.tickMs;
      const total = (cd.end - cd.start) * g.tickMs;
      const fade = this.pvc.countdownFadeMs;
      const off = this.pvc.countdownOffsetPx;
      let dy = 0;
      let alpha = 1;
      if (el < fade) {
        const a = el / fade;
        dy = Math.round(-off * (1 - a));
        alpha = a;
      } else if (el > total - fade) {
        const a = (el - (total - fade)) / fade;
        dy = Math.round(off * a);
        alpha = 1 - a;
      }
      banner(`show_countdown_${cd.value}`, 'countdown', dy, Math.max(0, Math.min(1, alpha)));
    }
    // 一時演出（LEVEL UP／MAX／全消し）
    for (const n of this.notices) {
      if (t < n.start || t >= n.end) continue;
      const rr = L.rect('ready_banner');
      this.put(items, Z.banner, this.frame('S9', `${n.id}_${phase}`), rr.x, rr.y - 60);
    }
  }

  private collectFlights(items: DrawItem[], t: number): void {
    for (const f of this.flights.values()) {
      const pos = this.flightPosition(f, t);
      this.put(items, pos.z, this.assets.atlas.piece(f.piece.n, f.piece.suit), pos.x, pos.y);
    }
  }

  private collectFx(items: DrawItem[], t: number): void {
    for (const e of this.fx) {
      const i = Math.floor((t - e.start) / e.frameTicks);
      if (i >= 0 && i < e.frames.length) this.put(items, Z.contact, e.frames[i], e.x, e.y);
    }
  }

  private prune(t: number): void {
    this.fx = this.fx.filter((e) => t - e.start < e.frames.length * e.frameTicks);
    this.vanish = this.vanish.filter((e) => t < e.end);
    this.lineFx = this.lineFx.filter((e) => t - e.start < this.ticksOf(60) * 4);
    this.afterimages = this.afterimages.filter((a) => (t - a.start) * this.game.tickMs < Math.max(this.pvc.stock.counterFrameMs * BURST_FRAMES, this.pvc.stock.discardFadeMs));
    this.reflections = this.reflections.filter((e) => (t - e.start) * this.game.tickMs < e.col * this.pvc.reflectionColumnDelayMs + REFLECTION_FRAMES * this.pvc.reflectionFrameMs);
    for (const [id, st] of this.attach) if (t >= st + this.ticksOf(this.pvc.attachFlyMs + this.pvc.attachShakeMs)) this.attach.delete(id);
    this.notices = this.notices.filter((n) => t < n.end);
    if (this.refreshFx !== null && t - this.refreshFx > this.ticksOf(400)) this.refreshFx = null;
    for (const [id, tw] of this.localTweens) if (t >= tw.end) this.localTweens.delete(id);
    for (const v of this.pv) {
      v.barTweens = v.barTweens.filter((tw) => t < tw.end);
      if (v.fail && t >= v.fail.end) v.fail = null;
    }
  }

  // ---- 文字・数値 ----

  private drawHud(ctx: CanvasRenderingContext2D, t: number): void {
    const L = this.assets.layout;
    const g = this.game;
    const ms = this.glowClockMs(t);
    drawText(ctx, g.mode === 'mode1' ? 'MODE1' : 'MODE2', 320, 6, { align: 'center', size: 14, weight: 700 });
    g.players.forEach((_, i) => {
      const p = i as PlayerId;
      const board = this.boards[p];
      if (g.mode === 'mode1') {
        const st = (g as Game).players[p];
        // 倍率（S12枠なし数字）：対戦＝攻撃倍率、シングル＝得点倍率
        const mr = L.pRect(p, 'multiplier');
        const txt = this.isSingle
          ? (() => {
              const m = (g as Game).currentScoreMultiplier(st);
              return multiplierText(m.num, m.den);
            })()
          : multiplierText((g as Game).currentStreakPercent(st), 100);
        drawNumeric(ctx, this.assets, txt, mr.x, mr.y, mr.w, numericPhase(ms));
        drawText(ctx, this.isSingle ? '得点倍率' : '攻撃倍率', mr.x + mr.w / 2, mr.y + 33, { align: 'center', size: 9, color: TEXT_COLORS.secondary });
        this.drawChainGauge(ctx, p, st);
        // 危険の残り時間：自然上昇の危険猶予と攻撃ピンチ猶予のうち早い期限（どちらも自分の役処理中は止まる）
        const rest = g.result ? null : this.dangerRemainingTicks(st);
        if (rest !== null) drawText(ctx, `危険 ${((rest * g.tickMs) / 1000).toFixed(1)}秒`, board.x + board.w / 2, board.y + 4, { align: 'center', size: 12, weight: 700, color: '#ff8a8a', box: true });
      } else {
        // MODE2：役・攻撃の要素は出さない。手役ストックと同じ領域に残りピース数
        const m2 = g as Mode2Game;
        const sb = L.pRect(p, 'stock_background');
        drawText(ctx, `残り ${m2.remaining(m2.players[p])}`, sb.x + sb.w / 2, sb.y + 7, { align: 'center', size: 14, weight: 600 });
      }
      if (!this.isSingle && this.hud.wins) this.drawWins(ctx, p, t);
      if (this.hud.labels && !this.isSingle) drawText(ctx, this.hud.labels[p], p === 0 ? 4 : 636, 4, { align: p === 0 ? 'left' : 'right', size: 10, color: TEXT_COLORS.secondary });
    });
    if (this.isSingle) this.drawSingleInfo(ctx);
    else if (this.hud.firstTo) drawText(ctx, `${this.hud.firstTo}本先取 R${this.hud.round ?? 1}`, 320, 124, { align: 'center', size: 10, color: TEXT_COLORS.secondary });
  }

  /** 危険表示の残りtick（自然上昇の危険猶予・攻撃ピンチ猶予の早い方。どちらもなければ null） */
  private dangerRemainingTicks(st: PlayerState): number | null {
    const xs = [st.graceRemaining, st.incoming.pinchRemaining].filter((x): x is number => x !== null);
    return xs.length ? Math.max(0, Math.min(...xs)) : null;
  }

  private drawChainGauge(ctx: CanvasRenderingContext2D, p: PlayerId, st: PlayerState): void {
    if (st.chainRemaining <= 0) return;
    const g = this.mode1!;
    const r = this.assets.layout.pRect(p, 'chain_gauge');
    const ratio = Math.min(1, st.chainRemaining / g.ticks(g.config.chainWindowMs));
    const id = ratio > 0.5 ? 'timer_fill_safe' : ratio > 0.25 ? 'timer_fill_warn' : 'timer_fill_danger';
    const f = this.frame('S11', id);
    const h = Math.max(1, Math.round(f.h * ratio));
    ctx.drawImage(this.assets.images.get('S11')!, f.x, f.y + (f.h - h), f.w, h, r.x, r.y + (r.h - h), f.w, h);
    if (st.chainCount > 0) drawText(ctx, `連鎖${st.chainCount}`, r.x + r.w / 2, r.y + r.h + 2, { align: 'center', size: 9, color: TEXT_COLORS.secondary });
  }

  private drawWins(ctx: CanvasRenderingContext2D, p: PlayerId, t: number): void {
    const wins = this.hud.wins!;
    const r = this.assets.layout.pRect(p, 'win_counter');
    const firstTo = this.hud.firstTo ?? 2;
    for (let i = 0; i < firstTo; i++) {
      const won = i < wins[p];
      const fresh = won && i === wins[p] - 1 && !!this.hud.result && Math.floor(t / 8) % 2 === 0;
      drawFrame(ctx, this.assets, this.frame('S5', fresh ? 'win_count_slot_flash' : won ? 'win_count_slot_fill' : 'win_count_slot_empty'), r.x + 4 + 20 * i, r.y + 4);
    }
  }

  /** シングルの右側：2P盤面の代わりの情報欄（第3版 info_panel は暗い面：明色文字・影なし） */
  private drawSingleInfo(ctx: CanvasRenderingContext2D): void {
    const r = this.assets.layout.data.graphic_mode_rules?.single_info_rect ?? [384, 128, 192, 224];
    const x = r[0] + 16;
    let y = r[1] + 12;
    const title = (s: string) => {
      drawText(ctx, s, x, y, { size: 14, weight: 700, color: '#f2b950' });
      y += 26;
    };
    const line = (label: string, value: string) => {
      ctx.fillStyle = 'rgba(165,197,197,0.35)';
      ctx.fillRect(x, y - 4, r[2] - 32, 1);
      drawText(ctx, label, x, y, { size: 10, color: TEXT_COLORS.secondary });
      drawText(ctx, value, x, y + 14, { size: 20, weight: 700 });
      y += 52;
    };
    const g = this.game;
    if (g.mode === 'mode2') {
      const m2 = g as Mode2Game;
      title('MODE2 シングル');
      line('経過時間', formatTime(m2.elapsedMs()));
      line('残りピース', String(m2.remaining(m2.players[0])));
      return;
    }
    const s = (g as Game).single!;
    title(s.kind === 'endless' ? 'ひたすら' : 'ステージクリア');
    line('得点', s.score.toLocaleString('ja-JP'));
    if (s.kind === 'endless') {
      const req = levelDef(s.level).required_clears_to_next;
      line('レベル', req === null ? `Lv ${s.level} MAX` : `Lv ${s.level}`);
      line('次Lvまで', req === null ? 'MAX' : `あと ${Math.max(0, req - s.levelProgress)}個`);
    } else {
      line('ステージ', `${s.stage} / 10`);
      line('ノルマ', `${Math.min(s.progress, s.quota)} / ${s.quota}`);
    }
  }
}
