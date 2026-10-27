// CPU（v3.1.0：判断処理と設定値を分離）。確率・停止時間・判断余裕は src/data/cpu_config_v320.json（企画側が数値で調整）。
// v3.2.0：旧 idleStop を「判断時の停止」（時間候補3つ・ピンチ半分）へ置換、最適候補率・失念を更新、手役6個での7個目による改善を追加。
// 旧中級CPU（v3.1.0 の cpu_config_v310.json、コミット 0e914b6）は将来の「超級」基準として記録だけ残す（メニュー追加は範囲外）。
// 判断に使うのはプレイヤーに見える情報だけ：共通基準（場のカード）、自分の盤面・役ストック・待機攻撃・ピンチの残り猶予。
// 未来の生成ピース（乱数・生成器）や相手の入力は参照しない。盤面を直接書き換えず、既存の操作入力（Command）だけを出す。
// 行動の順序：実行可能性確認 → 成立役の宣言／追加取得の判断 → 目的地の選択 → 移動・打ち上げ → 結果を受けて再判断。
// 抽選は seed 付き乱数で判断機会ごとに1回（毎フレーム再抽選しない）。同じ seed・同じ入力なら同じ判断になる。
import type { Difficulty } from '../core/config';
import type { Command, Game, PlayerState } from '../core/game';
import type { AnyGame } from '../core/match';
import type { Mode2Game, Mode2Player } from '../core/mode2';
import { isLaunchSuccess } from '../core/pieces';
import { createSeededRng, randomInt, type Rng } from '../core/rng';
import { evaluateStock, evaluateSubset } from '../core/roles';
import type { Character } from '../audio/audioMap';
import type { Piece, PlayerId } from '../core/types';
import { pushRoleStock } from '../core/stock';
import rawConfig from '../data/cpu_config_v320.json';
import type { Controller } from './controller';
import { acquireMs, candidatesOf, depthFor, remainingAfter, shortestPaths, simCols, type Candidate, type Goal, type PlanTiming } from './cpuPlan';

type Situation = 'normal' | 'pinch';
type PerChar<T> = Record<Character, T>;
interface PctMs {
  pct: number;
  ms: number;
}

/** 判断時の停止：停止確率（キャラ別）と時間候補（短／標準／長。ピンチは通常の半分） */
interface DecisionStop {
  pct: PerChar<number>;
  normalMs: [number, number, number];
  pinchMs: [number, number, number];
}

/** CPU 設定（cpu_config_v320.json と同じ形）。確率は0〜100%、時間は ms */
export interface CpuConfig {
  version: string;
  /** 時間候補（短／標準／長）の選択確率 */
  decisionStopWeights: [number, number, number];
  decisionStop: Record<Difficulty, DecisionStop>;
  bestPick: Record<Difficulty, Record<Situation, PerChar<number>>>;
  forget: Record<Difficulty, Record<Situation, PerChar<PctMs>>>;
  sixChallenge: Record<Difficulty, Record<Situation, { hand3: PerChar<number>; hand4Role: PerChar<number>; hand5Role4: PerChar<number> }>>;
  declareFour: Record<Difficulty, Record<Situation, PerChar<number>>>;
  declareSix: Record<Difficulty, Record<Situation, PerChar<number>>>;
  /** 手役6個の7個目による改善（pinch＝見積り上の余裕がある場合） */
  seventhImprove: Record<Difficulty, Record<Situation, PerChar<number>>>;
  manualRise: Record<Difficulty, { rows0: PerChar<number>; rows1: PerChar<number>; rows2: PerChar<number> }>;
  pinchMarginMs: Record<Difficulty, number>;
  mode2BestPick: Record<Difficulty, PerChar<number>>;
  actionGapMs: number;
}

export const CPU_CONFIG = rawConfig as unknown as CpuConfig;

/** 1回の判断で行う抽選の記録（自動検証用） */
export interface CpuDecisionLog {
  tick: number;
  kind: 'decisionStop' | 'bestPick' | 'forget' | 'sixChallenge' | 'declareFour' | 'declareSix' | 'seventhImprove' | 'manualRise';
  pct: number;
  hit: boolean;
  detail?: string;
}

