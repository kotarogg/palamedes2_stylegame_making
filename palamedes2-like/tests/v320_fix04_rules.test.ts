// V320-FIX-04 第6章（演出時間・帰還・打上連鎖猶予）・第8章（数字役の攻撃報酬）
import { describe, expect, it } from 'vitest';
import { computeAttack, NUMBER_ROLE_ATTACK_BONUS, resolveCounter } from '../src/core/attack';
import { DEFAULT_CONFIG } from '../src/core/config';
import type { Command, GameEvent } from '../src/core/game';
import { evaluateStock, evaluateSubset } from '../src/core/roles';
import type { PlayerId } from '../src/core/types';
import { readJson } from './helpers';
import { kind, makeGame, rows, setStock, stepN, toPlay } from './helpers';

const P = (codes: string[]) => codes.map((c, i) => ({ id: i + 1, ...kind(c) }));
const cmd = (player: PlayerId, type: Command['type']): Command => ({ player, type }) as Command;
const evs = <T extends GameEvent['type']>(events: GameEvent[], type: T) => events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);

describe('V320-FIX-04 第6章 演出時間', () => {
  // V320-FIX-05 で更新：streakWindow 3000→null（時間制限なし）、chain 12000→10000。他の値は FIX-04 のまま
  it('roleIntro 1200・roleOutro 500・descend 1600・streakWindow null（FIX-05）。lineClear 200・lineShift 120・bounce 120・arc 260・chain 10000（FIX-05）', () => {
    const T = DEFAULT_CONFIG.timing;
    expect([T.roleIntroMs, T.roleOutroMs, T.descendMs, DEFAULT_CONFIG.streakWindowMs]).toEqual([1200, 500, 1600, null]);
    expect([T.lineClearMs, T.lineShiftMs, T.bounceMs, T.arcMs, DEFAULT_CONFIG.chainWindowMs, T.charMoveMs]).toEqual([200, 120, 120, 260, 10000, 90]);
    expect([DEFAULT_CONFIG.dangerGraceMs, DEFAULT_CONFIG.chainBonusMax, DEFAULT_CONFIG.counterPerLine, DEFAULT_CONFIG.moveBufferTicks]).toEqual([4000, 4, 2, 2]);
  });

  it('役処理の内部状態：導入72tick（1200ms）後に1ライン目、締め30tick（500ms）で roleEnd', () => {
    const g = makeGame({ boards: { 0: rows(2), 1: rows(0) } });
    setStock(g, 0, '1s', '2s', '3s', '4s'); // ストレートフラッシュ 4翻
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

describe('V320-FIX-04 第8章 数字役の攻撃報酬', () => {
  it('4ピース数字役+1、6ピース数字役+2（属性役のみは+0）', () => {
    expect(NUMBER_ROLE_ATTACK_BONUS).toEqual({ four_card: 1, nikoniko: 1, straight: 1, high_straight: 1, full_card: 2, nikoniko_niko: 2, super_straight: 2 });
  });

  it('全16役（役一覧の例）の基本攻撃（×1・役連鎖0・相殺前）。指示書の例：フォーカード1、ハイストレート2、フラッシュ2、スーパーストレート4、ストレートフラッシュ4', () => {
    const roles = readJson<{ role_list: { roles: { name: string; example: string[] }[] } }>('src/data/tutorial_script_v1.json').role_list.roles;
    const got = Object.fromEntries(
      roles.map((r) => {
        const res = evaluateSubset(P(r.example));
        return [r.name, computeAttack(res.han, 100, 1, 4, res.numberRole).power];
      }),
    );
    expect(got).toEqual({
      フォーカード: 1,
      ニコニコ: 1,
      ストレート: 1,
      ハイストレート: 2,
      フルカード: 4,
      ニコニコニコ: 4,
      スーパーストレート: 4,
      フォーブラック: 0,
      フォーレッド: 0,
      オールブラック: 0,
      オールレッド: 0,
      オールマーク: 1,
      フラッシュ: 2,
      ストレートフラッシュ: 4,
      ハイストレートフラッシュ: 5,
      スーパーストレートフラッシュ: 7,
    });
  });

  it('複合（数字役＋属性役）は数字役ボーナスを1回だけ。手元6枚から4枚部分集合が採択されたら+1', () => {
    // フォーカード＋フォーブラック：翻2 → base1 +1 = 2（ロゴ2つでも1回）
    const fc = evaluateSubset(P(['4s', '4c', '4s', '4c']));
    expect([fc.numberRole, fc.suitRole]).toEqual(['four_card', 'same_color']);
    expect(computeAttack(fc.han, 100, 1, 4, fc.numberRole)).toMatchObject({ base: 1, numberBonus: 1, power: 2 });
    // 6枚のうち4枚が採択（ストレートフラッシュ）
    const ev = evaluateStock(P(['1s', '2s', '3s', '4s', '6h', '6d']));
    expect(ev.kind).toBe('ok');
    if (ev.kind === 'ok') {
      expect(ev.result.size).toBe(4);
      expect(computeAttack(ev.result.han, 100, 1, 4, ev.result.numberRole)).toMatchObject({ numberBonus: 1, power: 4 });
    }
  });

  it('倍率は（基本＋数字役）に掛けて切捨て、役連鎖加算には掛けない', () => {
    // フォーカード（翻1）：(0+1)×1.75=1.75→1、連鎖3で+2
    expect(computeAttack(1, 175, 3, 4, 'four_card')).toMatchObject({ multiplied: 1, chainBonus: 2, power: 3 });
    // スーパーストレート（翻3）：(2+2)×1.25=5、連鎖6で+4（上限）
    expect(computeAttack(3, 125, 6, 4, 'super_straight')).toMatchObject({ multiplied: 5, chainBonus: 4, power: 9 });
    // ハイストレート（翻2）：(1+1)×1.5=3
    expect(computeAttack(2, 150, 1, 4, 'high_straight').power).toBe(3);
    // 属性役のみ：+0
    expect(computeAttack(3, 100, 1, 4, null)).toMatchObject({ numberBonus: 0, power: 2 });
  });

  it('本編：宣言時点の採択役・倍率をスナップショット。消去ラインが少なくても攻撃を減らさず、相殺へそのまま渡す。得点には加えない', () => {
    const g = makeGame({ boards: { 0: rows(1), 1: rows(0) } });
    setStock(g, 0, '1h', '2s', '3h', '4s', '5h', '6s'); // スーパーストレート（翻3）＋数字6ピース+2
    toPlay(g);
    g.step([{ player: 0, type: 'debugAttack', lines: 3 } as Command]);
    g.step([cmd(0, 'declare')]);
    stepN(g, 300);
    const a = evs(g.events, 'attack')[0];
    expect(a.linesCleared).toBe(1);
    expect(a.breakdown).toMatchObject({ base: 2, numberBonus: 2, multiplied: 4, power: 4 });
    expect(a.counter).toEqual(resolveCounter(4, 3));
    expect(a.counter).toEqual({ usedPower: 2, canceled: 3, sent: 2, discarded: 1 });
  });
});
