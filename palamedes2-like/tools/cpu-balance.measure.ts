// 第3版 第21章 バランス計測：CPU同士（中級/上級 × 自然上昇 中級/上級）、seed 1〜20、1ラウンド上限10分。
// 攻撃力・相殺効率は変更しない（現行 DEFAULT_CONFIG）。結果は test-results/cpu-balance/ へ JSON と Markdown で保存。
// CPU同士の結果であり、人間のプレイ結果と同一視しない。
import { mkdirSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { DEFAULT_CONFIG, NATURAL_RISE_MS, type Difficulty } from '../src/core/config';
import { Game } from '../src/core/game';
import { RoundRecorder, type RoundMetrics } from '../src/core/metrics';
import { CpuController } from '../src/input/cpu';

const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);
const LIMIT_TICKS = 60 * 60 * 10;
const CASES: [Difficulty, Difficulty][] = [
  ['normal', 'normal'],
  ['normal', 'hard'],
  ['hard', 'normal'],
  ['hard', 'hard'],
];
const LABEL: Record<Difficulty, string> = { easy: '初級', normal: '中級', hard: '上級' };

function runRound(level: Difficulty, rise: Difficulty, seed: number): RoundMetrics {
  const config = { ...DEFAULT_CONFIG, naturalRiseIntervalMs: NATURAL_RISE_MS[rise] };
  const g = new Game({ seed, config });
  // CPU の乱数は試合の乱数と別系列（準備書5.2と同じ割当）
  const c = [new CpuController(0, level, seed * 3), new CpuController(1, level, seed * 5 + 1)];
  const rec = new RoundRecorder(g);
  while (!g.result && g.tick < LIMIT_TICKS) {
    g.step([...c[0].poll(g), ...c[1].poll(g)]);
    rec.sample();
  }
  return rec.finish();
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const a = [...xs].sort((x, y) => x - y);
  return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
};
const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—');

it('CPU同士のバランス計測（seed 1〜20 × 4条件）', () => {
  const out: Record<string, RoundMetrics[]> = {};
  const md: string[] = [
    '# CPU同士のバランス計測（第3版 v3.0.0-rc1）',
    '',
    `実行日時：${new Date().toISOString()}／条件：seed 1〜20、1ラウンド上限10分、攻撃力・相殺効率は変更なし（DEFAULT_CONFIG）`,
    'CPU の乱数：1P＝seed×3、2P＝seed×5＋1（準備書5.2と同じ）。値は1プレイヤーあたり（両者の平均）。CPU同士の結果であり、人間のプレイとは同一視しない。',
    '',
    '| 条件 | 決着率 | 未決着 | 決着時間 平均/中央（秒） | 決着原因（自然危険/攻撃ピンチ/引分け） | 宣言数 | 宣言間隔（秒） | 平均翻数 | 連鎖継続（2連鎖以上の数／最大） | 連鎖の途切れ（時間切れ／終了時継続） | 基本攻撃 | 倍率後 | 平均倍率% | 連鎖加算 | 攻撃力 | 送信 | 相殺 | 実適用 | ピンチ破棄 | 上限超過 | 7段到達 | 攻撃ピンチ猶予 | ブロック残 最大/平均 | 待機 最大/平均 |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const [level, rise] of CASES) {
    const rounds = SEEDS.map((s) => runRound(level, rise, s));
    out[`cpu_${level}__rise_${rise}`] = rounds;
    const decided = rounds.filter((r) => r.decided);
    const ps = rounds.flatMap((r) => r.players);
    const pm = (fn: (p: (typeof ps)[number]) => number | null) => mean(ps.map(fn).filter((x): x is number => x !== null && Number.isFinite(x)));
    const causes = rounds.flatMap((r) => r.causes);
    const draws = rounds.filter((r) => r.outcome === 'draw').length;
    md.push(
      `| CPU${LABEL[level]}×上昇${LABEL[rise]} | ${decided.length}/20 | ${20 - decided.length} | ${f(mean(decided.map((r) => r.seconds)), 1)} / ${f(median(decided.map((r) => r.seconds)), 1)} | ${causes.filter((c) => c === 'natural_danger').length}/${causes.filter((c) => c === 'attack_pinch').length}/${draws} | ${f(pm((p) => p.declares), 1)} | ${f(pm((p) => p.declareIntervalSec), 1)} | ${f(pm((p) => p.hanAvg))} | ${f(pm((p) => p.chains.continued))} / ${Math.max(...ps.map((p) => p.chains.max))} | ${f(pm((p) => p.chains.brokenByTimeout))} / ${f(pm((p) => p.chains.endedByRound))} | ${f(pm((p) => p.attack.base), 1)} | ${f(pm((p) => p.attack.multiplied), 1)} | ${f(pm((p) => p.attack.streakPercentAvg), 0)} | ${f(pm((p) => p.attack.chainBonus), 1)} | ${f(pm((p) => p.attack.power), 1)} | ${f(pm((p) => p.attack.sent), 1)} | ${f(pm((p) => p.incoming.canceled), 1)} | ${f(pm((p) => p.incoming.applied), 1)} | ${f(pm((p) => p.incoming.pinchDiscarded), 1)} | ${f(pm((p) => p.incoming.overflow), 1)} | ${f(pm((p) => p.reached7), 1)} | ${f(pm((p) => p.attackPinchGraces), 1)} | ${Math.max(...ps.map((p) => p.stock.blockMax))}/${f(pm((p) => p.stock.blockAvg))} | ${Math.max(...ps.map((p) => p.stock.pendingMax))}/${f(pm((p) => p.stock.pendingAvg))} |`,
    );
    console.log(md[md.length - 1]);
  }
  md.push('', '※ 未決着＝10分上限で打ち切り。決着時間は決着したラウンドのみ。連鎖の途切れ理由は「受付時間（12秒）切れ」と「ラウンド終了時点で継続中」の2種類（他の途切れ要因はルール上ない）。');
  const dir = new URL('../test-results/cpu-balance/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL('cpu_balance_v3.json', dir), JSON.stringify({ date: new Date().toISOString(), seeds: SEEDS, limitTicks: LIMIT_TICKS, results: out }, null, 1));
  writeFileSync(new URL('CPU_BALANCE_V3.md', dir), md.join('\n') + '\n');
});
