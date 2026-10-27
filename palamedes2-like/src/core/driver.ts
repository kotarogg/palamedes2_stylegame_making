// 可変フレーム時間から固定ステップでロジックを進める。描画側はalphaで補間するだけ。

/**
 * v3.2.0 r：このtickが表す実時刻（固定ステップと入力時刻の対応）。
 * at＝このtickの終わりに当たる実時刻（advance に nowMs を渡したときだけ。単位は performance.now と同じ ms）、
 * last＝このフレームで最後に進めるtick（フレームの時刻に観測した入力はここへ）
 */
export interface StepInfo {
  at: number | null;
  last: boolean;
}

export interface Steppable {
  readonly tickMs: number;
  step(info?: StepInfo): void;
}

export class FixedStepDriver {
  private acc = 0;
  /** 1フレームで進める最大tick（タブ復帰時の暴走防止） */
  maxStepsPerAdvance = 30;

  constructor(private readonly target: Steppable) {}

  /**
   * dtMs だけ時間を進め、実行したtick数を返す。nowMs（フレームの時刻）を渡すと、各tickが表す実時刻を StepInfo で渡す：
   * 追いつき処理で複数tickを進めるとき、各tickは「nowMs − そのtickを進めた後に残る蓄積」の時刻に当たる（tick間隔は tickMs）
   */
  advance(dtMs: number, nowMs?: number): number {
    this.acc += Math.max(0, dtMs);
    const tickMs = this.target.tickMs;
    const k = Math.min(this.maxStepsPerAdvance, Math.floor(this.acc / tickMs));
    let steps = 0;
    while (this.acc >= tickMs && steps < this.maxStepsPerAdvance) {
      this.acc -= tickMs;
      const at = nowMs === undefined ? null : nowMs - this.acc;
      this.target.step({ at, last: steps === k - 1 });
      steps++;
    }
    if (steps === this.maxStepsPerAdvance) this.acc = Math.min(this.acc, tickMs);
    return steps;
  }

  /** 次tickまでの進捗 [0,1) */
  get alpha(): number {
    return this.acc / this.target.tickMs;
  }
}
