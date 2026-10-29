// V320-FIX-05 第6.3節 役名と読み上げの対応記録：npx vitest run --config tools/vitest.measure.config.ts tools/role-voice.measure.ts
// 本編の Game・RoleNameDirector・AudioBus（Node：再生は要求の記録だけ）で、宣言ごとに
// ロゴR番号・正式役名・代表ボイスのファイル・再生要求の時刻・各ロゴの描画開始／終了を対応させて docs/v320f05/role_voice_log.json へ出す。
// 聴感（実際に聞こえた内容）は確認できない。ファイル尺は素材のWAVヘッダから読む（存在する場合）。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { AudioBus, DEFAULT_MIX } from '../src/audio/audioBus';
import type { Character } from '../src/audio/audioMap';
import type { Game } from '../src/core/game';
import { pieceKind, TUTORIAL_SCRIPT } from '../src/demo/lesson';
import { RoleNameDirector } from '../src/view/presentation';
import { makeGame, rows, toPlay } from '../tests/helpers';

const NAMES = TUTORIAL_SCRIPT.role_list.roles.map((r) => r.name);
const MS = 1000 / 60;

function wavSec(path: string): number | null {
  if (!existsSync(path)) return null;
  const b = readFileSync(path);
  let off = 12;
  let rate = 0;
  let ch = 0;
  let bits = 0;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const sz = b.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      ch = b.readUInt16LE(off + 10);
      rate = b.readUInt32LE(off + 12);
      bits = b.readUInt16LE(off + 22);
    }
    if (id === 'data') return Math.round((sz / (rate * ch * (bits / 8))) * 1000) / 1000;
    off += 8 + sz + (sz % 2);
  }
  return null;
}

interface Scenario {
  name: string;
  chars: [Character, Character];
  altPct: number;
  /** [tick後, player, 手役] の宣言。'result' は勝敗確定 */
  steps: { after: number; player?: 0 | 1; stock?: string[]; result?: true }[];
  voiceMute?: boolean;
}

function run(s: Scenario) {
  let now = 0;
  const g = makeGame({ boards: { 0: rows(6), 1: rows(6) } });
  const bus = new AudioBus('./', DEFAULT_MIX, () => now);
  if (s.voiceMute) bus.setVolumes({ bgm: 100, sfx: 100, voice: 0, bgmMute: false, sfxMute: false, voiceMute: true });
  const d = new RoleNameDirector(g as Game, bus, s.chars, undefined, 7, s.altPct);
  toPlay(g);
  const draws: { tick: number; player: number; logos: string[] }[] = [];
  const tick = () => {
    g.step([]);
    now = g.tick * MS;
    d.update();
    for (const p of [0, 1] as const) {
      const v = d.logosAt(p, g.tick);
      const prev = draws.filter((x) => x.player === p).at(-1);
      const cur = v.map((x) => `R${String(x.logo + 1).padStart(2, '0')}`);
      if (!prev || prev.logos.join() !== cur.join()) draws.push({ tick: g.tick, player: p, logos: cur });
    }
  };
  for (const st of s.steps) {
    for (let i = 0; i < st.after; i++) tick();
    if (st.result) (g as unknown as { result: unknown }).result = { winner: 0, tick: g.tick, outcome: 'win' };
    else {
      g.players[st.player!].roleStock = st.stock!.map((c) => g.factory.make(pieceKind(c).n, pieceKind(c).suit));
      g.players[st.player!].roleReady = true;
      g.step([{ player: st.player!, type: 'declare' }]);
      now = g.tick * MS;
      d.update();
    }
  }
  for (let i = 0; i < 120; i++) tick();
  const voices = bus.log.filter((e) => e.kind === 'voice').map((e) => ({ t: Math.round(e.t), tick: Math.round(e.t / MS), id: e.id, skipped: e.skipped ?? null }));
  return {
    name: s.name,
    declares: d.showLog.map((x) => ({
      ...x,
      names: x.logos.map((l) => NAMES[Number(l.slice(1)) - 1]),
      fileSec: wavSec(`public/assets/audio/${x.voiceFile}`),
      voiceRequest: voices.find((v) => v.tick === x.declareTick && v.id.startsWith(s.chars[x.player])) ?? null,
    })),
    voices,
    drawChanges: draws,
  };
}

it('role-voice log', () => {
  const scenarios: Scenario[] = [
    { name: '単役（フォーカード）・代替なし', chars: ['kotaro', 'akane'], altPct: 0, steps: [{ after: 0, player: 0, stock: ['4s', '4h', '4s', '4h'] }] },
    { name: '数字役＋属性役（フォーカード＋フォーブラック）', chars: ['kotaro', 'akane'], altPct: 0, steps: [{ after: 0, player: 0, stock: ['4s', '4c', '4s', '4c'] }] },
    { name: '専用複合（スーパーストレートフラッシュ、コタロー長い音声3.48秒）', chars: ['kotaro', 'akane'], altPct: 0, steps: [{ after: 0, player: 0, stock: ['1c', '2c', '3c', '4c', '5c', '6c'] }] },
    { name: '代替ボイスあり（100%：攻撃ボイス）', chars: ['zunko', 'akane'], altPct: 100, steps: [{ after: 0, player: 0, stock: ['4s', '4c', '4s', '4c'] }] },
    { name: '左右同時宣言', chars: ['akane', 'zunko'], altPct: 0, steps: [{ after: 0, player: 0, stock: ['2s', '3h', '4s', '5h'] }, { after: 0, player: 1, stock: ['1h', '3d', '5h', '6d'] }] },
    { name: '次の宣言（同じプレイヤー。役処理中は宣言できないため、役処理の終了後＝前の表示の終了後）', chars: ['kotaro', 'akane'], altPct: 0, steps: [{ after: 0, player: 0, stock: ['4s', '4c', '4s', '4c'] }, { after: 160, player: 0, stock: ['2d', '3d', '5d', '6d'] }] },
    { name: '相手の宣言が自分の表示中に入る（左右は独立）', chars: ['kotaro', 'akane'], altPct: 0, steps: [{ after: 0, player: 0, stock: ['4s', '4c', '4s', '4c'] }, { after: 20, player: 1, stock: ['2d', '3d', '5d', '6d'] }] },
    { name: '勝敗の割込み', chars: ['kotaro', 'akane'], altPct: 0, steps: [{ after: 0, player: 0, stock: ['4s', '4c', '4s', '4c'] }, { after: 20, result: true }] },
    { name: 'ボイス無効（音量0・ミュート）', chars: ['kotaro', 'akane'], altPct: 0, voiceMute: true, steps: [{ after: 0, player: 0, stock: ['4s', '4c', '4s', '4c'] }] },
  ];
  const durations: Record<string, (number | null)[]> = {};
  for (const c of ['kotaro', 'akane', 'zunko']) durations[c] = NAMES.map((_, i) => wavSec(`public/assets/audio/voice/voice_${c}_role_${String(i + 1).padStart(2, '0')}.wav`));
  writeFileSync(
    new URL('../docs/v320f05/role_voice_log.json', import.meta.url),
    JSON.stringify({ id: 'V320-FIX-05', note: 'Node での再生要求の記録（実音は再生していない）。tick は60Hz。聴感は未確認', mapping: NAMES.map((n, i) => ({ logo: `R${String(i + 1).padStart(2, '0')}`, name: n, voiceLine: `role_${String(i + 1).padStart(2, '0')}` })), roleVoiceSec: durations, scenarios: scenarios.map(run) }, null, 1),
  );
});
