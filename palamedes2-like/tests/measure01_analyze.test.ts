// V320-MEASURE-01 R2：役連鎖継続率（継続機会の定義。PM確認 2026-11-01）
// ①受付中の自分の敗北＝未確定（主の率から除外、件数は別）②画面非表示と重なった機会＝主の率から除外 ③SINGLE のステージ間継続＝主の率から除外し別集計
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error 集計スクリプトは .mjs（型なし）
import { analyze } from '../scripts/measure-analyze.mjs';

type Rec = { s: number; t: number; f: number; m: number; r: number; k: number | null; e: string; d: Record<string, unknown> };

/** 記録の組み立て（1tick＝1000/60ms、t は k から算出。必要な種類だけ） */
function builder(kind: 'cpu' | 'single' = 'cpu') {
  const recs: Rec[] = [];
  let m = 1;
  let r = 1;
  let tOff = 0;
  const push = (e: string, d: Record<string, unknown>, k: number | null = 0) => recs.push({ s: recs.length, t: tOff + ((k ?? 0) * 1000) / 60, f: 0, m, r, k, e, d });
  push('measureStart', { segment: 1 }, null);
  push('matchStart', { why: 'new', mode: 'mode1', kind, humans: [0], seed: 1, profile: 'B' }, null);
  const b = {
    recs,
    roundStart(chain0 = 0, why = 'new') {
      push('roundStart', { why, players: [{ id: 0, chain: chain0 }, { id: 1, chain: 0 }], playStartTick: 0 }, 0);
      return b;
    },
    declare(k: number, n: number) {
      push('ev', { type: 'declare', player: 0, chainCount: n }, k);
      push('st', { p: 0, chain: n, chainRemaining: 600 }, k);
      return b;
    },
    roleEnd(k: number) {
      push('ev', { type: 'roleEnd', player: 0 }, k);
      return b;
    },
    expire(k: number) {
      push('st', { p: 0, chain: 0 }, k);
      return b;
    },
    roundEnd(k: number, outcome: string, winner: number | null) {
      push('ev', { type: 'roundEnd', winner, outcome }, k);
      return b;
    },
    nextRound(chain0 = 0) {
      tOff = recs[recs.length - 1].t + 1000;
      r++;
      return b.roundStart(chain0);
    },
    hidden(k0: number, k1: number) {
      push('visibility', { hidden: true, focused: false, cause: 'visibilitychange' }, k0);
      push('visibility', { hidden: false, focused: true, cause: 'visibilitychange' }, k1);
      return b;
    },
    stop(k: number) {
      push('measureStop', { segment: 1, reason: 'user' }, k);
      return b;
    },
    resume(k: number, chainNow: number) {
      push('measureStart', { segment: 2 }, null);
      recs[recs.length - 1].k = null;
      recs[recs.length - 1].t = tOff + (k * 1000) / 60;
      push('roundStart', { why: 'measureStart', players: [{ id: 0, chain: chainNow }, { id: 1, chain: 0 }], playStartTick: 0 }, k);
      return b;
    },
    leave(k: number) {
      push('matchLeave', {}, k);
      return b;
    },
    newMatch() {
      m++;
      r = 1;
      return b;
    },
  };
  return b;
}

const chainOf = (recs: Rec[]) => analyze({ header: {}, records: recs }).chain;

