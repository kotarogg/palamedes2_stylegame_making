// V320-FIX-04 第6章（演出時間・帰還・打上連鎖猶予）・第8章（数字役の攻撃報酬）
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/core/config';
import type { Command, GameEvent } from '../src/core/game';
import type { PlayerId } from '../src/core/types';
import { readJson } from './helpers';
import { makeGame, rows, setStock, stepN, toPlay } from './helpers';

const cmd = (player: PlayerId, type: Command['type']): Command => ({ player, type }) as Command;
const evs = <T extends GameEvent['type']>(events: GameEvent[], type: T) => events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);

describe('V320-FIX-04 第6章 演出時間', () => {
  // V320-FIX-05 で更新：streakWindow 3000→null（時間制限なし）、chain 12000→10000。他の値は FIX-04 のまま
  it('roleIntro 1200・roleOutro 500・descend 1600・streakWindow null（FIX-05）。lineClear 200・lineShift 120・bounce 120・arc 260・chain 10000（FIX-05）', () => {
    const T = DEFAULT_CONFIG.timing;
    expect([T.roleIntroMs, T.roleOutroMs, T.descendMs, DEFAULT_CONFIG.streakWindowMs]).toEqual([1200, 500, 1600, null]);
    expect([T.lineClearMs, T.lineShiftMs, T.bounceMs, T.arcMs, DEFAULT_CONFIG.chainWindowMs, T.charMoveMs]).toEqual([200, 120, 120, 260, 10000, 90]);
    // V320-FIX-06 で更新：相殺は 1対1（counterPerLine 2→1）
    expect([DEFAULT_CONFIG.dangerGraceMs, DEFAULT_CONFIG.chainBonusMax, DEFAULT_CONFIG.counterPerLine, DEFAULT_CONFIG.moveBufferTicks]).toEqual([4000, 4, 1, 2]);
  });

  it('役処理の内部状態：導入72tick（1200ms）後に1ライン目、締め30tick（500ms）で roleEnd', () => {
    const g = makeGame({ boards: { 0: rows(2), 1: rows(0) } });
    setStock(g, 0, '1s', '2s', '3s', '4s'); // ストレートフラッシュ（V320-FIX-06：消去4）
    toPlay(g);
    g.step([cmd(0, 'declare')]);
    const d = evs(g.events, 'declare')[0];
    expect(d.introEndTick - d.tick).toBe(72);
    stepN(g, 400);
    const lc = evs(g.events, 'lineClear');
    expect(lc[0].tick).toBe(d.introEndTick);
    const atk = evs(g.events, 'attack')[0];
    const end = evs(g.events, 'roleEnd')[0];
    expect(end.tick - atk.tick).toBe(30);
  });

  // V320-FIX-05 で更新：旧「到達から180tick（3000ms）で切れる」は時間制限の撤廃で無効
  it('V320-FIX-05 打上連鎖は時間制限なし：成功後に長く待っても切れない（受付残りは null）', () => {
    const g = makeGame({ base: '1s', boards: { 0: { 2: ['2s', '3s'] }, 1: rows(0) } });
    toPlay(g);
    g.step([cmd(0, 'launch')]);
    while (!evs(g.events, 'arrive').length) g.step();
    const p = g.players[0];
    expect(p.streakRemaining).toBeNull();
    stepN(g, 60 * 60);
    expect([g.streakActive(p), p.streakCount]).toEqual([true, 1]);
    expect(evs(g.events, 'streakCut')).toEqual([]);
  });

  // V320-FIX-05 で更新：打上の復帰は null（時間制限なし）、役連鎖は10000
  it('旧JSONの復帰値（2000／8000／3000）は使わない：ステージ移行の復帰は打上 null（時間制限なし）・役連鎖10000・ピンチ4000', () => {
    const b = readJson<{ stage_transition: Record<string, number | null> }>('src/data/mode1_balance_v1.json').stage_transition;
    expect([b.restore_streak_remaining_ms, b.restore_chain_remaining_ms, b.danger_grace_max_ms]).toEqual([null, 10000, 4000]);
  });
});

// V320-FIX-04 第8章（数字役の攻撃報酬：翻数−1＋数字役ボーナス、打上連鎖の攻撃倍率）の検査は、V320-FIX-06 で計算式そのものを
// 廃止したため削除し、新しい数値表・攻撃式・相殺1対1の検査（tests/v320_fix06_rules.test.ts）へ置き換えた。
