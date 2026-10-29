// V320-FIX-04-R1：MODE2 のノーリセット表示・専用記録は SINGLE だけ（CPU対戦・2P対戦・CPU観戦では表示・記録しない）
import { describe, expect, it } from 'vitest';
import { App, GameScene } from '../src/app';
import { AudioBus } from '../src/audio/audioBus';
import type { Mode2Game } from '../src/core/mode2';
import { defaultSettings } from '../src/input/settings';
import { emptyRecords } from '../src/ui/records';
import { fakeAssets } from './helpers';

function makeApp() {
  return new App({
    assets: fakeAssets(),
    bus: new AudioBus('./'),
    pads: () => null,
    settings: defaultSettings(),
    applyDisplay: () => undefined,
    requestFullscreen: () => undefined,
    viewport: () => ({ w: 1280, h: 720, dpr: 1 }),
    openUrl: () => undefined,
    dev: false,
  });
}

/** 1Pの盤面を場と同じ数字1個だけにして、1Pが場の更新0回で勝つ（シングルはクリア）まで進める */
function run(kind: 'single' | 'cpu' | '2p' | 'watch') {
  const app = makeApp();
  if (kind === 'watch') {
    app.watch.mode = 'mode2';
    app.startWatch();
  } else app.startGame('mode2', kind, kind === 'single' ? 'mode2' : undefined, kind === '2p' ? ['kotaro', 'akane'] : undefined);
  const sc = app.scene as GameScene;
  (sc as unknown as { holdMs: number | null }).holdMs = null;
  const g = sc.game as Mode2Game;
  for (let i = 0; i < 600 && !g.playing; i++) sc.update(1000 / 60);
  // 1P：最上段1個（場と同じ数字）。2P：出せない盤面を多く残す（1Pが先に出し切る）
  const p0 = g.players[0];
  p0.board.cols.forEach((c) => (c.length = 0));
  p0.board.cols[p0.selectedCol].push({ kind: 'piece', piece: g.factory.make(g.base.n, g.base.suit === 'spade' ? 'heart' : 'spade') });
  if (kind !== 'watch') app.onKey('KeyF', false);
  for (let i = 0; i < 60 * 30 && !g.result; i++) sc.update(1000 / 60);
  for (let i = 0; i < 120; i++) sc.update(1000 / 60);
  return { app, sc, g };
}

describe('V320-FIX-04-R1 MODE2 ノーリセット表示は SINGLE だけ', () => {
  it('SINGLE：場の更新0回のクリアで達成表示（1P）・総合ベストとノーリセット専用ベストを記録', () => {
    const { app, sc, g } = run('single');
    expect(g.result?.outcome).toBe('clear');
    expect(g.refreshCount).toBe(0);
    expect(sc.noResetShown).toBe(0);
    expect(app.records.mode2Single?.bestTicks).toBe(g.elapsedTicks());
    expect(app.records.mode2NoResetBest?.bestTicks).toBe(g.elapsedTicks());
  });

  for (const kind of ['2p', 'cpu', 'watch'] as const)
    it(`${kind}：場の更新0回で1Pが勝っても達成表示なし・記録なし（ゲーム判定上は達成者あり）`, () => {
      const { app, sc, g } = run(kind);
      expect(g.result).toMatchObject({ outcome: 'win', winner: 0 });
      expect(g.refreshCount).toBe(0);
      expect(g.noResetAchiever()).toBe(0); // 判定そのものは不変
      expect(sc.noResetShown).toBeNull();
      expect(app.records).toEqual(emptyRecords());
    });
});