describe('役連鎖継続率（継続機会の定義）', () => {
  it('例1：1→2→3、受付切れ＝成功2・失敗確定1（66.7%）。連鎖数別も出す', () => {
    const b = builder().roundStart().declare(100, 1).roleEnd(160).declare(400, 2).roleEnd(460).declare(700, 3).roleEnd(760).expire(1360).roundEnd(2000, 'win', 1).leave(2100);
    const c = chainOf(b.recs);
    expect(c.main).toMatchObject({ success: 2, failure: 1, rate: 66.7 });
    expect(c.byLength).toEqual({ '1→2': { success: 1, failure: 0, rate: 100 }, '2→3': { success: 1, failure: 0, rate: 100 }, '3→4': { success: 0, failure: 1, rate: 0 } });
    expect(c.excluded.undetermined).toEqual({});
    // 役処理の完了→次の成立（主の成功のみ）：240tick＝4000ms
    expect(c.roleEndToNextDeclareMs.raw).toEqual([4000, 4000]);
    expect(c.legacy.rate).toBe(66.7);
  });

  it('例2：受付中に相手が敗北してラウンド終了＝未確定（opponentDefeat）。主の率は 100%', () => {
    const b = builder().roundStart().declare(100, 1).declare(400, 2).declare(700, 3).roundEnd(800, 'win', 0).nextRound();
    const c = chainOf(b.recs);
    expect(c.main).toMatchObject({ success: 2, failure: 0, rate: 100 });
    expect(c.excluded.undetermined).toEqual({ opponentDefeat: 1 });
  });

  it('① 受付中の自分の敗北は未確定（主の率から除外、件数は ownDefeat に残す）。SINGLE のゲームオーバーも同じ', () => {
    const b = builder().roundStart().declare(100, 1).declare(400, 2).expire(1000).declare(1200, 1).roundEnd(1300, 'win', 1).nextRound();
    const c = chainOf(b.recs);
    expect(c.main).toMatchObject({ success: 1, failure: 1, rate: 50 });
    expect(c.excluded.undetermined).toEqual({ ownDefeat: 1 });
    const s = builder('single').roundStart().declare(100, 1).roundEnd(300, 'gameOver', null).leave(400);
    expect(chainOf(s.recs).excluded.undetermined).toEqual({ ownDefeat: 1 });
  });

  it('② 画面非表示と重なった機会は主の率から除外し、別に数える', () => {
    const b = builder().roundStart().declare(100, 1).hidden(200, 260).declare(400, 2).declare(700, 3).expire(1300).leave(1400);
    const c = chainOf(b.recs);
    expect(c.main).toMatchObject({ success: 1, failure: 1 });
    expect(c.excluded.hiddenOverlap).toMatchObject({ success: 1, failure: 0 });
  });

  it('③ SINGLE のステージをまたいだ継続は主の率から除外し、ステージ間継続として別集計', () => {
    const b = builder('single').roundStart().declare(100, 1).declare(400, 2).roundEnd(500, 'stageClear', 0).nextRound(2).declare(200, 3).expire(800).leave(900);
    const c = chainOf(b.recs);
    expect(c.main).toMatchObject({ success: 1, failure: 1, rate: 50 });
    expect(c.excluded.stageCarry).toMatchObject({ success: 1, failure: 0, undetermined: 0 });
    // 旧定義（ラウンドで区切る）との違い
    expect(c.legacy).toMatchObject({ declares: 3, continued: 1 });
  });

  it('次面へ引き継がないステージ終了（最終面）は未確定（singleEnd）', () => {
    const b = builder('single').roundStart().declare(100, 1).roundEnd(300, 'allStagesClear', 0).leave(400);
    expect(chainOf(b.recs).excluded.undetermined).toEqual({ singleEnd: 1 });
  });

  it('計測の停止・再開：停止中に切れた＝失敗確定（時刻不明）。停止中に宣言があった＝成功（停止中の宣言は数えない）。停止のまま終了＝未確定', () => {
    const a = builder().roundStart().declare(100, 1).stop(200).resume(1200, 0).leave(1300);
    const ca = chainOf(a.recs);
    expect(ca.main).toMatchObject({ success: 0, failure: 1, timeUnknownFailures: 1 });
    const b = builder().roundStart().declare(100, 1).stop(200).resume(500, 2).declare(700, 3).expire(1300).leave(1400);
    const cb = chainOf(b.recs);
    expect(cb.main).toMatchObject({ success: 1, failure: 1 });
    expect(cb.unobservedDeclaresDuringStop).toBe(1);
    const c = builder().roundStart().declare(100, 1).stop(200);
    expect(chainOf(c.recs).excluded.undetermined).toEqual({ measureStopped: 1 });
  });

  it('受付切れの記録が欠けても、次の成立が連鎖数1なら失敗確定（時刻不明）', () => {
    const b = builder().roundStart().declare(100, 1).declare(900, 1).leave(1000);
    const c = chainOf(b.recs);
    expect(c.main).toMatchObject({ success: 0, failure: 1, timeUnknownFailures: 1 });
    expect(c.excluded.undetermined).toEqual({ matchLeft: 1 });
  });

  it('すべての継続機会がどれか1つに分類される（機会数＝人間の成立宣言数）', () => {
    const b = builder().roundStart().declare(100, 1).declare(400, 2).expire(1000).declare(1100, 1).hidden(1150, 1200).declare(1300, 2).roundEnd(1400, 'win', 0).nextRound().declare(100, 1).leave(200);
    const c = chainOf(b.recs);
    const decl = b.recs.filter((x) => x.e === 'ev' && x.d.type === 'declare').length;
    const und = Object.values(c.excluded.undetermined as Record<string, number>).reduce((x, y) => x + y, 0);
    expect(c.opportunities).toBe(decl);
    expect(c.main.success + c.main.failure + und + c.excluded.hiddenOverlap.success + c.excluded.hiddenOverlap.failure + c.excluded.stageCarry.success + c.excluded.stageCarry.failure).toBe(decl);
  });
});

