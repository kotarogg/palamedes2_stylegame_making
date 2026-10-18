// 試合進行（確定）：先取本数1/2/3（初期値2）。ラウンド間は 勝敗表示→決定入力→READY→GO。
// 引分けは勝利数を増やさず、同じラウンドを再試行。先取本数に達したら試合結果へ。
import { DEFAULT_CONFIG, NATURAL_RISE_MS, type Difficulty, type GameConfig } from './config';
import { Game, type Command } from './game';
import type { PlayerId } from './types';

export type FirstTo = 1 | 2 | 3;

export interface MatchSettings {
  firstTo: FirstTo;
  difficulty: Difficulty;
  seed: number;
  /** テスト用の設定上書き（自然上昇の周期は difficulty から決める） */
  config?: Partial<GameConfig>;
}

export type MatchState = 'round' | 'roundResult' | 'matchResult';

export class Match {
  readonly wins: [number, number] = [0, 0];
  /** 決着したラウンド数＋1（引分けの再試行では増えない） */
  round = 1;
  /** 同じラウンドの試行回数（引分けで増える） */
  attempt = 0;
  state: MatchState = 'round';
  game: Game;
  /** 勝敗表示の開始tick（game.tick 基準） */
  resultTick = 0;
  /** 勝敗表示から決定入力を受け付けるまでの最短時間（誤入力防止。テスト用初期値） */
  readonly resultMinMs = 800;
  readonly config: GameConfig;

  constructor(readonly settings: MatchSettings) {
    this.config = { ...DEFAULT_CONFIG, naturalRiseIntervalMs: NATURAL_RISE_MS[settings.difficulty], ...settings.config };
    this.game = this.newGame();
  }

  private newGame(): Game {
    const seed = (this.settings.seed * 31 + this.round * 1009 + this.attempt * 7919) >>> 0;
    return new Game({ seed, config: this.config });
  }

  get matchWinner(): PlayerId | null {
    if (this.wins[0] >= this.settings.firstTo) return 0;
    if (this.wins[1] >= this.settings.firstTo) return 1;
    return null;
  }

  /** 決定入力を受け付けられるか */
  get canConfirm(): boolean {
    return this.state !== 'round' && this.game.tick - this.resultTick >= this.game.ticks(this.resultMinMs);
  }

  /** 1tick進める。confirm は決定入力（勝敗表示中のみ有効） */
  step(commands: readonly Command[], confirm = false): void {
    if (this.state === 'round') {
      this.game.step(commands);
      const r = this.game.result;
      if (r) {
        if (r.winner !== null) this.wins[r.winner]++;
        this.state = this.matchWinner !== null ? 'matchResult' : 'roundResult';
        this.resultTick = this.game.tick;
      }
      return;
    }
    this.game.step([]); // 表示用に時間だけ進める
    if (!confirm || !this.canConfirm) return;
    if (this.state === 'matchResult') {
      this.wins[0] = this.wins[1] = 0;
      this.round = 1;
      this.attempt = 0;
    } else if (this.game.result?.winner === null) {
      this.attempt++;
    } else {
      this.round++;
      this.attempt = 0;
    }
    this.state = 'round';
    this.game = this.newGame();
  }
}
