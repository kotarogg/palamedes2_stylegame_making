// ゲーム画面の描画。ロジックのイベント列を読み、時間補間だけを行う（ロジックへ書き戻さない）。
import { layoutAttackIcons } from '../core/attack';
import { DEFAULT_VIEW_CONFIG, type ViewConfig } from '../core/config';
import type { Game, GameEvent } from '../core/game';
import { evaluateStock, glowSegments } from '../core/roles';
import { PLAYERS, type Piece, type PlayerId } from '../core/types';
import { drawFrame, type Assets } from './assets';
import type { ManifestFrame } from './data';
import {
  arcPoint,
  barY,
  CELL,
  cellX,
  columnCenterX,
  descentY,
  easeInOutSine,
  easeOutQuad,
  lerp,
  progress,
  Z,
  type BoardRect,
} from './geometry';
import type { SoundBus } from './sound';

/**
 * 役ストックのピースの描画レイヤー。役成立光は「背面→ピース→前面」（確定）だが、
 * 画面JSONのレイヤー表では役ストック50＜背面光55 のため、ストックのピースを背面光とキャラの間に置く（要確認として報告）。
 */
export const STOCK_PIECE_Z = Z.glowBack + 1;

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

interface FlightVis {
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
  logos: number[];
  consumed: Piece[];
  indices: number[];
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
  notices: { text: string; start: number }[];
}

interface DrawItem {
  z: number;
  clip?: BoardRect;
  draw: (ctx: CanvasRenderingContext2D) => void;
}

/** 試合進行の表示用情報（main から毎フレーム渡す） */
export interface MatchInfo {
  wins: readonly [number, number];
  firstTo: number;
  state: 'round' | 'roundResult' | 'matchResult';
  canConfirm: boolean;
  round: number;
  paused: boolean;
  labels: readonly [string, string];
}

export class GameView {
  private cursor = 0;
  private readonly pv: Record<PlayerId, PlayerVis>;
  private readonly localTweens = new Map<number, LocalTween>();
  private readonly flights = new Map<number, FlightVis>();
  private fx: FxVis[] = [];
  private vanish: VanishVis[] = [];
  private staticLayer: HTMLCanvasElement | null = null;
  private readonly boards: Record<PlayerId, BoardRect>;
  private readonly basePos: [number, number];
  private readonly vt: Record<'launchPose' | 'bPose' | 'role' | 'idle' | 'walk' | 'launch' | 'attack' | 'win' | 'lose', number>;
  /** 役成立光の共有時計：ラウンドを跨いでも巻き戻さない（ms） */
  private clockBaseMs = 0;
  private stockCache: { key: string; indices: number[] | null } = { key: '', indices: null };
  showHud = true;
  match: MatchInfo | null = null;

  constructor(
    private game: Game,
    private readonly assets: Assets,
    private readonly vc: ViewConfig = DEFAULT_VIEW_CONFIG,
    private readonly sound: SoundBus | null = null,
  ) {
    const L = assets.layout;
    this.boards = { 0: L.pRect(0, 'board'), 1: L.pRect(1, 'board') };
    const b = L.rect('base_piece');
    this.basePos = [b.x, b.y];
    const tk = (ms: number) => (ms * game.config.tickRate) / 1000;
    this.vt = {
      launchPose: tk(game.config.timing.launchMs),
      bPose: tk(game.config.timing.bPoseMs),
      role: tk(vc.roleFrameMs),
      idle: tk(vc.charFrameMs.idle),
      walk: tk(vc.charFrameMs.walk),
      launch: tk(vc.charFrameMs.launch),
      attack: tk(vc.charFrameMs.attack),
      win: tk(vc.charFrameMs.win),
      lose: tk(vc.charFrameMs.lose),
    };
    this.pv = { 0: this.newPlayerVis(0), 1: this.newPlayerVis(1) };
  }

  private newPlayerVis(id: PlayerId): PlayerVis {
    return {
      height: this.game.players[id].board.height(),
      barTweens: [],
      move: null,
      launchPoseStart: -1e9,
      bPoseStart: -1e9,
      role: null,
      fail: null,
      grace: null,
      notices: [],
    };
  }