describe('F05：計測の停止中に宣言が進み、再開後に追加の宣言がない場合（報告書 0.6 の停止・再開の定義）', () => {
  const expectResumeSuccess = (c: { main: Record<string, unknown>; continuationRate: number | null; unobservedDeclaresDuringStop: number; excluded: { undetermined: Record<string, number> }; opportunities: number }) => {
    expect(c.main).toMatchObject({ success: 1, failure: 0, rate: 100, timeUnknownFailures: 0 });
    expect(c.continuationRate).toBe(100);
    expect(c.unobservedDeclaresDuringStop).toBe(1);
    expect(c.excluded.undetermined).toEqual({});
    expect(c.opportunities).toBe(1); // 停止中の未観測の宣言から始まる機会は数えない
  };

  it('再開後に記録終了：成功1・失敗0・100%、未観測1', () => {
    const b = builder().roundStart().declare(100, 1).stop(200).resume(1000, 2);
    expectResumeSuccess(chainOf(b.recs));
  });

  it('再開後に追加の宣言なしで時間切れ：成功1・失敗0・100%（時間切れは未観測の宣言の機会なので分母に入れない）、未観測1', () => {
    const b = builder().roundStart().declare(100, 1).stop(200).resume(1000, 2).expire(1420).leave(1500);
    expectResumeSuccess(chainOf(b.recs));
  });

  it('再開時に連鎖数が減っていた（停止中に切れて数え直した）：失敗確定（時刻不明）、数え直した宣言は未観測として別記', () => {
    const b = builder().roundStart().declare(100, 1).declare(300, 2).declare(500, 3).stop(600).resume(2000, 1).expire(2500).leave(2600);
    const c = chainOf(b.recs);
    expect(c.main).toMatchObject({ success: 2, failure: 1, timeUnknownFailures: 1 });
    expect(c.unobservedDeclaresDuringStop).toBe(1);
    expect(c.opportunities).toBe(3);
  });

  it('正式な集計CLI：再現用の固定入力（tests/fixtures/f05_*.json）で出力JSONが期待値と一致', () => {
    const dir = mkdtempSync(join(tmpdir(), 'f05-'));
    try {
      const cli = fileURLToPath(new URL('../scripts/measure-analyze.mjs', import.meta.url));
      for (const name of ['f05_resume_record_end', 'f05_resume_expired']) {
        const input = fileURLToPath(new URL(`fixtures/${name}.json`, import.meta.url));
        const out = join(dir, `${name}.out.json`);
        const stdout = execFileSync(process.execPath, [cli, input, out], { encoding: 'utf8' });
        expect(stdout, name).toContain('役連鎖の継続率 100%（成功 1・失敗確定 0。除外：未確定 {}');
        expectResumeSuccess(JSON.parse(readFileSync(out, 'utf8')).chain);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