interface Plan {
  col: number;
  action: 'launch' | 'rotate';
  /** この移動計画で失念の抽選を済ませたか（同じ移動機会で再抽選しない） */
  forgetRolled: boolean;
  forget: PctMs | null;
  /** 移動を開始したか（完了済みの移動には失念を適用しない） */
  moved: boolean;
  /** 計画を立てたときの基準・盤面（場の変化で取得不能になったら再判断） */
  baseId: number;
}

/** 役の判断（同じ状態では再抽選しない） */
interface RoleDecision {
  key: string;
  declare: boolean;
  goal: Goal;
  /** 7個目による改善の取得先（列） */
  targetCol?: number;
}

/** 7個目による改善の挑戦（手役が変わる＝取得したら宣言。8個目へは連鎖しない） */
interface Seventh {
  /** 挑戦を決めたときの手役（変わったら取得済み） */
  stockKey: string;
  /** 現在の役の消去ライン数（合計翻数） */
  lines: number;
}

/** 計測用の件数（v3.2.0 第10章）。停止・失念は抽選対象・当選・実停止を分けて数える */
export interface CpuStats {
  stopRolls: number;
  stopHits: number;
  /** 判断停止の合計（tick、ピンチ移行の半減後） */
  stopTicks: number;
  /** 設定上の停止時間の合計（ms、半減前） */
  stopMs: number;
  stopHalved: number;
  forgetRolls: number;
  forgetHits: number;
  forgetStops: number;
  forgetTicks: number;
  seventhConsidered: number;
  /** ピンチで見積り上の余裕が無く、抽選せず宣言した */
  seventhNoMargin: number;
  seventhExecuted: number;
  seventhImproved: number;
  seventhAborted: number;
  seventhLost: number;
  /** 取得したが消去ライン数が増えなかった（場の変化等。宣言する） */
  seventhNoGain: number;
}

const emptyStats = (): CpuStats => ({
  stopRolls: 0,
  stopHits: 0,
  stopTicks: 0,
  stopMs: 0,
  stopHalved: 0,
  forgetRolls: 0,
  forgetHits: 0,
  forgetStops: 0,
  forgetTicks: 0,
  seventhConsidered: 0,
  seventhNoMargin: 0,
  seventhExecuted: 0,
  seventhImproved: 0,
  seventhAborted: 0,
  seventhLost: 0,
  seventhNoGain: 0,
});

const stockKeyOf = (stock: readonly Piece[]): string => stock.map((x) => x.id).join(',');

type AnyPlayer = PlayerState | Mode2Player;

export class CpuController implements Controller {
  private plan: Plan | null = null;
  private stopUntil = 0;
  /** 実行中の停止の種類と、判断停止を始めた時の状況（通常停止中のピンチ移行で残りを半分にする） */
  private stopKind: 'decision' | 'forget' | null = null;
  private stopSit: Situation = 'normal';
  /** この判断（取得目標・宣言か追加取得か）で停止の抽選を済ませたか。操作（打ち上げ・宣言・入替・上昇）を出したら次の判断へ */
  private stopRolled = false;
  /** 失念で止まった後の再判断：同じ移動機会なので失念を再抽選しない */
  private noForgetNext = false;
  private seventh: Seventh | null = null;
  private role: RoleDecision | null = null;
  /** 6ピース役への挑戦（同じ計画が有効な間は再抽選しない） */
  private sixCommitted = false;
  private riseDeclinedKey = '';
  private stuckKey = '';
  private nextActTick = 0;
  /** 直前に読んだゲーム。別のゲーム（新ラウンド・再戦・次の相手）を受けたら状態を初期化する（B1） */
  private game: AnyGame | null = null;
  private readonly rng: Rng;
  readonly log: CpuDecisionLog[] = [];
  readonly stats: CpuStats = emptyStats();

  constructor(
    readonly player: PlayerId,
    readonly level: Difficulty,
    seed = 1,
    readonly character: Character = 'kotaro',
    private readonly cfg: CpuConfig = CPU_CONFIG,
  ) {
    this.rng = createSeededRng((seed * 7919 + player * 104729) >>> 0);
  }

  /** 前ラウンドの状態・計画を新ゲームへ持ち越さない（B1） */
  reset(): void {
    this.plan = null;
    this.stopUntil = 0;
    this.stopKind = null;
    this.stopRolled = false;
    this.noForgetNext = false;
    this.seventh = null;
    this.role = null;
    this.sixCommitted = false;
    this.riseDeclinedKey = '';
    this.stuckKey = '';
    this.nextActTick = 0;
    this.game = null;
  }

