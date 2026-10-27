// v3.2.0 MODE2 説明教材（指示書 第9節）：固定盤面・固定入力を通常の Mode2Game へ渡し、実イベントで説明を切り替える。
// CPU・固定尺のページ送りは使わない。game seed＝20261027（Mode2Game へ直接渡す）、初期の場だけ 3♠ に設定。
// 盤面は初回生成時だけ setup で与え（ピースIDは factory 経由）、途中で盤面を作り直さない。
// 説明を読ませる停止（2000ms）の間だけシミュレーションを止める。カウントダウン中は止めない（時計も進む）。
import type { Command } from '../core/game';
import { Mode2Game } from '../core/mode2';
import { pieceKind, type PageKey } from './lesson';

/** 初期盤面：上から下の7行、左から右の6列（S＝♠、D＝♦、C＝♣、H＝♥） */
export const MODE2_LESSON_ROWS = ['4H 1D 2C 1S 2D 1C', '1S 6H 6S 1H 1H 5H', '3D 2D 4C 5S 4H 2C', '6C 1C 5S 3D 5D 1S', '4H 5S 4C 4H 1C 3H', '2H 6D 3C 4H 5S 5S', '2H 5C 4D 3H 2S 5H'].map((r) =>
  r.split(' ').map((c) => `${c[0]}${c[1].toLowerCase()}`),
);

/** 取得順（列番号は1始まり）：最初の列1（4♥）＋場の更新後の41個 */
export const MODE2_LESSON_ORDER: readonly number[] = [1, ...'2,1,2,4,2,1,3,1,2,3,2,1,1,1,4,2,2,3,3,3,3,3,5,6,5,5,4,6,5,4,6,5,6,5,4,4,4,6,5,6,6'.split(',').map(Number)];

export const MODE2_LESSON = {
  seed: 20261027,
  base: '3s',
  /** 冒頭・更新後3取得の前に読ませる停止 */
  readMs: 2000,
  /** 各到達成功後の教材用の最低間隔（既存の上詰め硬直と重ねてよい） */
  gapTicks: 12,
  clearHoldMs: 3000,
  versusHoldMs: 3000,
} as const;

type Stage = 'intro' | 'first' | 'refresh' | 'explain' | 'rest' | 'clear' | 'versus' | 'done';

export class Mode2LessonRunner {
  readonly game: Mode2Game;
  page: PageKey = 'm2_intro';
  stage: Stage = 'intro';
  /** 取得順の次の位置 */
  next = 0;
  private pauseLeft = 0;
  private holdLeft = 0;
  private lastArrive = -9999;
  private cursor = 0;
  /** 更新後の説明付き取得の何番目か（0〜2） */
  private explained = 0;
  private waitingArrive = false;
  readonly problems: string[] = [];

  constructor(private readonly onPage: (p: PageKey) => void = () => undefined) {
    this.game = new Mode2Game({
      seed: MODE2_LESSON.seed,
      players: 1,
      setup: (g) => {
        const b = pieceKind(MODE2_LESSON.base);
        g.base = g.factory.make(b.n, b.suit);
        g.players[0].board.cols.forEach((col, c) => {
          col.length = 0;
          for (const row of MODE2_LESSON_ROWS) {
            const k = pieceKind(row[c]);
            col.push({ kind: 'piece', piece: g.factory.make(k.n, k.suit) });
          }
        });
      },
    });
    // READY／GO は出さず入力受付の開始から（その間ゲームは何も起きない）
    while (!this.game.playing) this.game.step();
    this.cursor = this.game.events.length;
    this.setPage('m2_intro');
    this.pauseLeft = this.game.ticks(MODE2_LESSON.readMs);
  }

  get done(): boolean {
    return this.stage === 'done';
  }

  get paused(): boolean {
    return this.pauseLeft > 0;
  }

  private setPage(p: PageKey): void {
    this.page = p;
    this.onPage(p);
  }