  /** 新しいラウンド（ゲーム）へ差し替え */
  reset(game: Game): void {
    this.clockBaseMs += this.game.tick * this.game.tickMs;
    this.game = game;
    this.cursor = 0;
    this.localTweens.clear();
    this.flights.clear();
    this.fx = [];
    this.vanish = [];
    this.pv[0] = this.newPlayerVis(0);
    this.pv[1] = this.newPlayerVis(1);
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

  /** 帰還ピースの描画位置（テスト・検証用に公開） */
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
  private reservedSlotY(f: FlightVis, t: number): number {
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
    const r = this.pv[p].role;
    if (r && t < r.introEnd) return { pieces: r.consumed, indices: r.indices };
    const stock = this.game.players[p].roleStock;
    const key = stock.map((x) => x.id).join(',');
    if (key !== this.stockCache.key) {
      const ev = evaluateStock(stock);
      this.stockCache = { key, indices: ev.kind === 'ok' ? ev.result.indices : null };
    }
    return this.stockCache.indices ? { pieces: stock, indices: this.stockCache.indices } : null;
  }

  /** 成立光の配置（区間ごとの素材と左上座標）。テスト・検証用に公開 */
  glowPlacements(p: PlayerId, indices: readonly number[], phase: 'a' | 'b'): Array<{ back: ManifestFrame; front: ManifestFrame; x: number; y: number }> {
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
    const ev = this.game.events;
    while (this.cursor < ev.length) this.onEvent(ev[this.cursor++]);
  }

  private fxFrames(...ids: string[]): ManifestFrame[] {
    return ids.map((id) => this.assets.atlas.frame('S6', id));
  }

  private se(code: Parameters<SoundBus['play']>[0], atTick: number, now: number): void {
    this.sound?.play(code, (atTick - now) * this.game.tickMs);
  }

  private onEvent(e: GameEvent): void {
    if (e.type === 'roundEnd') {
      this.se('win', e.tick, e.tick);
      return;
    }
    const v = this.pv[e.player];
    const board = this.boards[e.player];
    switch (e.type) {
      case 'move':
        v.move = { from: e.from, to: e.to, start: e.tick, end: e.endTick };
        break;
      case 'launch': {
        const start: [number, number] = [cellX(board, e.col), this.pieceBar(e.player, e.tick)];
        this.flights.set(e.piece.id, {
          piece: e.piece,
          player: e.player,
          col: e.col,
          launchTick: e.tick,
          arriveTick: e.arriveTick,
          start,
          failed: false,
          arcStart: 0,
          arcEnd: 0,
          returnEnd: 0,
        });
        v.launchPoseStart = e.tick;
        this.fx.push({ frames: this.fxFrames('launch_fx_1', 'launch_fx_2', 'launch_fx_3', 'launch_fx_4'), x: start[0], y: start[1] - 8, start: e.tick, frameTicks: 3 });
        this.se('launch', e.tick, e.tick);
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
          this.se('hit', e.tick, e.tick);
        } else {
          const f = this.flights.get(e.piece.id);
          if (f) Object.assign(f, { failed: true, arcStart: e.arcStartTick, arcEnd: e.arcEndTick, returnEnd: e.returnEndTick });
          const n = Math.max(1, Math.round((e.arcStartTick - e.tick) / 3));
          this.fx.push({ frames: this.fxFrames('bounce_fx_1', 'bounce_fx_2', 'bounce_fx_3'), x: bx, y: by, start: e.tick, frameTicks: n });
          this.se('bounce', e.tick, e.tick);
        }
        break;
      }
      case 'returned': {
        this.flights.delete(e.piece.id);
        this.fx.push({ frames: this.fxFrames('return_fx_1', 'return_fx_2'), x: cellX(board, e.col), y: this.pieceBar(e.player, e.tick), start: e.tick, frameTicks: 4 });
        break;
      }
      case 'rotate': {
        this.retarget(e.movedId, 0, e.otherIds.length, e.tick, e.endTick, true);
        e.otherIds.forEach((id, i) => this.retarget(id, i + 1, i, e.tick, e.endTick, false));
        v.bPoseStart = e.tick;
        break;
      }
      case 'rise':
        if (e.kind !== 'attack') v.barTweens.push({ start: e.tick, end: e.endTick, offset: (e.heightAfter - e.heightBefore) * CELL, piecesFollow: true });
        v.height = e.heightAfter;
        break;
      case 'declare':
        v.role = { start: e.tick, introEnd: e.introEndTick, attackTick: null, logos: e.logos, consumed: e.consumed, indices: e.result.indices };
        v.fail = null;
        this.se('declareOk', e.tick, e.tick);
        break;
      case 'declareFail':
        v.fail = { start: e.tick, end: e.lockEnd };
        v.notices.push({ text: '不成立', start: e.tick });
        this.se('declareFail', e.tick, e.tick);
        break;
      case 'lineClear': {
        // 消去中は元の位置で消える演出 → 処理効果音 → 足場・キャラだけ段数TWEEN（ピースは動かない）
        const y = this.pieceBar(e.player, e.tick);
        for (const r of e.removed) this.vanish.push({ piece: r.piece, x: cellX(board, r.col), y, start: e.tick, end: e.clearEnd });
        if (e.heightAfter !== e.heightBefore) {
          v.barTweens.push({ start: e.clearEnd, end: e.shiftEnd, offset: (e.heightAfter - e.heightBefore) * CELL, piecesFollow: false });
          v.height = e.heightAfter;
        }
        this.se('lineClear', e.clearEnd, e.tick);
        break;
      }
      case 'attack': {
        if (v.role) v.role.attackTick = e.tick;
        const L = this.assets.layout;
        const [ox, oy] = L.attackOrigin(e.player);
        if (e.counter.canceled > 0) this.fx.push({ frames: this.fxFrames('counter_fx_1', 'counter_fx_2'), x: ox - 12, y: oy - 8, start: e.tick, frameTicks: 8 });
        if (e.counter.sent > 0) {
          const [tx, ty] = L.attackOrigin((1 - e.player) as PlayerId);
          this.fx.push({ frames: this.fxFrames('line_send_fx_1', 'line_send_fx_2', 'line_send_fx_3'), x: tx - 12, y: ty - 8, start: e.tick, frameTicks: 6 });
        }
        break;
      }
      case 'roleEnd':
        v.role = null;
        break;
      case 'danger':
        if (e.state === 'grace') {
          v.grace = { start: e.tick, end: e.graceEnd };
          this.se('danger', e.tick, e.tick);
        } else v.grace = null;
        break;
      default:
        break;
    }
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
    if (!this.staticLayer) this.staticLayer = this.buildStaticLayer();
    ctx.drawImage(this.staticLayer, 0, 0);
    const items: DrawItem[] = [];
    for (const p of PLAYERS) this.collectPlayer(items, p, t);
    this.collectCenter(items, t);
    this.collectFlights(items, t);
    this.collectFx(items, t);
    items.sort((a, b) => a.z - b.z); // 安定ソート：同一Zは追加順
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
    if (this.showHud) this.drawHud(ctx, t);
    this.prune(t);
  }

