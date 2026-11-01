// V320-MEASURE-01：記録器（パッドの押しっぱなし／新規押下、上限の通知と停止、保存形式と順序、ラウンドの連続、途中開始）と集計
import { describe, expect, it } from 'vitest';
import type { Command, Game } from '../src/core/game';
import { Match, SingleSession } from '../src/core/match';
import { createSeededRng } from '../src/core/rng';
import { CpuController } from '../src/input/cpu';
import { GamepadController, type PadState } from '../src/input/controller';
import { profileConfig } from '../src/measure/profile';
import { MeasureRecorder } from '../src/measure/recorder';
// @ts-expect-error 集計スクリプトは .mjs（型なし）
import { analyze, hiddenIntervals, isEntry, stats } from '../scripts/measure-analyze.mjs';

const btn = (pressed: boolean, value = pressed ? 1 : 0) => ({ pressed, touched: pressed, value });
function padState(pressed: number[] = [], axes = [0, 0, 0, 0]): PadState {
  return { id: 'Test Pad', mapping: 'standard', timestamp: 0, buttons: Array.from({ length: 17 }, (_, i) => btn(pressed.includes(i))), axes } as unknown as PadState;
}

function parse(rec: MeasureRecorder) {
  return JSON.parse(rec.exportParts().join(''));
}

describe('パッドの記録：押しっぱなしを連打にしない・既存の取得を変えない', () => {
  it('A を30回の取得で押し続け→離す：padBtn は押下1・離し1、発射コマンドは新規1（反復なし）', () => {
    let clock = 0;
    const rec = new MeasureRecorder(undefined, () => clock);
    let cur: PadState | null = padState();
    const src = rec.wrapPadSource(() => cur);
    rec.start();
    const ctl = new GamepadController(0, 0, undefined, src, () => clock);
    const cmds: Command[] = [];
    const fake = { tick: 0 } as unknown as Game;
    for (let i = 0; i < 40; i++) {
      clock += 1000 / 60;
      cur = padState(i >= 5 && i < 35 ? [0] : []);
      const out = ctl.poll(fake);
      for (const c of out) rec.command(c, 'pad');
      cmds.push(...out);
    }
    rec.stop();
    const recs = parse(rec).records as { e: string; d: { b?: number; p?: number; a?: string; rep?: number } }[];
    const a = recs.filter((r) => r.e === 'padBtn' && r.d.b === 0);
    expect(a.map((r) => r.d.p), JSON.stringify(recs.slice(0, 8))).toEqual([1, 0]);
    expect(cmds.filter((c) => c.type === 'launch')).toHaveLength(1);
    const launch = recs.filter((r) => r.e === 'cmd' && r.d.a === 'launch');
    expect(launch).toHaveLength(1);
    expect(launch[0].d.rep).toBe(0);
    // 集計：押下時間（約30取得分）と新規押下1件
    const an = analyze(parse(rec));
    expect(an.holdMs.pad.b0.n).toBe(1);
    expect(an.holdMs.pad.b0.median).toBeGreaterThan(450);
  });

  it('記録の有無で取得値・取得回数は変わらない（包んだ関数は同じ値を返す）', () => {
    const rec = new MeasureRecorder(undefined, () => 0);
    let calls = 0;
    const s = padState([1]);
    const src = rec.wrapPadSource(() => (calls++, s));
    expect(src(0)).toBe(s);
    rec.start();
    expect(src(0)).toBe(s);
    expect(calls).toBe(2);
  });

  it('スティック：0.02未満の揺れは記録しない、0への復帰は記録、方向判定は 0.5 で変化時のみ', () => {
    const rec = new MeasureRecorder(undefined, () => 0);
    rec.start();
    for (const v of [0, 0.005, 0.01, 0.3, 0.31, 0.6, 0.61, 0.9, 0.2, 0]) rec.observePad(0, padState([], [v, 0, 0, 0]));
    const recs = parse(rec).records as { e: string; d: { a: number; v: number; dir: number } }[];
    expect(recs.filter((r) => r.e === 'padAxis' && r.d.a === 0).map((r) => r.d.v)).toEqual([0, 0.3, 0.6, 0.9, 0.2, 0]);
    expect(recs.filter((r) => r.e === 'padDir' && r.d.a === 0).map((r) => r.d.dir)).toEqual([1, 0]);
  });
});

