// 試合・セッションの進行（ロジック層）。
// 対戦（確定）：先取本数1/2/3（初期値2）。ラウンド間は 勝敗表示→決定入力→READY→GO。
// 引分けは勝利数を増やさず、同じラウンドを再試行。先取本数に達したら試合結果へ（再戦／メニューは画面側で選ぶ）。
// シングル：MODE1ひたすら／ステージクリア、MODE2シングル。ステージ間は得点・連続取得・役連鎖を引き継ぐ。
import { STAGE_COUNT } from './balance';
import { DEFAULT_CONFIG, NATURAL_RISE_MS, type Difficulty, type GameConfig } from './config';
import { Game, type Command, type SingleCarry, type SingleKind } from './game';
import { Mode2Game } from './mode2';
import type { PlayerId } from './types';

export type FirstTo = 1 | 2 | 3;
export type GameMode = 'mode1' | 'mode2';
export type AnyGame = Game | Mode2Game;

export interface MatchSettings {
  firstTo: FirstTo;
  difficulty: Difficulty;
  seed: number;
  /** 省略時 MODE1 */
  mode?: GameMode;
  /** テスト用の設定上書き（自然上昇の周期は difficulty から決める） */
  config?: Partial<GameConfig>;
  /** ラウンド開始ごとに READY の表示時間（ms）を決める（演出担当キャラの音声長に合わせる。ゲーム結果は変えない） */
  readyMsFor?: () => number;
}

export type MatchState = 'round' | 'roundResult' | 'matchResult';

/** 対戦（MODE1／MODE2共通の先取制） */
export class Match {
  readonly wins: [number, number] = [0, 0];
  /** 決着したラウンド数＋1（引分けの再試行では増えない） */
  round = 1;
  /** 同じラウンドの試行回数（引分けで増える） */
  attempt = 0;
  state: MatchState = 'round';
  game: AnyGame;
  /** 勝敗表示の開始tick（game.tick 基準） */
  resultTick = 0;
  /** 勝敗表示から決定入力を受け付けるまでの最短時間（誤入力防止の下限。演出側でさらに待つ） */
  resultMinMs = 800;
  readonly config: GameConfig;
  readonly mode: GameMode;
  /** ラウンドID（前ラウンドの演出・攻撃・音を隔離する） */
  roundId = 1;

  constructor(readonly settings: MatchSettings) {
    this.mode = settings.mode ?? 'mode1';
    this.config = {
      ...DEFAULT_CONFIG,
      naturalRiseIntervalMs: NATURAL_RISE_MS[settings.difficulty],
      ...settings.config,
      timing: { ...DEFAULT_CONFIG.timing, ...settings.config?.timing },
    };
    this.game = this.newGame();
  }

  private newGame(): AnyGame {
    if (this.settings.readyMsFor) this.config.timing.readyMs = this.settings.readyMsFor();
    const seed = (this.settings.seed * 31 + this.round * 1009 + this.attempt * 7919) >>> 0;
    return this.mode === 'mode2' ? new Mode2Game({ seed, config: this.config, players: 2 }) : new Game({ seed, config: this.config });
  }

  get matchWinner(): PlayerId | null {
    if (this.wins[0] >= this.settings.firstTo) return 0;
    if (this.wins[1] >= this.settings.firstTo) return 1;
    return null;
  }

  /** 決定入力を受け付けられるか（ラウンド結果のみ。試合結果の再戦・メニューは画面側） */
  get canConfirm(): boolean {
    return this.state === 'roundResult' && this.game.tick - this.resultTick >= this.game.ticks(this.resultMinMs);
  }

  /** 1tick進める。confirm は決定入力（ラウンド結果表示中のみ有効） */
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
    if (this.game.result?.winner === null) {
      this.attempt++;
    } else {
      this.round++;
      this.attempt = 0;
    }
    this.startRound();
  }

  /** 再戦：同じ設定で勝利数を0から */
  rematch(): void {
    this.wins[0] = this.wins[1] = 0;
    this.round = 1;
    this.attempt = 0;
    this.startRound();
  }

  private startRound(): void {
    this.state = 'round';
    this.roundId++;
    this.game = this.newGame();
  }
}

export type SingleMode = SingleKind | 'mode2';

export interface SingleSettings {
  mode: SingleMode;
  seed: number;
  config?: Partial<GameConfig>;
  /** ステージクリアの開始面（テスト用。開始面スキップのUIは提供しない） */
  startStage?: number;
  readyMsFor?: () => number;
}

export type SingleState = 'play' | 'result' | 'finished';

/** シングル（1人）のセッション */
export class SingleSession {
  game: AnyGame;
  stage: number;
  state: SingleState = 'play';
  resultTick = 0;
  resultMinMs = 800;
  roundId = 1;
  readonly config: GameConfig;

  constructor(readonly settings: SingleSettings) {
    // シングルの自然上昇周期はステージ／Lvの表から決まる（難易度設定は使わない）
    this.config = { ...DEFAULT_CONFIG, ...settings.config, timing: { ...DEFAULT_CONFIG.timing, ...settings.config?.timing } };
    this.stage = settings.startStage ?? 1;
    this.game = this.newGame();
  }

  private newGame(carry?: SingleCarry): AnyGame {
    if (this.settings.readyMsFor) this.config.timing.readyMs = this.settings.readyMsFor();
    const seed = (this.settings.seed * 31 + this.stage * 1013) >>> 0;
    if (this.settings.mode === 'mode2') return new Mode2Game({ seed, config: this.config, players: 1 });
    return new Game({ seed, config: this.config, single: { kind: this.settings.mode, stage: this.stage, carry } });
  }

  get mode(): SingleMode {
    return this.settings.mode;
  }

  get canConfirm(): boolean {
    return this.state === 'result' && this.game.tick - this.resultTick >= this.game.ticks(this.resultMinMs);
  }

  /** 次の面へ進める結果か（ステージクリアで最終面以外） */
  get hasNext(): boolean {
    return this.game.result?.outcome === 'stageClear' && this.stage < STAGE_COUNT;
  }

  step(commands: readonly Command[], confirm = false): void {
    if (this.state === 'play') {
      this.game.step(commands);
      if (this.game.result) {
        this.state = 'result';
        this.resultTick = this.game.tick;
      }
      return;
    }
    this.game.step([]);
    if (this.state !== 'result' || !confirm || !this.canConfirm) return;
    if (this.hasNext && this.game instanceof Game && this.game.single) {
      // 次面：得点・連続取得数・役連鎖数を引継ぎ、受付残時間は最大へ戻す。盤面・ストック・危険・自然上昇は初期化
      const p = this.game.players[0];
      // クリア確定時点で有効な状態を引き継ぐ（受付時間が切れていた状態は復活させない）
      const carry: SingleCarry = {
        score: this.game.single.score,
        streakCount: this.game.streakActive(p) ? p.streakCount : 0,
        streakCutReserved: this.game.streakActive(p) && p.streakCutReserved,
        chainCount: p.chainRemaining > 0 ? p.chainCount : 0,
      };
      this.stage++;
      this.roundId++;
      this.game = this.newGame(carry);
      this.state = 'play';
      return;
    }
    this.state = 'finished';
  }

  /** やり直し（同じモードを最初から） */
  restart(): void {
    this.stage = this.settings.startStage ?? 1;
    this.roundId++;
    this.game = this.newGame();
    this.state = 'play';
  }
}