  private frame(sheet: string, id: string): ManifestFrame {
    return this.assets.atlas.frame(sheet, id);
  }

  private put(items: DrawItem[], z: number, f: ManifestFrame, x: number, y: number, opts: { dark?: boolean; clip?: BoardRect; alpha?: number } = {}): void {
    items.push({ z, clip: opts.clip, draw: (ctx) => drawFrame(ctx, this.assets, f, x, y, { dark: opts.dark, alpha: opts.alpha }) });
  }

  private buildStaticLayer(): HTMLCanvasElement {
    const L = this.assets.layout;
    const c = document.createElement('canvas');
    c.width = L.data.canvas.w;
    c.height = L.data.canvas.h;
    const g = c.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    g.fillStyle = '#0b0b1c';
    g.fillRect(0, 0, c.width, c.height);
    const tile = (id: string, x: number, y: number) => drawFrame(g, this.assets, this.frame('S5', id), x, y);
    const panel = (r: BoardRect, fill: string) => {
      for (let y = r.y; y < r.y + r.h; y += 8) for (let x = r.x; x < r.x + r.w; x += 8) tile(fill, x, y);
      for (let x = r.x + 8; x < r.x + r.w - 8; x += 8) {
        tile('panel_edge_h', x, r.y);
        tile('panel_edge_h', x, r.y + r.h - 8);
      }
      for (let y = r.y + 8; y < r.y + r.h - 8; y += 8) {
        tile('panel_edge_v', r.x, y);
        tile('panel_edge_v', r.x + r.w - 8, y);
      }
      tile('panel_corner_tl', r.x, r.y);
      tile('panel_corner_tr', r.x + r.w - 8, r.y);
      tile('panel_corner_bl', r.x, r.y + r.h - 8);
      tile('panel_corner_br', r.x + r.w - 8, r.y + r.h - 8);
    };
    for (const p of PLAYERS) {
      const board = this.boards[p];
      for (let y = board.y; y < board.y + board.h; y += 8) for (let x = board.x; x < board.x + board.w; x += 8) tile('panel_fill_dark', x, y);
      panel(L.pRect(p, 'stock_background'), 'panel_fill_dark');
      const at = (id: string, r: BoardRect) => drawFrame(g, this.assets, this.frame('S5', id), r.x, r.y);
      at('multiplier_panel', L.pRect(p, 'multiplier'));
      at('chain_bar_frame', L.pRect(p, 'chain_gauge'));
      at('win_count_frame_3', L.pRect(p, 'win_counter'));
      const badge = L.pRect(p, 'movement_guide');
      drawFrame(g, this.assets, this.frame('S5', p === 0 ? 'p1_badge' : 'p2_badge'), badge.x + 2, badge.y + 2);
    }
    const bf = L.rect('base_frame');
    drawFrame(g, this.assets, this.frame('S5', 'base_piece_frame'), bf.x, bf.y);
    return c;
  }