  private roll(kind: CpuDecisionLog['kind'], pct: number, tick: number, detail?: string): boolean {
    // 0%・100% も乱数を1つ消費する（設定値を変えても以後の乱数列の位置がずれない）
    const hit = this.rng.next() * 100 < pct;
    this.log.push({ tick, kind, pct, hit, detail });
    if (this.log.length > 4000) this.log.splice(0, this.log.length - 4000);
    return hit;
  }

  private timing(game: AnyGame): PlanTiming {
    const t = game.config.timing;
    return { charMoveMs: t.charMoveMs, launchMs: t.launchMs, packMs: t.packMs };
  }

  poll(game: AnyGame): Command[] {
    if (game !== this.game) {
      this.reset();
      this.game = game;
    }
    const p = game.players[this.player];
    if (!p) return [];
    const tick = game.tick + 1; // 出した操作が適用される tick
    if (game.mode === 'mode1') {
      const q = p as PlayerState;
      if (q.defeated && this.seventh) {
        // 7個目の挑戦中に敗北（見積りは成功保証ではない）
        this.stats.seventhLost++;
        this.seventh = null;
      }
      // 通常の判断停止中にピンチへ移った：その時点の残り停止時間を半分に（引き直さない・1回だけ）
      if (this.stopKind === 'decision' && this.stopSit === 'normal' && tick < this.stopUntil && game.pinchRemainingTicks(q) !== null) {
        const rest = this.stopUntil - tick;
        const half = Math.round(rest / 2);
        this.stopUntil = tick + half;
        this.stopSit = 'pinch';
        this.stats.stopHalved++;
        this.stats.stopTicks -= rest - half;
      }
    }
    // 実行可能性確認：既存の入力可否（発射・上詰め・入替・不成立の硬直、役処理中、移動中）に従う
    if (!game.playing) return [];
    if (game.mode === 'mode1' && (p as PlayerState).defeated) return [];
    const locked = game.mode === 'mode1' ? game.isLocked(p as PlayerState) || game.isMoving(p as PlayerState) : game.isLocked(p as Mode2Player) || game.isMoving(p as Mode2Player);
    if (locked) return [];
    if (tick < this.stopUntil || tick < this.nextActTick) return [];
    this.stopKind = null;
    const out = game.mode === 'mode1' ? this.thinkMode1(game, p as PlayerState, tick) : this.thinkMode2(game, p as Mode2Player, tick);
    // 操作を出したら、この判断は終わり（次の判断の機会で停止を抽選する）
    if (out.some((a) => a !== 'left' && a !== 'right')) {
      this.stopRolled = false;
      this.noForgetNext = false;
    }
    if (out.length && this.cfg.actionGapMs > 0) this.nextActTick = tick + game.ticks(this.cfg.actionGapMs);
    return out.map((type) => ({ player: this.player, type }) as Command);
  }

  /** 判断時の停止：判断の機会につき1回抽選。当たれば時間候補（短／標準／長）を weights で選ぶ。戻り値：停止したか */
  private decisionStop(game: AnyGame, sit: Situation, tick: number): boolean {
    this.stopRolled = true;
    const s = this.cfg.decisionStop[this.level];
    this.stats.stopRolls++;
    if (!this.roll('decisionStop', s.pct[this.character], tick, sit)) return false;
    const w = this.cfg.decisionStopWeights;
    const r = this.rng.next() * (w[0] + w[1] + w[2]);
    const i = r < w[0] ? 0 : r < w[0] + w[1] ? 1 : 2;
    const ms = (sit === 'pinch' ? s.pinchMs : s.normalMs)[i];
    const ticks = game.ticks(ms);
    this.stats.stopHits++;
    this.stats.stopMs += ms;
    this.stats.stopTicks += ticks;
    this.log[this.log.length - 1].detail = `${sit} ${ms}ms`;
    this.stopUntil = tick + ticks;
    this.stopKind = 'decision';
    this.stopSit = sit;
    return true;
  }

  /** 判断停止の期待値（ms）：停止確率 × 時間候補の加重平均 */
  private expectedStopMs(sit: Situation): number {
    const s = this.cfg.decisionStop[this.level];
    const w = this.cfg.decisionStopWeights;
    const ms = sit === 'pinch' ? s.pinchMs : s.normalMs;
    const mean = (ms[0] * w[0] + ms[1] * w[1] + ms[2] * w[2]) / (w[0] + w[1] + w[2]);
    return (s.pct[this.character] / 100) * mean;
  }

