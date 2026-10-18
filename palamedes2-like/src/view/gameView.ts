// ゲーム画面の描画。ロジックのイベント列を読み、時間補間だけを行う（ロジックへ書き戻さない）。
import { layoutAttackIcons } from '../core/attack';
import { DEFAULT_VIEW_CONFIG, type ViewConfig } from '../core/config';
import type { Game, GameEvent } from '../core/game';
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

interface BarTween {
  start: number;
  end: number;
  offset: number;
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

interface PlayerVis {
  height: number;
  barTweens: BarTween[];
  move: { from: number; to: number; start: number; end: number } | null;
  launchPoseStart: number;
  bPoseStart: number;
  declare: { start: number; end: number; logos: number[]; size: 4 | 6 } | null;
  notices: { text: string; start: number }[];
}

interface DrawItem {
  z: number;
  clip?: BoardRect;
  draw: (ctx: CanvasRenderingContext2D) => void;
}

export const NOTICE_TEXT: Record<string, string> = {
  G04_NO_ROLE: '無役：宣言保留（G04未確定）',
  G04_TIE: '同点役：宣言保留（G04未確定）',
  G04_MULTI_LAUNCH: '複数発射は保留（G04未確定）',
  G03_OVERFLOW_PENDING: '7段：上昇保留（G03未確定）',
};

export class GameView {
  private cursor = 0;
  private readonly pv: Record<PlayerId, PlayerVis>;
  private readonly localTweens = new Map<number, LocalTween>();
  private readonly flights = new Map<number, FlightVis>();
  private fx: FxVis[] = [];
  private staticLayer: HTMLCanvasElement | null = null;
  private readonly boards: Record<PlayerId, BoardRect>;
  private readonly basePos: [number, number];
  private readonly vt: { launchPose: number; bPose: number; role: number; idle: number; walk: number; launch: number; attack: number };
  showHud = true;

  constructor(
    private game: Game,
    private readonly assets: Assets,
    private readonly vc: ViewConfig = DEFAULT_VIEW_CONFIG,
  ) {
    const L = assets.layout;
    this.boards = { 0: L.pRect(0, 'board'), 1: L.pRect(1, 'board') };
    const b = L.rect('base_piece');
    this.basePos = [b.x, b.y];
    const tk = (ms: number) => (ms * game.config.tickRate) / 1000;
    this.vt = {
      launchPose: tk(vc.launchPoseMs),
      bPose: tk(game.config.timing.bPoseMs),
      role: tk(vc.roleFrameMs),
      idle: tk(vc.charFrameMs.idle),
      walk: tk(vc.charFrameMs.walk),
      launch: tk(vc.charFrameMs.launch),
      attack: tk(vc.charFrameMs.attack),
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
      declare: null,
      notices: [],
    };
  }

  /** 新しいゲームへ差し替え（リスタート） */
  reset(game: Game): void {
    this.game = game;
    this.cursor = 0;
    this.localTweens.clear();
    this.flights.clear();
    this.fx = [];
    this.pv[0] = this.newPlayerVis(0);
    this.pv[1] = this.newPlayerVis(1);
  }

  // ---- 補間値 ----

  barVisual(p: PlayerId, t: number): number {
    const v = this.pv[p];
    let y = barY(this.boards[p], v.height);
    for (const tw of v.barTweens) y += tw.offset * (1 - easeOutQuad(progress(t, tw.start, tw.end)));
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
    return this.barVisual(f.player, t) + CELL * idx;
  }