  private loop(frames: ManifestFrame[], elapsed: number, per: number): ManifestFrame {
    return frames[Math.floor(Math.max(0, elapsed) / per) % frames.length];
  }

  private once(frames: ManifestFrame[], elapsed: number, per: number): ManifestFrame {
    return frames[Math.min(frames.length - 1, Math.floor(Math.max(0, elapsed) / per))];
  }

  private characterFrame(p: PlayerId, t: number): ManifestFrame {
    const sheet = p === 0 ? 'S1' : 'S2';
    const v = this.pv[p];
    const A = this.assets.atlas;
    const r = this.game.result;
    if (r && t >= r.tick) {
      if (r.winner === p) return this.loop(A.animation(sheet, 'win'), t - r.tick, this.vt.win);
      return this.once(A.animation(sheet, 'lose_fall'), t - r.tick, this.vt.lose);
    }
    // 役処理：キャラモーション切替（攻撃）→ 攻撃処理でモーション戻し
    if (v.role && (v.role.attackTick === null || t < v.role.attackTick)) return this.loop(A.animation(sheet, 'attack'), t - v.role.start, this.vt.attack);
    if (t - v.bPoseStart < this.vt.bPose) return A.frame(sheet, this.vc.bPoseSlotId);
    if (t - v.launchPoseStart < this.vt.launchPose) return this.once(A.animation(sheet, 'launch'), t - v.launchPoseStart, this.vt.launch);
    if (v.move && t < v.move.end) return this.loop(A.animation(sheet, 'walk'), t - v.move.start, this.vt.walk);
    return this.loop(A.animation(sheet, 'idle'), t, this.vt.idle);
  }