  /**
   * ピンチの所要見積り（ms）：操作（移動・発射・上詰め）＋未消化の停止＋今後の判断（取得ごとに判断停止と失念の期待値）＋宣言受理（1tick）＋安全余裕。
   * 成立役の導入（約700ms）は猶予が止まるため加えない。これが有効な残り猶予未満なら時間内とする
   */
  private pinchNeedMs(game: AnyGame, opsMs: number, steps: number): number {
    const f = this.cfg.forget[this.level].pinch[this.character];
    const pending = Math.max(0, this.stopUntil - (game.tick + 1)) * game.tickMs;
    return opsMs + pending + steps * (this.expectedStopMs('pinch') + (f.pct / 100) * f.ms) + game.tickMs + this.cfg.pinchMarginMs[this.level];
  }

  // ---- MODE1 ----

  private situation(game: Game, p: PlayerState): Situation {
    return game.pinchRemainingTicks(p) !== null ? 'pinch' : 'normal';
  }

  /** ピンチの有効な残り猶予（ms）。ピンチでなければ null */
  private pinchMs(game: Game, p: PlayerState): number | null {
    const r = game.pinchRemainingTicks(p);
    return r === null ? null : r * game.tickMs;
  }

  private thinkMode1(game: Game, p: PlayerState, tick: number): Command['type'][] {
    const sit = this.situation(game, p);
    // 成立役の宣言／追加取得の判断：手元（役ストック）か通常／ピンチが変わったときだけ判断・抽選する。
    // 6ピース役へ挑戦中は経路の有効性を毎回確かめ、無くなったら（場・盤面・残り猶予の変化）判断し直す
    const key = `${sit}|${stockKeyOf(p.roleStock)}`;
    const lost = !!this.role && this.role.key === key && this.role.goal === 6 && this.sixPathMs(game, p, sit) === null;
    if (lost) this.sixCommitted = false;
    // 計画が取得不能になった（場・盤面の変化）：失念とは別に再判断（停止は引き直さない）
    if (this.plan && !this.planValid(game, p, this.plan)) {
      this.plan = null;
      this.noForgetNext = true;
    }
    const decide = !this.role || this.role.key !== key || lost;
    // 判断の機会（新たな取得目標／宣言か追加取得か）につき停止を1回。同じ判断で二重に入れない・失念の停止後は重ねない
    if ((decide || !this.plan) && !this.stopRolled && !this.noForgetNext && this.decisionStop(game, sit, tick)) return [];
    // 7個目の挑戦中に通常／ピンチだけが変わった（手役は同じ）：再抽選せず継続できるか再評価
    const seventhSame = !!this.seventh && this.seventh.stockKey === stockKeyOf(p.roleStock);
    if (decide && !seventhSame) this.role = this.decideRole(game, p, sit, key, tick);
    else if (seventhSame || this.role!.targetCol !== undefined) this.role = this.continueSeventh(game, p, sit, key);
    const role = this.role!;
    if (role.declare) {
      this.plan = null;
      this.role = null;
      this.sixCommitted = false;
      return ['declare'];
    }
    if (role.targetCol !== undefined && this.plan && this.plan.col !== role.targetCol) {
      this.plan = null;
      this.noForgetNext = true;
    }
    return this.destination(game, p, sit, tick);
  }

  private boardKey(p: AnyPlayer): string {
    return p.board.cols.map((c) => c.map((s) => (s.kind === 'piece' ? s.piece.id : `r${s.pieceId}`)).join('.')).join('/');
  }

  /** 6ピース役への経路（ピンチでは期限内の経路だけ）。最短の所要時間（ms）、無ければ null */
  private sixPathMs(game: Game, p: PlayerState, sit: Situation): number | null {
    const hand = p.roleStock.length;
    if (hand < 3 || hand > 5) return null;
    const paths = shortestPaths(simCols(p.board), game.base, p.roleStock, p.selectedCol, 6, depthFor(6, hand), this.timing(game));
    let best: number | null = null;
    for (const r of paths.values()) if (best === null || r.ms < best) best = r.ms;
    if (best === null) return null;
    if (sit === 'pinch') {
      const rest = this.pinchMs(game, p)!;
      let ok: number | null = null;
      for (const r of paths.values()) if (this.pinchNeedMs(game, r.ms, r.steps) < rest && (ok === null || r.ms < ok)) ok = r.ms;
      return ok;
    }
    return best;
  }

