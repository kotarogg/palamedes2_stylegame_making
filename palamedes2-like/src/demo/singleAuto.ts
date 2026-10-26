// 放置デモ「MODE1 SINGLE ひたすら」の自動操作（設計書 第7節）。既存の対戦CPUとは別。
// 見た目の速度・ルールは変えず、本編と同じ入力（Command）だけを出す。判断に使うのは見える情報（場・自分の盤面・手役）。
// 判断待ち：通常 600/1000/1400ms を 30/45/25%、ピンチ中 300/500/800ms を 40/40/20%。新しい判断の開始時だけ抽選する。
// 成立済みの4個役は基本宣言（最適な6個役までは追わない）。取得できる候補と役を優先し、連続出しが切れることやミスは許容する。
// 最大高さ2〜4を目標に、足りなければ手動上昇（目標は絶対保証ではない）。補充中も現在の高さで再評価し、5段以上へ上げない。
import type { Command, Game } from '../core/game';
import type { AnyGame } from '../core/match';
import { isLaunchSuccess } from '../core/pieces';
import { createSeededRng, type Rng } from '../core/rng';
import { evaluateStock } from '../core/roles';
import { pushRoleStock } from '../core/stock';
import type { Piece, PlayerId } from '../core/types';
import type { Controller } from '../input/controller';

export const SINGLE_AUTO = {
  wait: { ms: [600, 1000, 1400], pct: [30, 45, 25] },
  pinchWait: { ms: [300, 500, 800], pct: [40, 40, 20] },
  /** 最大高さの目標（下限未満で手動上昇。上限以上では手動上昇しない） */
  heightLow: 2,
  heightHigh: 4,
} as const;

export interface AutoDecisionLog {
  tick: number;
  waitMs: number;
  pinch: boolean;
  action: 'declare' | 'launch' | 'rise' | 'rotate' | 'none';
  col?: number;
}

/** 重み付き抽選（pct の合計100） */
export function pickWait(rng: Rng, t: { ms: readonly number[]; pct: readonly number[] }): number {
  const r = rng.next() * 100;
  let acc = 0;
  for (let i = 0; i < t.ms.length; i++) {
    acc += t.pct[i];
    if (r < acc) return t.ms[i];
  }
  return t.ms[t.ms.length - 1];
}

export class SingleAutoController implements Controller {
  readonly player: PlayerId = 0;
  private readonly rng: Rng;
  /** 判断待ちの終了tick（null＝次の判断をまだ始めていない） */
  private decideAt: number | null = null;
  private waitMs = 0;
  private pinchAtStart = false;
  /** 実行中の計画：目的の列と操作（移動は計画の一部で、判断待ちを挟まない） */
  private plan: { col: number; action: 'launch' | 'rotate' } | null = null;
  readonly log: AutoDecisionLog[] = [];

  constructor(seed: number) {
    this.rng = createSeededRng(seed >>> 0);
  }

  reset(): void {
    this.decideAt = null;
    this.plan = null;
  }

  poll(game: AnyGame): Command[] {
    if (game.mode !== 'mode1') return [];
    const g = game as Game;
    const p = g.players[0];
    const next = g.tick + 1;
    if (!g.playing || p.defeated || g.isLocked(p) || g.isMoving(p)) return [];
    if (this.plan) return this.continuePlan(g);
    if (this.decideAt === null) {
      // 新しい判断の開始：ここでだけ待ち時間を抽選する
      this.pinchAtStart = p.pinchWarn.active;
      this.waitMs = pickWait(this.rng, this.pinchAtStart ? SINGLE_AUTO.pinchWait : SINGLE_AUTO.wait);
      this.decideAt = g.tick + g.ticks(this.waitMs);
      return [];
    }
    if (next < this.decideAt) return [];
    this.decideAt = null;
    return this.decide(g);
  }

  private record(g: Game, action: AutoDecisionLog['action'], col?: number): void {
    this.log.push({ tick: g.tick, waitMs: this.waitMs, pinch: this.pinchAtStart, action, col });
    if (this.log.length > 400) this.log.splice(0, this.log.length - 400);
  }

  private decide(g: Game): Command[] {
    const p = g.players[0];
    const height = p.board.height();
    // 1. 成立済みの役は宣言（4個役で宣言。6個役まで追わない）
    if (evaluateStock(p.roleStock).kind === 'ok') {
      this.record(g, 'declare');
      return [{ player: 0, type: 'declare' }];
    }
    // 2. 低すぎる（役消去直後の0/1段など）なら手動上昇で補充。現在の高さで毎回再評価し、5段以上へは上げない
    if (height < SINGLE_AUTO.heightLow && g.tick >= p.manualRiseEndTick) {
      this.record(g, 'rise');
      return [{ player: 0, type: 'manualRise' }];
    }
    // 3. 取得できる候補：役に近づく候補を優先、同点は近い列
    const cands = p.board.cols
      .map((c, col) => ({ col, top: c[0] }))
      .filter((x): x is { col: number; top: { kind: 'piece'; piece: Piece } } => !!x.top && x.top.kind === 'piece' && isLaunchSuccess(x.top.piece, g.base));
    if (cands.length) {
      const score = (pc: Piece) => {
        const st = pushRoleStock(p.roleStock, pc).stock;
        if (evaluateStock(st).kind === 'ok') return 100;
        return st.filter((s) => s.n === pc.n).length * 3 + st.filter((s) => s.suit === pc.suit).length;
      };
      cands.sort((a, b) => score(b.top.piece) - score(a.top.piece) || Math.abs(a.col - p.selectedCol) - Math.abs(b.col - p.selectedCol));
      this.plan = { col: cands[0].col, action: 'launch' };
      this.record(g, 'launch', cands[0].col);
      return this.continuePlan(g);
    }
    // 4. 候補なし：目標の上限未満なら手動上昇、それ以外は近い列を入れ替え（2個以上の列）
    if (height < SINGLE_AUTO.heightHigh && g.tick >= p.manualRiseEndTick) {
      this.record(g, 'rise');
      return [{ player: 0, type: 'manualRise' }];
    }
    const rot = p.board.cols
      .map((c, col) => ({ col, ok: c.length >= 2 && !p.board.hasReservation(col) }))
      .filter((x) => x.ok)
      .sort((a, b) => Math.abs(a.col - p.selectedCol) - Math.abs(b.col - p.selectedCol))[0];
    if (rot) {
      this.plan = { col: rot.col, action: 'rotate' };
      this.record(g, 'rotate', rot.col);
      return this.continuePlan(g);
    }
    this.record(g, 'none');
    return [];
  }

  /** 計画の続き：目的の列まで1歩ずつ移動し、着いたら操作。場が変わって取得できなくなったら計画を捨てて次の判断へ */
  private continuePlan(g: Game): Command[] {
    const p = g.players[0];
    const plan = this.plan!;
    if (p.selectedCol !== plan.col) return [{ player: 0, type: p.selectedCol < plan.col ? 'right' : 'left' }];
    this.plan = null;
    if (plan.action === 'launch') {
      const top = p.board.cols[plan.col][0];
      if (!top || top.kind !== 'piece' || !isLaunchSuccess(top.piece, g.base)) return [];
    }
    return [{ player: 0, type: plan.action }];
  }
}
