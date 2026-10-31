// v3.2.0 MODE2 説明教材（指示書 第9節）：固定盤面・固定入力を通常の Mode2Game へ渡し、実イベントで説明を切り替える。
// CPU・固定尺のページ送りは使わない。game seed＝20261027（Mode2Game へ直接渡す）、初期の場だけ 3♠ に設定。
// 盤面は初回生成時だけ setup で与え（ピースIDは factory 経由）、途中で盤面を作り直さない。
// V320-FIX-06：説明の項目は自動で始まり、その項目の実演（取得・詰まり・カウントダウン・場の更新・クリア処理）が完了し、
// 項目開始から最低表示時間が経過したら次の項目へ進む（決定入力は使わない）。最低時間の残りを待つ間はゲームを止める。
// カウントダウン（3/2/1）・場の更新の演出中は止めない。複数の説明は順に表示する（即置換しない）。
import type { Command } from '../core/game';
import { Mode2Game } from '../core/mode2';
import { ItemClock, pieceKind, type PageKey, type SyncEvent, type TextStep } from './lesson';

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

/**
 * V320-FIX-06-R1 説明の実イベント同期：場の更新の2枚目（そのあと場のカードが変わる）はカウントダウンの「1」で、
 * クリアの説明は残り0のクリア（roundEnd）で同じ項目内に切り替える（クリア処理が終わってから後追いで始めない）
 */
const STEPS: Partial<Record<PageKey, readonly TextStep[]>> = {
  m2_refresh: [{ on: 'countdown', match: (e) => e.value === 1, panel: 1 }],
  m2_difference: [{ on: 'roundEnd', match: (e) => e.outcome === 'clear', page: 'm2_clear' }],
};

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
  /** 表示の順番を待つ説明（次の項目）。キューに次の項目がある＝現在の項目の実演は区切りに達した */
  private readonly queue: PageKey[] = [];
  /** V320-FIX-06 項目の時計と記録 */
  readonly items = new ItemClock();
  /** 実演完了後、最低表示時間の残りを待っている（ゲームを進めない） */
  holding = false;
  readonly problems: string[] = [];
  private readonly busy: () => boolean;

  constructor(
    private readonly onPage: (p: PageKey) => void = () => undefined,
    /** クリア処理（結果演出）が続いているか（舞台が与える。既定はなし） */
    busy?: () => boolean,
  ) {
    this.busy = busy ?? (() => false);
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
    // 冒頭：選び方（文字だけ）→ 詰まった時の場の更新（実演）
    this.enqueue('m2_intro');
    this.enqueue('m2_refresh');
    this.pump();
  }

  get done(): boolean {
    return this.stage === 'done';
  }

  private enqueue(page: PageKey): void {
    this.queue.push(page);
  }

  /** 次の項目へ進める状態なら進める（現在の項目の実演が完了し、最低表示時間が経過）。最低時間の残りを待つ間は holding */
  private pump(): void {
    this.holding = false;
    if (this.items.current) {
      // 現在の項目の実演が続いている（次の項目がまだ要求されていない、または処理中）
      const last = this.stage === 'clear' && !this.queue.length;
      if (!last && !this.queue.length) return;
      if (!this.complete()) return;
      this.items.markDone();
      if (!this.items.minElapsed) {
        this.holding = true;
        return;
      }
      if (last) {
        this.items.close();
        this.stage = 'done';
        return;
      }
    }
    const page = this.queue.shift();
    if (!page) return;
    this.items.begin(page, STEPS[page] ?? [], this.game.tick);
    this.page = page;
    this.onPage(page);
    if (page === 'm2_refresh') this.stage = 'first'; // 詰まりの実演はこの項目から
  }

  /** 項目の実演の完了：プレイ中（カウントダウン・場の更新の演出中でない）で飛行・移動・硬直がない。クリア後はクリア処理（busy）の終了 */
  private complete(): boolean {
    const g = this.game;
    if (g.result) return !this.busy();
    const p = g.players[0];
    return g.phase === 'play' && !g.flights.some((f) => f.player === 0) && !g.isMoving(p) && !g.isLocked(p);
  }

  /** 1tick 分（項目の時計は毎回進む）。最低時間の残りを待つ間はゲームを進めない。戻り値：ゲームを進めたか */
  tick(): boolean {
    if (this.done) return false;
    this.items.setGameTick(this.game.tick);
    this.items.advance();
    this.pump();
    if (this.done || this.holding) return false;
    const g = this.game;
    // 次の項目が順番待ち（現在の実演の処理の終わりを待つ）：操作は出さずにゲームだけ進める。決着後は表示の時間だけ進む
    g.step(this.queue.length || g.result ? [] : this.commands());
    this.scan();
    this.settle();
    return true;
  }

  /** 実イベントへ同期して説明を予約する */
  private scan(): void {
    const g = this.game;
    for (; this.cursor < g.events.length; this.cursor++) {
      const e = g.events[this.cursor];
      this.items.onEvent(e as unknown as SyncEvent);
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
          // m2_clear は m2_difference の項目内でクリアと同時に表示（R1）
          this.enqueue('m2_versus');
          this.enqueue('m2_versus_refresh');
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
      this.enqueue(pages[this.explained++]);
    } else {
      this.stage = 'rest';
      this.enqueue('m2_rule');
      this.enqueue('m2_difference');
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
    if (this.afterArriveExplain && !this.waitingArrive) {
      this.afterArriveExplain = false;
      this.beginExplain();
    }
  }
}