  private decideRole(game: Game, p: PlayerState, sit: Situation, key: string, tick: number): RoleDecision {
    const hand = p.roleStock.length;
    const ev = evaluateStock(p.roleStock);
    const c = this.character;
    const lv = this.level;
    const six = this.cfg.sixChallenge[lv][sit];
    if (this.seventh) {
      // 7個目の挑戦で手役が変わった（取得した）：改善したら宣言。8個目以降の改善は追わない
      const done = this.seventh;
      this.seventh = null;
      if (ev.kind === 'ok') {
        if (ev.result.han > done.lines) this.stats.seventhImproved++;
        else this.stats.seventhNoGain++;
        return { key, declare: true, goal: 'any' };
      }
      this.stats.seventhNoGain++;
    }
    if (ev.kind === 'ok') {
      const isSix = ev.result.size === 6;
      // 手役6個：7個目による改善の判断を先に通し、追加取得を選ばなければ宣言
      if (hand >= 6) {
        const col = this.startSeventh(game, p, sit, tick, ev.result.han);
        if (col !== null) return { key, declare: false, goal: 'any', targetCol: col };
        if (!isSix) return { key, declare: true, goal: 'any' };
      }
      if (isSix) {
        const pct = this.cfg.declareSix[lv][sit][c];
        return { key, declare: this.roll('declareSix', pct, tick), goal: 'any' };
      }
      const sixMs = this.sixPathMs(game, p, sit);
      if (sixMs !== null) {
        // 既に挑戦中で経路が有効なら抽選し直さない
        if (this.sixCommitted) return { key, declare: false, goal: 6 };
        const pct = hand === 4 ? six.hand4Role[c] : six.hand5Role4[c];
        if (this.roll('sixChallenge', pct, tick, `hand${hand}`)) {
          this.sixCommitted = true;
          return { key, declare: false, goal: 6 };
        }
        this.sixCommitted = false;
        return { key, declare: true, goal: 'any' };
      }
      this.sixCommitted = false;
      // 6ピース役への経路なし（ピンチでは期限内の経路なし）：通常は宣言率で抽選、手元5・ピンチは宣言
      if (sit === 'pinch' || hand >= 5) return { key, declare: true, goal: 'any' };
      const pct = this.cfg.declareFour[lv][sit][c];
      if (this.roll('declareFour', pct, tick, `hand${hand}`)) return { key, declare: true, goal: 'any' };
      // 宣言しない：役を維持できる1ピース取得へ進み、取得後に再評価
      return { key, declare: false, goal: 4 };
    }
    // 役が未成立
    if (hand === 3) {
      if (this.sixCommitted && this.sixPathMs(game, p, sit) !== null) return { key, declare: false, goal: 6 };
      this.sixCommitted = false;
      if (this.sixPathMs(game, p, sit) !== null && this.roll('sixChallenge', six.hand3[c], tick, 'hand3')) {
        this.sixCommitted = true;
        return { key, declare: false, goal: 6 };
      }
      return { key, declare: false, goal: sit === 'pinch' ? 'any' : 4 };
    }
    if (this.sixCommitted && hand < 6 && this.sixPathMs(game, p, sit) !== null) return { key, declare: false, goal: 6 };
    this.sixCommitted = false;
    return { key, declare: false, goal: 'any' };
  }

  /**
   * 7個目による改善候補：出せる各列の最上段を、最古の1個を押し出した手役（共通の役判定）へ加え、消去ライン数（合計翻数）が厳密に増えるもの。
   * 増加ライン数の多い順、同点は所要時間の短い順。ピンチでは見積りが残り猶予に収まるものだけ
   */
  private seventhCandidates(game: Game, p: PlayerState, sit: Situation, lines: number): { col: number; gain: number; ms: number }[] | 'noMargin' {
    const t = this.timing(game);
    const out: { col: number; gain: number; ms: number }[] = [];
    for (const c of candidatesOf(simCols(p.board), game.base)) {
      const ev = evaluateStock(pushRoleStock(p.roleStock, c.piece).stock);
      if (ev.kind !== 'ok' || ev.result.han <= lines) continue;
      out.push({ col: c.col, gain: ev.result.han - lines, ms: acquireMs(p.selectedCol, c.col, t) });
    }
    if (out.length === 0) return out;
    if (sit === 'pinch') {
      const rest = this.pinchMs(game, p)!;
      const inTime = out.filter((x) => this.pinchNeedMs(game, x.ms, 1) < rest);
      if (inTime.length === 0) return 'noMargin';
      return inTime.sort((a, b) => b.gain - a.gain || a.ms - b.ms);
    }
    return out.sort((a, b) => b.gain - a.gain || a.ms - b.ms);
  }