describe('上限：黙って捨てない', () => {
  it('80％で通知、100％で停止（以後の記録はしない・古い記録も消さない）、再開できない', () => {
    const notices: string[] = [];
    const rec = new MeasureRecorder(undefined, () => 0, { maxRecords: 100, maxChars: 1e9, warnRatio: 0.8 });
    rec.onNotice = (m) => notices.push(m);
    rec.start();
    for (let i = 0; i < 200; i++) rec.note('x', { i });
    expect(rec.state).toBe('stopped');
    expect(rec.limitStopped).toBe(true);
    expect(notices).toHaveLength(2);
    // 上限に達した1件＋停止の記録（measureStop）まで。最初の記録は残る
    expect(rec.count).toBe(101);
    const recs = parse(rec).records as { e: string; s: number; d: { reason?: string } }[];
    expect(recs[0].e).toBe('measureStart');
    expect(recs[recs.length - 1]).toMatchObject({ e: 'measureStop', d: { reason: 'limit' } });
    rec.start();
    expect(rec.state).toBe('stopped');
  });
});

/** 人の代わりの入力（seed 付き） */
function noisy(seed: number) {
  const rng = createSeededRng(seed);
  const acts = ['left', 'right', 'launch', 'rotate', 'declare'] as const;
  return (): Command[] => (rng.next() < 0.3 ? [{ player: 0, type: acts[Math.floor(rng.next() * acts.length)] }] : []);
}

function runRecorded(seed: number, ticks: number) {
  let clock = 0;
  const rec = new MeasureRecorder(undefined, () => clock);
  const m = new Match({ firstTo: 2, difficulty: 'normal', seed, mode: 'mode1', config: profileConfig('B') });
  const human = noisy(seed);
  const cpu = new CpuController(1, 'normal', seed, 'akane');
  rec.matchStart({ mode: 'mode1', kind: 'cpu', characters: ['kotaro', 'akane'], devices: [], humans: [0], seed, profile: 'B' });
  for (let i = 0; i < ticks && m.state !== 'matchResult'; i++) {
    clock += 1000 / 60;
    rec.beginFrame(1000 / 60);
    if (i === 120) rec.start(); // 試合の途中から開始
    if (i === 900) rec.visibility(true, false, 'hidden');
    if (i === 960) rec.visibility(false, true, 'visible');
    const g = m.game as Game;
    rec.beforeTick(g);
    const cmds = [...human(), ...cpu.poll(g)];
    for (const c of cmds) rec.command(c, c.player === 0 ? 'keyboard' : 'cpu');
    // アプリと同じく、ラウンド結果の表示中はゲームへ渡さない（理由 result）
    if (m.state !== 'round') for (const c of cmds) rec.dropCommand(c, 'result');
    m.step(cmds, m.state === 'roundResult');
    rec.afterTick(m.game as Game);
  }
  rec.stop();
  return { rec, m };
}

describe('保存形式・順序・ラウンドの連続・途中開始', () => {
  const { rec, m } = runRecorded(5, 60 * 60 * 4);
  const json = parse(rec);
  const recs = json.records as { s: number; t: number; m: number; r: number; k: number | null; e: string; d: Record<string, unknown> }[];

  it('JSON として読める。s は0からの連番、t は単調。ヘッダーに形式・設定', () => {
    expect(json.header.format).toBe('kotaro-puzzle-measure');
    expect(json.header.session.records).toBe(recs.length);
    expect(recs.every((r, i) => r.s === i)).toBe(true);
    expect(recs.every((r, i) => i === 0 || r.t >= recs[i - 1].t)).toBe(true);
  });

  it('途中開始でも試合情報とラウンドの全体を最初に記録（why＝measureStart）', () => {
    const first = recs.slice(0, 4).map((r) => `${r.e}:${String(r.d.why ?? '')}`);
    expect(first).toEqual(['measureStart:', 'matchStart:measureStart', 'roundStart:measureStart', expect.any(String)]);
  });

  it('複数ラウンドを1つの記録へ続けて残し、ラウンドID が増える', () => {
    expect(m.round).toBeGreaterThanOrEqual(2);
    const rounds = [...new Set(recs.filter((r) => r.e === 'roundStart').map((r) => r.r))];
    expect(rounds.length).toBeGreaterThanOrEqual(2);
    expect(rounds).toEqual([...rounds].sort((a, b) => a - b));
  });

  it('予約の受付・消費・破棄が対応する（集計で未対応の予約が残らない）', () => {
    const an = analyze(json);
    const h = an.commands.human;
    expect(h.n).toBeGreaterThan(100);
    expect(h.accepted + h.discarded + (h.byOutcome.bufferPendingAtEnd ?? 0)).toBe(h.n);
    if (h.byOutcome.noTrace) console.log(JSON.stringify(debugNoTrace(json)));
    expect(h.byOutcome.noTrace ?? 0).toBe(0);
    expect(an.commands.unattributedTrace).toEqual({});
    expect(h.reserved).toBeGreaterThan(0);
    expect((h.byOutcome.executedBuffered ?? 0) + (h.byOutcome.bufferDiscarded ?? 0) + (h.byOutcome.bufferRejected ?? 0) + (h.byOutcome.bufferPendingAtEnd ?? 0)).toBe(h.reserved);
    // 非表示区間に掛かる間隔は除外
    expect(an.excluded.hidden).toBeGreaterThan(0);
    expect(an.rounds.length).toBeGreaterThanOrEqual(2);
    expect(an.launch.human.arrive).toBeGreaterThan(0);
    const lock = an.timeByStateMs['0'];
    expect(lock.operable).toBeGreaterThan(0);
    expect(lock.launch).toBeGreaterThan(0);
  });
});