  private collectPlayer(items: DrawItem[], p: PlayerId, t: number): void {
    const L = this.assets.layout;
    const st = this.game.players[p];
    const board = this.boards[p];
    const v = this.pv[p];
    const pieceBar = this.pieceBar(p, t);
    const bar = this.barVisual(p, t);
    // 盤面ピース（論理配列＋列内TWEEN＋盤面TWEEN）
    st.board.cols.forEach((col, c) => {
      col.forEach((slot, i) => {
        if (slot.kind !== 'piece') return; // 予約空白は帰還ピース側で描く（二重実体化しない）
        const { k, tw } = this.localK(slot.piece.id, i, t);
        const dark = !!tw?.dark;
        const u = tw ? progress(t, tw.start, tw.end) : 0;
        const x = cellX(board, c) + (dark ? Math.sin(Math.PI * u) * this.vc.rotateCurveX : 0);
        this.put(items, dark ? Z.darkPiece : Z.piece, this.assets.atlas.piece(slot.piece.n, slot.piece.suit), x, pieceBar + CELL * k, { dark, clip: board });
      });
    });
    // ライン消去中のピース（元の位置で点滅→消滅エフェクト）
    for (const e of this.vanish) {
      if (!this.boardOf(e, p) || t < e.start || t >= e.end) continue;
      const u = progress(t, e.start, e.end);
      if (u < 0.5 && Math.floor((t - e.start) / 2) % 2 === 0) this.put(items, Z.piece, this.assets.atlas.piece(e.piece.n, e.piece.suit), e.x, e.y, { clip: board });
      const fr = this.fxFrames('vanish_fx_1', 'vanish_fx_2');
      this.put(items, Z.contact, fr[u < 0.5 ? 0 : 1], e.x, e.y, { clip: board });
    }
    // 足場
    items.push({
      z: Z.piece,
      draw: (ctx) => {
        ctx.fillStyle = '#7fb4f0';
        ctx.fillRect(board.x, Math.round(bar) - 3, board.w, 2);
        ctx.fillStyle = '#2b4a8a';
        ctx.fillRect(board.x, Math.round(bar) - 1, board.w, 1);
      },
    });
    // キャラクター（足元中央アンカー）。不成立モーションは専用素材が無いため待機枠を揺らして代用
    const cf = this.characterFrame(p, t);
    const shake = v.fail && t < v.fail.end ? Math.round(Math.sin((t - v.fail.start) * 1.6) * this.vc.failShakePx) : 0;
    this.put(items, Z.character, cf, this.characterX(p, t) - cf.w / 2 + shake, bar - cf.h);
    // 役ストック（SNAP）と役成立光（背面→ピース→前面、共有時計で同期）
    const glow = this.glowTargets(p, t);
    const shown = glow?.pieces ?? st.roleStock;
    shown.forEach((pc, i) => {
      const r = L.pRect(p, `stock_${i}`);
      this.put(items, STOCK_PIECE_Z, this.assets.atlas.piece(pc.n, pc.suit, true), r.x, r.y);
    });
    if (glow) {
      for (const g of this.glowPlacements(p, glow.indices, this.glowPhase(t))) {
        this.put(items, Z.glowBack, g.back, g.x, g.y);
        this.put(items, Z.glowFront, g.front, g.x, g.y);
      }
    }
    // 攻撃ストック表示
    const icons = layoutAttackIcons(st.attackStock, L.attackOrigin(p), L.attackRules());
    for (const b of icons.big) this.put(items, Z.ui, this.frame('S5', 'attack_icon_big'), b.x, b.y);
    for (const s of icons.small) this.put(items, Z.ui, this.frame('S5', 'attack_icon_small'), s.x, s.y);
    // 連続取得の攻撃倍率・役連鎖ゲージ・勝利数
    this.collectMultiplier(items, p);
    this.collectChainGauge(items, p);
    this.collectWins(items, p, t);
    // 役名（役処理中は表示し続ける）
    const role = v.role;
    if (role) {
      const r = L.pRect(p, 'role_logo');
      const dur = Math.max(1, (role.attackTick ?? t + 1) - role.start);
      const logo = role.logos[Math.min(role.logos.length - 1, Math.floor(((t - role.start) / dur) * role.logos.length))];
      const letter = (['A', 'B', 'C'] as const)[Math.floor((t - role.start) / this.vt.role) % 3];
      this.put(items, Z.roleName, this.assets.atlas.role(logo, letter), r.x, r.y);
    }
    // 勝敗バナー
    const res = this.game.result;
    if (res && t >= res.tick && res.winner !== null) {
      const r = L.pRect(p, 'win_lose_banner');
      this.put(items, Z.result, this.frame('S5', res.winner === p ? 'banner_win' : 'banner_lose'), r.x, r.y);
    }
  }