  /** 最良の改善候補（同点は seed 付き抽選） */
  private pickSeventh(cands: { col: number; gain: number; ms: number }[]): number {
    const top = cands.filter((x) => x.gain === cands[0].gain && x.ms === cands[0].ms);
    return top[top.length === 1 ? 0 : randomInt(this.rng, top.length)].col;
  }

  /** 手役6個の改善判断。改善候補があれば（ピンチは余裕がある場合だけ）抽選し、当たれば取得先の列。外れ・候補なしは null（宣言） */
  private startSeventh(game: Game, p: PlayerState, sit: Situation, tick: number, lines: number): number | null {
    const cands = this.seventhCandidates(game, p, sit, lines);
    if (cands === 'noMargin') {
      this.stats.seventhConsidered++;
      this.stats.seventhNoMargin++;
      return null;
    }
    if (cands.length === 0) return null;
    this.stats.seventhConsidered++;
    const pct = this.cfg.seventhImprove[this.level][sit][this.character];
    if (!this.roll('seventhImprove', pct, tick, `${sit} +${cands[0].gain}`)) return null;
    this.stats.seventhExecuted++;
    this.seventh = { stockKey: stockKeyOf(p.roleStock), lines };
    return this.pickSeventh(cands);
  }

  /** 挑戦中：場・盤面・残り猶予が変わったら継続できるか再評価（再抽選しない）。続けられなければ中止して宣言 */
  private continueSeventh(game: Game, p: PlayerState, sit: Situation, key: string): RoleDecision {
    const s = this.seventh;
    const cands = s ? this.seventhCandidates(game, p, sit, s.lines) : [];
    if (!s || cands === 'noMargin' || cands.length === 0) {
      if (s) this.stats.seventhAborted++;
      this.seventh = null;
      return { key, declare: true, goal: 'any' };
    }
    const cur = this.role?.targetCol;
    const keep = cands.find((x) => x.col === cur && x.gain === cands[0].gain);
    return { key, declare: false, goal: 'any', targetCol: keep ? keep.col : this.pickSeventh(cands) };
  }

  private destination(game: Game, p: PlayerState, sit: Situation, tick: number): Command['type'][] {
    const goal = this.role?.goal ?? 'any';
    const target = this.role?.targetCol;
    if (!this.plan) {
      // 判断停止は thinkMode1 で判断の機会につき1回済ませている（停止後は最新の状態で判断する）
      // 7個目による改善：取得先は改善候補の順位で決まっている（最適候補率の抽選はしない）
      if (target !== undefined) this.plan = { col: target, action: 'launch', forgetRolled: this.noForgetNext, forget: null, moved: false, baseId: game.base.id };
      else {
        // 手動上昇（成立役の宣言と、既に選んだ取得目標＝6ピース役への挑戦を優先。見送ったら次の取得・盤面変化まで再抽選しない）
        const rise = goal !== 6 && this.riseDecision(game, p, tick);
        if (rise) return ['manualRise'];
        const plan = this.choose(game, p, sit, goal, tick);
        if (!plan) return this.recover(game, p); // 停止の抽選は済ませたまま（候補が出るまで毎回は抽選しない）
        plan.forgetRolled = this.noForgetNext;
        this.plan = plan;
      }
      this.noForgetNext = false;
    }
    return this.execute(game, p, sit, tick);
  }