  activeFlights(): FlightVis[] {
    return [...this.flights.values()];
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

  private onEvent(e: GameEvent): void {
    const v = this.pv[e.player];
    const board = this.boards[e.player];
    switch (e.type) {
      case 'move':
        v.move = { from: e.from, to: e.to, start: e.tick, end: e.endTick };
        break;
      case 'launch': {
        const start: [number, number] = [cellX(board, e.col), this.barVisual(e.player, e.tick)];
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
        break;
      }
      case 'arrive': {
        const [bx, by] = this.basePos;
        if (e.success) {
          this.flights.delete(e.piece.id);
          e.packedIds.forEach((id, i) => this.retarget(id, i + 1, i, e.tick, e.packEndTick, false));
          if (e.heightAfter !== e.heightBefore) {
            v.barTweens.push({ start: e.tick, end: e.packEndTick, offset: (e.heightAfter - e.heightBefore) * CELL });
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
      case 'returned': {
        this.flights.delete(e.piece.id);
        this.fx.push({ frames: this.fxFrames('return_fx_1', 'return_fx_2'), x: cellX(board, e.col), y: this.barVisual(e.player, e.tick), start: e.tick, frameTicks: 4 });
        break;
      }
      case 'rotate': {
        const last = e.otherIds.length;
        this.retarget(e.movedId, 0, last, e.tick, e.endTick, true);
        e.otherIds.forEach((id, i) => this.retarget(id, i + 1, i, e.tick, e.endTick, false));
        v.bPoseStart = e.tick;
        break;
      }
      case 'rise':
        if (e.kind !== 'attack') v.barTweens.push({ start: e.tick, end: e.endTick, offset: (e.heightAfter - e.heightBefore) * CELL });
        v.height = e.heightAfter;
        break;
      case 'declare':
        v.declare = { start: e.tick, end: e.endTick, logos: e.logos, size: e.result.size };
        break;
      case 'notice': {
        const text = NOTICE_TEXT[e.code];
        if (text) v.notices.push({ text, start: e.tick });
        break;
      }
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

  private put(items: DrawItem[], z: number, f: ManifestFrame, x: number, y: number, opts: { dark?: boolean; clip?: BoardRect } = {}): void {
    items.push({ z, clip: opts.clip, draw: (ctx) => drawFrame(ctx, this.assets, f, x, y, { dark: opts.dark }) });
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

  private characterFrame(p: PlayerId, t: number): ManifestFrame {
    const sheet = p === 0 ? 'S1' : 'S2';
    const v = this.pv[p];
    const A = this.assets.atlas;
    if (v.declare && t < v.declare.end) return this.loop(A.animation(sheet, 'attack'), t - v.declare.start, this.vt.attack);
    if (t - v.bPoseStart < this.vt.bPose) return A.frame(sheet, this.vc.bPoseSlotId);
    if (t - v.launchPoseStart < this.vt.launchPose) {
      const fr = A.animation(sheet, 'launch');
      return fr[Math.min(fr.length - 1, Math.floor((t - v.launchPoseStart) / this.vt.launch))];
    }
    if (v.move && t < v.move.end) return this.loop(A.animation(sheet, 'walk'), t - v.move.start, this.vt.walk);
    return this.loop(A.animation(sheet, 'idle'), t, this.vt.idle);
  }

  private collectPlayer(items: DrawItem[], p: PlayerId, t: number): void {
    const L = this.assets.layout;
    const st = this.game.players[p];
    const board = this.boards[p];
    const bar = this.barVisual(p, t);
    // 盤面ピース（論理配列＋列内TWEEN＋盤面TWEEN）
    st.board.cols.forEach((col, c) => {
      col.forEach((slot, i) => {
        if (slot.kind !== 'piece') return; // 予約空白は帰還ピース側で描く（二重実体化しない）
        const { k, tw } = this.localK(slot.piece.id, i, t);
        const dark = !!tw?.dark;
        const u = tw ? progress(t, tw.start, tw.end) : 0;
        const x = cellX(board, c) + (dark ? Math.sin(Math.PI * u) * this.vc.rotateCurveX : 0);
        this.put(items, dark ? Z.darkPiece : Z.piece, this.assets.atlas.piece(slot.piece.n, slot.piece.suit), x, bar + CELL * k, { dark, clip: board });
      });
    });
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
    // キャラクター（足元中央アンカー）
    const cf = this.characterFrame(p, t);
    this.put(items, Z.character, cf, this.characterX(p, t) - cf.w / 2, bar - cf.h);
    // 役ストック（SNAP）
    st.roleStock.forEach((pc, i) => {
      const r = L.pRect(p, `stock_${i}`);
      this.put(items, Z.ui, this.assets.atlas.piece(pc.n, pc.suit, true), r.x, r.y);
    });
    // 攻撃ストック表示
    const icons = layoutAttackIcons(st.attackStock, L.attackOrigin(p), L.attackRules());
    for (const b of icons.big) this.put(items, Z.ui, this.frame('S5', 'attack_icon_big'), b.x, b.y);
    for (const s of icons.small) this.put(items, Z.ui, this.frame('S5', 'attack_icon_small'), s.x, s.y);
    // 役名・発光
    const d = this.pv[p].declare;
    if (d && t < d.end) {
      const r = L.pRect(p, 'role_logo');
      const seg = (d.end - d.start) / d.logos.length;
      const logo = d.logos[Math.min(d.logos.length - 1, Math.floor((t - d.start) / seg))];
      const letter = (['A', 'B', 'C'] as const)[Math.floor((t - d.start) / this.vt.role) % 3];
      const ab = Math.floor((t - d.start) / (this.vt.role * 2)) % 2 === 0 ? 'a' : 'b';
      const back = this.frame('S6', `role_glow_${d.size}_back_${ab}`);
      const front = this.frame('S6', `role_glow_${d.size}_front_${ab}`);
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      this.put(items, Z.glowBack, back, cx - back.w / 2, cy - back.h / 2);
      this.put(items, Z.glowFront, front, cx - front.w / 2, cy - front.h / 2);
      this.put(items, Z.roleName, this.assets.atlas.role(logo, letter), r.x, r.y);
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
    if (t < g.playStartTick) anim = 'ready';
    else if (t < goEnd) anim = 'start';
    else if (PLAYERS.some((p) => g.players[p].overflowPending)) anim = 'panic';
    else if (PLAYERS.some((p) => this.pv[p].declare && t < this.pv[p].declare!.end)) anim = 'joy';
    this.put(items, Z.character, this.loop(A.animation('S3', anim), t, this.vt.idle), m.x, m.y);
    // READY / GO
    if (t < g.playStartTick) {
      const r = L.rect('ready_banner');
      this.put(items, Z.banner, this.frame('S5', 'banner_ready'), r.x, r.y);
    } else if (t < goEnd) {
      const r = L.rect('go_banner');
      this.put(items, Z.banner, this.frame('S5', 'banner_go'), r.x, r.y);
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
    for (const [id, tw] of this.localTweens) if (t >= tw.end) this.localTweens.delete(id);
    for (const p of PLAYERS) {
      const v = this.pv[p];
      v.barTweens = v.barTweens.filter((tw) => t < tw.end);
      v.notices = v.notices.filter((n) => t - n.start < 120);
      if (v.declare && t >= v.declare.end) v.declare = null;
    }
  }

  private drawHud(ctx: CanvasRenderingContext2D, t: number): void {
    ctx.save();
    ctx.font = '10px "Noto Sans CJK JP", "Yu Gothic", "Meiryo", sans-serif';
    ctx.textBaseline = 'top';
    const text = (s: string, x: number, y: number, color = '#ffffff') => {
      ctx.fillStyle = '#000000';
      ctx.fillText(s, x + 1, y + 1);
      ctx.fillStyle = color;
      ctx.fillText(s, x, y);
    };
    for (const p of PLAYERS) {
      const board = this.boards[p];
      const st = this.game.players[p];
      this.pv[p].notices.forEach((n, i) => text(n.text, board.x + 2, board.y + 2 + 12 * i, '#ffd060'));
      if (st.board.height() >= this.game.config.dangerHeight && Math.floor(t / 20) % 2 === 0)
        text('DANGER', board.x + board.w - 46, board.y + board.h - 14, '#ff6060');
      text(`ATK ${st.attackStock}`, p === 0 ? 2 : 598, 140, '#c0d8ff');
    }
    text('検証版：攻撃量・消去・勝敗は未確定のため未実装　F1/H:操作説明', 150, 4, '#9aa4c0');
    ctx.restore();
  }
}