  /** 1tick 分。読ませる停止中はゲームを進めない。戻り値：ゲームを進めたか */
  tick(): boolean {
    if (this.done) return false;
    if (this.pauseLeft > 0) {
      this.pauseLeft--;
      if (this.pauseLeft === 0 && this.stage === 'intro') this.stage = 'first';
      return false;
    }
    const g = this.game;
    if (g.result) {
      // クリア後：結果を確認して3000ms→対戦の補足3000ms（ゲームは止まっているが時間は進める）
      this.scan();
      if (this.holdLeft > 0 && --this.holdLeft > 0) return false;
      if (this.stage === 'clear') {
        this.stage = 'versus';
        this.setPage('m2_versus');
        this.holdLeft = g.ticks(MODE2_LESSON.versusHoldMs);
      } else if (this.stage === 'versus') this.stage = 'done';
      return false;
    }
    g.step(this.commands());
    this.scan();
    this.settle();
    return true;
  }

  /** 実イベントへ同期して頁を切り替える */
  private scan(): void {
    const g = this.game;
    for (; this.cursor < g.events.length; this.cursor++) {
      const e = g.events[this.cursor];
      if (e.type === 'arrive') {
        this.waitingArrive = false;
        if (e.success) this.lastArrive = e.tick;
        else this.problems.push(`失敗：tick ${e.tick} 列${e.col + 1}`);
      } else if (e.type === 'stuck') {
        this.stage = 'refresh';
        this.setPage('m2_refresh');
      } else if (e.type === 'cardRefresh') {
        if (this.stage === 'refresh') this.beginExplain();
      } else if (e.type === 'roundEnd') {
        if (e.outcome === 'clear' && g.remaining(g.players[0]) === 0) {
          this.stage = 'clear';
          this.setPage('m2_clear');
          this.holdLeft = g.ticks(MODE2_LESSON.clearHoldMs);
        } else {
          this.problems.push(`想定外の終了：${e.outcome}`);
          this.stage = 'done';
        }
      }
    }
  }

  private beginExplain(): void {
    const pages: PageKey[] = ['m2_suit', 'm2_number', 'm2_adjacent'];
    if (this.explained < pages.length) {
      this.stage = 'explain';
      this.setPage(pages[this.explained++]);
      this.pauseLeft = this.game.ticks(MODE2_LESSON.readMs);
    } else {
      this.stage = 'rest';
      this.setPage('m2_rule');
    }
  }

  /** 次の取得：移動→発射。到達成功の後は最低 gapTicks あける（上詰め硬直と重ねてよい） */
  private commands(): Command[] {
    const g = this.game;
    const p = g.players[0];
    if (this.stage !== 'first' && this.stage !== 'explain' && this.stage !== 'rest') return [];
    if (this.waitingArrive || this.next >= MODE2_LESSON_ORDER.length) return [];
    if (g.phase !== 'play' || g.isLocked(p) || g.isMoving(p) || g.flights.some((f) => f.player === 0)) return [];
    if (g.tick + 1 < this.lastArrive + MODE2_LESSON.gapTicks) return [];
    const col = MODE2_LESSON_ORDER[this.next] - 1;
    if (p.selectedCol !== col) return [{ player: 0, type: p.selectedCol < col ? 'right' : 'left' }];
    this.next++;
    this.waitingArrive = true;
    // 更新後の説明付き取得（3つ）は1つずつ：発射後、到達したら次の説明へ
    if (this.stage === 'explain') this.afterArriveExplain = true;
    return [{ player: 0, type: 'launch' }];
  }

  private afterArriveExplain = false;

  /** 説明付き取得の到達後に次の説明へ（scan の後に呼ぶ） */
  settle(): void {
    if (this.afterArriveExplain && !this.waitingArrive && !this.paused) {
      this.afterArriveExplain = false;
      this.beginExplain();
    }
  }
}
