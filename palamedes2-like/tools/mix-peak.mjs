// 最大同時発音のミックスとクリップの波形検査（第20章「素材・音」）。聴感の検証ではない。
// 実ゲームと同じゲイン（マスター −6dB、音量100＝0dB、声中のBGM −4dB）で、同時に鳴りうる組合せを標本単位で加算し、ピーク（dBFS）を求める。
// BGM はリポジトリに無いため、作業環境では BGM を除いた値（BGM を含む値は BGM 配置環境で再計測）。
// 使い方: node tools/mix-peak.mjs [音声フォルダ=public/assets/audio]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'public/assets/audio';
const MASTER = 10 ** (-6 / 20);
const DUCK = 10 ** (-4 / 20);
const RATE = 48000;

function readWav(path) {
  const b = readFileSync(path);
  let off = 12;
  let fmt = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(off + 10), rate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    if (id === 'data') {
      if (!fmt || fmt.ch !== 1 || fmt.bits !== 16 || fmt.rate !== RATE) throw new Error(`${path}: 想定外の形式 ${JSON.stringify(fmt)}`);
      const n = size / 2;
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = b.readInt16LE(off + 8 + i * 2) / 32768;
      return out;
    }
    off += 8 + size + (size % 2);
  }
  throw new Error(`${path}: data なし`);
}
const cache = new Map();
const pcm = (rel) => {
  if (!cache.has(rel)) cache.set(rel, readWav(join(dir, rel)));
  return cache.get(rel);
};
const sfx = (f) => `sfx/${f}.wav`;
const voice = (c, l) => `voice/voice_${c}_${l}.wav`;

/** items: [ファイル, 開始ms, ゲイン] */
function mix(items) {
  const len = Math.max(...items.map(([f, ms]) => Math.round((ms / 1000) * RATE) + pcm(f).length));
  const buf = new Float32Array(len);
  for (const [f, ms, g] of items) {
    const s = pcm(f);
    const o = Math.round((ms / 1000) * RATE);
    for (let i = 0; i < s.length; i++) buf[o + i] += s[i] * g * MASTER;
  }
  let peak = 0;
  for (const x of buf) peak = Math.max(peak, Math.abs(x));
  return 20 * Math.log10(peak);
}
const singlePeak = (f) => 20 * Math.log10(pcm(f).reduce((m, x) => Math.max(m, Math.abs(x)), 0));

const scenarios = [
  {
    name: '勝敗演出（勝利SE＋敗者ボイス→落下SE→勝者ボイス＋クラッカー）',
    items: [[sfx('sfx_win'), 0, 1], [voice('akane', 'lose'), 0, 1], [sfx('se_character_fall'), 640, 1], [voice('kotaro', 'win'), 1540, 1], [sfx('se_result_cracker'), 1540, 1]],
  },
  {
    name: '同時の役宣言・攻撃（両者が同じ瞬間に宣言・攻撃・相殺・接着。役ボイス2声）',
    items: [
      [sfx('se_role_declare_05'), 0, 1], [sfx('se_role_declare_05'), 0, 1], [sfx('se_launch_success_05'), 0, 1], [sfx('se_launch_success_05'), 0, 1],
      [sfx('sfx_attack_send'), 0, 1], [sfx('sfx_counter'), 0, 1], [sfx('sfx_attack_row'), 120, 1], [sfx('sfx_line_clear'), 0, 1],
      [voice('kotaro', 'role_16'), 0, 1], [voice('zunko', 'role_16'), 0, 1],
    ],
  },
  {
    name: 'ステージ最終面クリア＋全消し同時（R3と同じ組合せ）',
    items: [[sfx('sfx_all_stages_clear'), 0, 1], [sfx('sfx_all_clear'), 0, 1], [sfx('se_launch_success_05'), 0, 1], [sfx('se_result_cracker'), 0, 1]],
  },
];
// 理論上の最悪：同時発音上限12本の SE を、ピークの大きい順に同じ瞬間へ重ねる（実際のゲームでは起きない上限値）
const allSfx = ['sfx_attack_row', 'sfx_attack_send', 'sfx_counter', 'se_role_declare_05', 'se_launch_success_05', 'sfx_line_clear', 'se_result_cracker', 'se_character_fall', 'sfx_win', 'sfx_all_clear', 'sfx_all_stages_clear', 'sfx_stage_clear', 'sfx_level_up', 'sfx_danger', 'sfx_piece_launch', 'sfx_role_available'].filter((f) => existsSync(join(dir, sfx(f))));
const worst = allSfx.map((f) => [f, singlePeak(sfx(f))]).sort((a, b) => b[1] - a[1]).slice(0, 12);
scenarios.push({ name: '理論上の最悪：ピーク上位12本のSEを同時（同時発音上限12）', items: worst.map(([f]) => [sfx(f), 0, 1]) });

const rows = scenarios.map((s) => ({ name: s.name, peakDbfs: +mix(s.items).toFixed(2), files: s.items.map(([f]) => f) }));
for (const r of rows) console.log(`${r.peakDbfs > 0 ? 'CLIP' : 'OK  '} ${r.peakDbfs.toFixed(2)} dBFS  ${r.name}`);
mkdirSync('test-results', { recursive: true });
writeFileSync('test-results/mix_peak.json', JSON.stringify({ note: '波形の加算による検査（聴感ではない）。BGM除く。マスター−6dB・音量100で計算', duckDb: -4, masterDb: -6, DUCK, rows }, null, 1));