  private boardOf(e: VanishVis, p: PlayerId): boolean {
    const b = this.boards[p];
    return e.x >= b.x && e.x < b.x + b.w;
  }

  private digits(items: DrawItem[], text: string, x: number, y: number, big: boolean): number {
    for (const ch of text) {
      const id = ch === '.' ? (big ? 'big_dot' : 'sm_dot') : ch === 'x' ? (big ? 'big_x' : 'sm_x') : ch === '+' ? (big ? 'big_plus' : 'sm_plus') : `${big ? 'big' : 'sm'}_${ch}`;
      const f = this.frame('S5', id);
      this.put(items, Z.ui, f, x, y);
      x += f.w;
    }
    return x;
  }

  private collectMultiplier(items: DrawItem[], p: PlayerId): void {
    const r = this.assets.layout.pRect(p, 'multiplier');
    const pct = this.game.currentStreakPercent(this.game.players[p]);
    const int = Math.floor(pct / 100);
    const dec = String(pct % 100).padStart(2, '0');
    // 整数部は大きい数字、小数部は小さい数字（下揃え）。表示位置は暫定
    const x = this.digits(items, `x${int}`, r.x + 6, r.y + 8, true);
    this.digits(items, `.${dec}`, x + 1, r.y + 24, false);
  }

  private collectChainGauge(items: DrawItem[], p: PlayerId): void {
    const st = this.game.players[p];
    if (st.chainRemaining <= 0) return;
    const r = this.assets.layout.pRect(p, 'chain_gauge');
    const ratio = st.chainRemaining / this.game.ticks(this.game.config.chainWindowMs);
    const id = ratio > 0.5 ? 'chain_bar_fill_safe' : ratio > 0.25 ? 'chain_bar_fill_warn' : 'chain_bar_fill_danger';
    const f = this.frame('S5', id);
    const h = Math.max(1, Math.round(f.h * ratio));
    const x = r.x + (r.w - f.w) / 2;
    const y = r.y + 8 + (f.h - h);
    items.push({
      z: Z.ui,
      draw: (ctx) => ctx.drawImage(this.assets.images.get('S5')!, f.x, f.y + (f.h - h), f.w, h, x, y, f.w, h),
    });
  }

  private collectWins(items: DrawItem[], p: PlayerId, t: number): void {
    const m = this.match;
    if (!m) return;
    const r = this.assets.layout.pRect(p, 'win_counter');
    for (let i = 0; i < m.firstTo; i++) {
      const won = i < m.wins[p];
      const fresh = won && i === m.wins[p] - 1 && m.state !== 'round' && Math.floor(t / 8) % 2 === 0;
      this.put(items, Z.ui, this.frame('S5', fresh ? 'win_count_slot_flash' : won ? 'win_count_slot_fill' : 'win_count_slot_empty'), r.x + 4 + 20 * i, r.y + 4);
    }
  }

  private collectCenter(items: DrawItem[], t: number): void {
    const L = this.assets.layout;
    const g = this.game;
    const bp = L.rect('base_piece');
    this.put(items, Z.ui, this.assets.atlas.piece(g.base.n, g.base.suit), bp.x, bp.y);
    // マスコット
    const m = L.rect('mascot');
    const A = this.assets.atlas;
    const goEnd = g.playStartTick + g.ticks(g.config.timing.goMs);
    let anim = 'idle';
    if (g.result) anim = g.result.winner === null ? 'sad' : 'cracker';
    else if (t < g.playStartTick) anim = 'ready';
    else if (t < goEnd) anim = 'start';
    else if (PLAYERS.some((p) => this.pv[p].grace)) anim = 'panic';
    else if (PLAYERS.some((p) => this.pv[p].role)) anim = 'joy';
    else if (PLAYERS.some((p) => this.pv[p].fail && t < this.pv[p].fail!.end)) anim = 'surprise';
    this.put(items, Z.character, this.loop(A.animation('S3', anim), t, this.vt.idle), m.x, m.y);
    // READY / GO / 引分け / 試合結果 / 一時停止
    const banner = (id: string, rectId: string) => {
      const r = L.rect(rectId);
      const f = this.frame('S5', id);
      this.put(items, Z.banner, f, r.x + (r.w - f.w) / 2, r.y);
    };
    if (this.match?.paused) banner('banner_pause', 'ready_banner');
    else if (g.result && this.match?.state === 'matchResult') banner('banner_result', 'ready_banner');
    else if (g.result && g.result.winner === null) banner('banner_draw', 'ready_banner');
    else if (t < g.playStartTick) banner('banner_ready', 'ready_banner');
    else if (t < goEnd && !g.result) banner('banner_go', 'go_banner');
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
    for (const [id, tw] of this.localTweens) if (t >= tw.end) this.localTweens.delete(id);
    for (const p of PLAYERS) {
      const v = this.pv[p];
      v.barTweens = v.barTweens.filter((tw) => t < tw.end);
      v.notices = v.notices.filter((n) => t - n.start < 60);
      if (v.fail && t >= v.fail.end) v.fail = null;
    }
  }