function debugNoTrace(json: { records: { s: number; e: string; f: number; k: number | null; d: Record<string, unknown> }[] }) {
  const recs = json.records;
  const ids = new Set(recs.filter((r) => r.e === 'in' || r.e === 'cmdDrop').map((r) => r.d.id));
  const lost = recs.filter((r) => r.e === 'cmd' && r.d.src === 'keyboard' && !ids.has(r.d.id));
  return lost.slice(0, 3).map((c) => recs.filter((r) => r.f === c.f && r.e !== 'st').map((r) => `${r.e}:${r.k}:${JSON.stringify(r.d).slice(0, 120)}`));
}

describe('単独ひたすら（MODE1 SINGLE endless）', () => {
  it('打上硬直B（飛行12tick・列詰め3tick）を適用し、入力の追跡・状態・スコアを記録する', () => {
    let clock = 0;
    const rec = new MeasureRecorder(undefined, () => clock);
    const s = new SingleSession({ mode: 'endless', seed: 9, config: profileConfig('B') });
    const g0 = s.game as Game;
    // 実効設定（ms）は公開の config で、tick 換算は記録器が保存する roundStart.timingTicks で確認する（Game の非公開フィールドへは触れない）
    expect([g0.config.timing.launchMs, g0.config.timing.packMs]).toEqual([200, 50]);
    rec.matchStart({ mode: 'mode1', kind: 'single', singleMode: 'endless', characters: ['kotaro'], devices: [], humans: [0], seed: 9, profile: 'B' });
    rec.start();
    const h = noisy(9);
    for (let i = 0; i < 60 * 60; i++) {
      clock += 1000 / 60;
      const g = s.game as Game;
      rec.beforeTick(g);
      const cmds = h();
      for (const c of cmds) rec.command(c, 'keyboard');
      s.step(cmds, false);
      rec.afterTick(g);
    }
    rec.stop();
    const json = parse(rec);
    const recs = json.records as { e: string; d: Record<string, unknown> }[];
    const rs = recs.find((r) => r.e === 'roundStart')!;
    expect(rs.d.single).toMatchObject({ kind: 'endless' });
    expect(rs.d.timingTicks).toMatchObject({ launchMs: 12, packMs: 3 });
    expect(recs.some((r) => r.e === 'st' && 'single' in r.d)).toBe(true);
    const an = analyze(json);
    expect(an.commands.human.n).toBeGreaterThan(50);
    expect(an.commands.human.byOutcome.noTrace ?? 0).toBe(0);
  });
});

describe('集計の部品', () => {
  it('CLI の起動判定は OS に依存しない（Windows のパスと file URL、Linux／macOS）', () => {
    const w = 'file:///C:/work/palamedes2-like/scripts/measure-analyze.mjs';
    expect(isEntry(w, 'C:\\work\\palamedes2-like\\scripts\\measure-analyze.mjs', 'win32')).toBe(true);
    expect(isEntry(w, 'c:\\Work\\palamedes2-like\\scripts\\measure-analyze.mjs', 'win32')).toBe(true);
    expect(isEntry(w, 'C:/work/palamedes2-like/scripts/measure-analyze.mjs', 'win32')).toBe(true);
    expect(isEntry(w, 'C:\\work\\palamedes2-like\\scripts\\e2e.mjs', 'win32')).toBe(false);
    expect(isEntry('file:///home/u/p/scripts/measure-analyze.mjs', '/home/u/p/scripts/measure-analyze.mjs', 'linux')).toBe(true);
    expect(isEntry('file:///home/u/p/scripts/measure-analyze.mjs', '/home/u/p/scripts/other.mjs', 'linux')).toBe(false);
    expect(isEntry(w, undefined, 'win32')).toBe(false);
  });

  it('stats：中央値・分位', () => {
    expect(stats([1, 2, 3, 4, 100])).toMatchObject({ n: 5, median: 3, min: 1, max: 100 });
    expect(stats([]).median).toBeNull();
  });
  it('非表示・フォーカス喪失の区間', () => {
    const recs = [
      { e: 'visibility', t: 10, d: { hidden: false, focused: false } },
      { e: 'visibility', t: 20, d: { hidden: true, focused: false } },
      { e: 'visibility', t: 50, d: { hidden: false, focused: true } },
    ];
    expect(hiddenIntervals(recs)).toEqual([[10, 50]]);
  });
});
