// v3.2.0 MODE2 説明教材（指示書 第9節）：固定盤面・固定入力を通常の Mode2Game へ渡し、実イベントで説明を切り替える。
// CPU・固定尺のページ送りは使わない。game seed＝20261027（Mode2Game へ直接渡す）、初期の場だけ 3♠ に設定。
// 盤面は初回生成時だけ setup で与え（ピースIDは factory 経由）、途中で盤面を作り直さない。
// V320-FIX-04：説明は読書区間（ゲーム停止）として、詰まり前・場の更新の完了後・クリア後の安定状態に置く。
// カウントダウン（3/2/1）・場の更新の演出中は止めない。複数の説明は順に読む（即置換しない）。
import type { Command } from '../core/game';
import { Mode2Game } from '../core/mode2';
import { pieceKind, ReadingState, type PageKey } from './lesson';

/** 初期盤面：上から下の7行、左から右の6列（S＝♠、D＝♦、C＝♣、H＝♥） */
export const MODE2_LESSON_ROWS = ['4H 1D 2C 1S 2D 1C', '1S 6H 6S 1H 1H 5H', '3D 2D 4C 5S 4H 2C', '6C 1C 5S 3D 5D 1S', '4H 5S 4C 4H 1C 3H', '2H 6D 3C 4H 5S 5S', '2H 5C 4D 3H 2S 5H'].map((r) =>
  r.split(' ').map((c) => `${c[0]}${c[1].toLowerCase()}`),
);

/** 取得順（列番号は1始まり）：最初の列1（4♥）＋場の更新後の41個 */
export const MODE2_LESSON_ORDER: readonly number[] = [1, ...'2,1,2,4,2,1,3,1,2,3,2,1,1,1,4,2,2,3,3,3,3,3,5,6,5,5,4,6,5,4,6,5,6,5,4,4,4,6,5,6,6'.split(',').map(Number)];

export const MODE2_LESSON = {
  seed: 20261027,
  base: '3s',
  /** 各到達成功後の教材用の最低間隔（既存の上詰め硬直と重ねてよい） */
  gapTicks: 12,
} as const;

type Stage = 'intro' | 'first' | 'refresh' | 'explain' | 'rest' | 'clear' | 'done';

export class Mode2LessonRunner {
  readonly game: Mode2Game;
  page: PageKey = 'm2_intro';
  stage: Stage = 'intro';
  /** 取得順の次の位置 */
  next = 0;
  private lastArrive = -9999;
  private cursor = 0;
  /** 更新後の説明付き取得の何番目か（0〜2） */
  private explained = 0;
  private waitingArrive = false;
  /** 読む順番を待つ説明（頁・読み終えた後の行き先） */
  private readonly queue: { page: PageKey; after: 'demo' | 'next' }[] = [];
  readonly reading = new ReadingState();
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
    // 冒頭：選び方と、詰まった時の場の更新を先に読む（カウントダウン中には読ませない）
    this.enqueue('m2_intro', 'next');
    this.enqueue('m2_refresh', 'demo');
    this.pump();
  }

  get done(): boolean {
    return this.stage === 'done';
  }

  /** 読書中（ゲームは止まっている） */
  get paused(): boolean {
    return this.reading.current !== null;
  }

  private enqueue(page: PageKey, after: 'demo' | 'next'): void {
    this.queue.push({ page, after });
  }

  /** 安定状態なら、待っている説明を読み始める */
  private pump(): void {
    if (this.reading.current || !this.queue.length || !this.stable()) return;
    const q = this.queue.shift()!;
    this.page = q.page;
    this.onPage(q.page);
    this.reading.start(q.page, q.after);
  }

  /** 読書区間を置ける：プレイ中（カウントダウン・場の更新の演出中でない）か結果確定後で、飛行・移動・硬直がない */
  private stable(): boolean {
    const g = this.game;
    if (g.result) return true;
    const p = g.players[0];
    return g.phase === 'play' && !g.flights.some((f) => f.player === 0) && !g.isMoving(p) && !g.isLocked(p);
  }

  /** 読み終えた：次のパネル、次の説明、または実演へ */
  releaseReading(): void {
    if (this.reading.release()) return;
    if (this.stage === 'intro') this.stage = 'first';
    if (this.stage === 'clear' && !this.queue.length) this.stage = 'done';
    this.pump();
  }

  /** 1tick 分。読書中・読む順番待ちの説明がある間はゲームを進めない。戻り値：ゲームを進めたか */
  tick(): boolean {
    if (this.done) return false;
    this.pump();
    if (this.paused) return false;
    const g = this.game;
    if (g.result) {
      this.scan();
      this.pump();
      return false;
    }
    // 説明が順番待ち（安定状態を待つ）：操作は出さずにゲームだけ進める
    g.step(this.queue.length ? [] : this.commands());
    this.scan();
    this.settle();
    this.pump();
    return true;
  }

  /** 実イベントへ同期して説明を予約する */
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
      } else if (e.type === 'cardRefresh') {
        if (this.stage === 'refresh') this.beginExplain();
      } else if (e.type === 'roundEnd') {
        if (e.outcome === 'clear' && g.remaining(g.players[0]) === 0) {
          this.stage = 'clear';
          this.enqueue('m2_clear', 'next');
          this.enqueue('m2_versus', 'next');
          this.enqueue('m2_versus_refresh', 'next');
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
      this.enqueue(pages[this.explained++], 'demo');
    } else {
      this.stage = 'rest';
      this.enqueue('m2_rule', 'next');
      this.enqueue('m2_difference', 'demo');
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
    // 最初の1個（詰まりの実演）の後は、場の更新まで出さない
    if (this.stage === 'first' && this.next >= 1) return [];
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