  /** 移動・打ち上げ。移動計画につき1回だけ失念を抽選し、移動開始後の最初の判断時点で適用する */
  private execute(game: AnyGame, p: AnyPlayer, sit: Situation, tick: number): Command['type'][] {
    const plan = this.plan!;
    if (plan.col === p.selectedCol) {
      this.plan = null;
      return [plan.action];
    }
    if (!plan.forgetRolled) {
      plan.forgetRolled = true;
      const f = this.cfg.forget[this.level][sit][this.character];
      this.stats.forgetRolls++;
      plan.forget = this.roll('forget', f.pct, tick, `${sit} ${Math.abs(plan.col - p.selectedCol)}col`) && f.ms > 0 ? f : null;
      if (plan.forget) this.stats.forgetHits++;
    }
    if (plan.moved && plan.forget) {
      // 失念：止まってから再判断（同じ移動機会では再失念しない・判断停止を重ねない）。隣接移動は実停止の機会がない
      const ticks = game.ticks(plan.forget.ms);
      this.plan = null;
      this.noForgetNext = true;
      this.stopUntil = tick + ticks;
      this.stopKind = 'forget';
      this.stats.forgetStops++;
      this.stats.forgetTicks += ticks;
      return [];
    }
    plan.moved = true;
    return [plan.col < p.selectedCol ? 'left' : 'right'];
  }

  private planValid(game: AnyGame, p: AnyPlayer, plan: Plan): boolean {
    const top = p.board.top(plan.col);
    if (!top || top.kind !== 'piece') return false;
    if (plan.action === 'rotate') return p.board.cols[plan.col].length >= 2;
    return isLaunchSuccess(top.piece, game.base);
  }

  private riseDecision(game: Game, p: PlayerState, tick: number): boolean {
    const rows = p.board.height();
    if (rows > 2) return false;
    if (rows + 1 > game.config.manualRiseMaxHeight || game.tick < p.manualRiseEndTick) return false;
    const key = `${this.boardKey(p)}|${p.roleStock.length}`;
    if (key === this.riseDeclinedKey) return false;
    const pct = this.cfg.manualRise[this.level][(['rows0', 'rows1', 'rows2'] as const)[rows]][this.character];
    if (this.roll('manualRise', pct, tick, `rows${rows}`)) return true;
    this.riseDeclinedKey = key;
    return false;
  }

  /** 目的地の選択：現在の目標に対して最適な候補を bestPick% で、外れは取得可能な候補からランダム */
  private choose(game: Game, p: PlayerState, sit: Situation, goal: Goal, tick: number): Plan | null {
    const cols = simCols(p.board);
    let cands = candidatesOf(cols, game.base);
    const t = this.timing(game);
    if (sit === 'pinch') {
      // ピンチでは明らかに期限を超える候補（取得だけで残り猶予を超える）を除外
      const rest = this.pinchMs(game, p)!;
      const inTime = cands.filter((c) => acquireMs(p.selectedCol, c.col, t) < rest);
      if (inTime.length) cands = inTime;
    }
    if (cands.length === 0) return null;
    const pick = (c: Candidate): Plan => ({ col: c.col, action: 'launch', forgetRolled: false, forget: null, moved: false, baseId: game.base.id });
    if (cands.length === 1) return pick(cands[0]);
    const best = this.bestCandidates(game, p, cands, goal, sit);
    const pct = this.cfg.bestPick[this.level][sit][this.character];
    if (this.roll('bestPick', pct, tick, `${best.length}/${cands.length}`)) return pick(best[best.length === 1 ? 0 : randomInt(this.rng, best.length)]);
    return pick(cands[randomInt(this.rng, cands.length)]);
  }

  /** 目標に対して最適な候補（同評価が複数なら全部。呼出し側で seed 付き抽選） */
  private bestCandidates(game: Game, p: PlayerState, cands: Candidate[], goal: Goal, sit: Situation): Candidate[] {
    const hand = p.roleStock.length;
    const t = this.timing(game);
    let score: (c: Candidate) => number;
    if (goal === 4 && evaluateStock(p.roleStock).kind === 'ok') {
      // 役を維持できる取得（4ピース役成立・宣言を見送り）：取得後も役が成立し、その翻数が高いもの。同点は近いもの
      score = (c) => {
        const ev = evaluateStock([...p.roleStock, c.piece].slice(-6));
        return ev.kind === 'ok' ? ev.result.han * 1e6 - acquireMs(p.selectedCol, c.col, t) : -1e9;
      };
    } else {
      const paths = shortestPaths(simCols(p.board), game.base, p.roleStock, p.selectedCol, goal, depthFor(goal, hand), t);
      const rest = sit === 'pinch' ? this.pinchMs(game, p)! : Infinity;
      score = (c) => {
        const r = paths.get(c.col);
        if (r) return sit !== 'pinch' || this.pinchNeedMs(game, r.ms, r.steps) < rest ? 1e7 - r.ms : 1e6 - r.ms;
        // 見える範囲で目標へ届かない候補：取得後の手元で6個全体が役になる見込み（6ピース目標）か、近さ
        return -acquireMs(p.selectedCol, c.col, t);
      };
    }
    let top = -Infinity;
    let out: Candidate[] = [];
    for (const c of cands) {
      const s = score(c);
      if (s > top) {
        top = s;
        out = [c];
      } else if (s === top) out.push(c);
    }
    return out;
  }