  private drawHud(ctx: CanvasRenderingContext2D, t: number): void {
    ctx.save();
    ctx.font = '10px "Noto Sans CJK JP", "Yu Gothic", "Meiryo", sans-serif';
    ctx.textBaseline = 'top';
    const text = (s: string, x: number, y: number, color = '#ffffff', align: CanvasTextAlign = 'left', box = false) => {
      ctx.textAlign = align;
      if (box) {
        const w = ctx.measureText(s).width + 6;
        const bx = align === 'center' ? x - w / 2 : align === 'right' ? x - w + 3 : x - 3;
        ctx.fillStyle = 'rgba(0,0,16,0.75)';
        ctx.fillRect(Math.round(bx), y - 2, Math.ceil(w), 14);
      }
      ctx.fillStyle = '#000000';
      ctx.fillText(s, x + 1, y + 1);
      ctx.fillStyle = color;
      ctx.fillText(s, x, y);
    };
    for (const p of PLAYERS) {
      const board = this.boards[p];
      const st = this.game.players[p];
      const v = this.pv[p];
      v.notices.forEach((n, i) => text(n.text, board.x + board.w / 2, board.y + 40 + 14 * i, '#ffd060', 'center', true));
      if (st.board.height() >= this.game.config.dangerHeight && Math.floor(t / 15) % 2 === 0) text('DANGER', board.x + board.w - 4, board.y + board.h - 16, '#ff6060', 'right', true);
      if (v.grace) text(`危険猶予 ${(Math.max(0, v.grace.end - t) * this.game.tickMs / 1000).toFixed(1)}秒`, board.x + 4, board.y + board.h - 16, '#ff9090', 'left', true);
      const gx = this.assets.layout.pRect(p, 'chain_gauge');
      if (st.chainRemaining > 0 && st.chainCount > 0) text(`連鎖${st.chainCount}`, gx.x + gx.w / 2, gx.y + gx.h + 2, '#c0ffd0', 'center');
      const sx = p === 0 ? 2 : 598;
      text(`ATK ${st.attackStock}`, sx, 140, '#c0d8ff');
      if (this.game.streakActive(st)) text(`連続${st.streakCount}`, p === 0 ? 2 : 578, 84, '#ffe0a0');
      // 使用機器（役名ロゴ・キャラと重ならない画面端）
      if (this.match) text(this.match.labels[p], p === 0 ? 2 : 638, 150, '#9aa4c0', p === 0 ? 'left' : 'right');
    }
    const m = this.match;
    if (m && m.state !== 'round' && m.canConfirm) text('決定（Enter / Space / 発射キー / Ⓐ）で次へ', 320, 186, '#ffffff', 'center', true);
    if (m) text(`${m.firstTo}本先取  ROUND ${m.round}`, 320, 4, '#9aa4c0', 'center');
    ctx.font = '9px "Noto Sans CJK JP", "Yu Gothic", "Meiryo", sans-serif';
    text('F1:説明 F2:設定 Esc:停止', 320, 349, '#6a7490', 'center'); // 盤面に重ならない中央列
    ctx.restore();
  }
}