  /** 候補が無いとき：既存の合法な打開操作（2段目が当たる列のB入替 → 3段以上の列のB入替 → 手動上昇）。無ければ盤面の変化を待つ */
  private recover(game: Game, p: PlayerState): Command['type'][] {
    const key = `${this.boardKey(p)}|${game.base.id}`;
    const cols = [0, 1, 2, 3, 4, 5].filter((c) => {
      const top = p.board.top(c);
      return !!top && top.kind === 'piece' && !p.board.hasReservation(c);
    });
    const near = (a: number, b: number) => Math.abs(a - p.selectedCol) - Math.abs(b - p.selectedCol);
    const second = cols
      .filter((c) => {
        const s = p.board.cols[c][1];
        return s && s.kind === 'piece' && isLaunchSuccess(s.piece, game.base);
      })
      .sort(near);
    const deep = cols.filter((c) => p.board.cols[c].length >= 3).sort(near);
    const col = second[0] ?? (key !== this.stuckKey ? deep[0] : undefined);
    if (col !== undefined) {
      this.stuckKey = key;
      this.plan = { col, action: 'rotate', forgetRolled: true, forget: null, moved: false, baseId: game.base.id };
      return this.execute(game, p, 'normal', game.tick + 1);
    }
    if (p.board.height() + 1 <= game.config.manualRiseMaxHeight && game.tick >= p.manualRiseEndTick) return ['manualRise'];
    return [];
  }

  // ---- MODE2：役・宣言・手動上昇・攻撃の判断はしない ----

  private thinkMode2(game: Mode2Game, p: Mode2Player, tick: number): Command['type'][] {
    if (this.plan && !this.planValid(game, p, this.plan)) {
      // 場の変化で目的地が出せなくなった：失念とは別に再判断（失念は再抽選しない）
      this.plan = null;
      this.noForgetNext = true;
    }
    if (!this.plan) {
      const cands = candidatesOf(simCols(p.board), game.base);
      if (cands.length === 0) return []; // 出せる列が無い：既存のカウントダウン・飛行・帰還待ちの条件に任せる
      // 新たな取得目標を決める機会につき判断停止を1回（MODE2 は通常の表。失念の停止後は重ねない）
      if (!this.stopRolled && !this.noForgetNext && this.decisionStop(game, 'normal', tick)) return [];
      const t = this.timing(game);
      const cols = simCols(p.board);
      // 最適：①移動と打ち上げを終えるまでが短い ②取得後にも出せる候補が多い ③同評価は seed 付き抽選
      const ranked = cands.map((c) => ({ c, ms: acquireMs(p.selectedCol, c.col, t), left: remainingAfter(cols, c) }));
      const minMs = Math.min(...ranked.map((r) => r.ms));
      const fast = ranked.filter((r) => r.ms === minMs);
      const maxLeft = Math.max(...fast.map((r) => r.left));
      const best = fast.filter((r) => r.left === maxLeft).map((r) => r.c);
      const pct = this.cfg.mode2BestPick[this.level][this.character];
      const c = cands.length === 1 ? cands[0] : this.roll('bestPick', pct, tick, `${best.length}/${cands.length}`) ? best[best.length === 1 ? 0 : randomInt(this.rng, best.length)] : cands[randomInt(this.rng, cands.length)];
      this.plan = { col: c.col, action: 'launch', forgetRolled: this.noForgetNext, forget: null, moved: false, baseId: game.base.id };
      this.noForgetNext = false;
    }
    return this.execute(game, p, 'normal', tick);
  }
}

/** 6ピース役の判定（テスト・検証用） */
export const isSixRole = (stock: readonly Piece[]): boolean => stock.length === 6 && evaluateSubset([...stock], [0, 1, 2, 3, 4, 5]).han > 0;
