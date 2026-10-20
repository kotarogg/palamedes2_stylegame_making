// 音声ファイルの一元管理（イベント→ファイル）。パスは assets/audio/ からの相対で、納品と同名・同区分（bgm／voice／sfx）。
// コード・設定の他の箇所にファイル名を書かない。引分け用 sfx_draw は未納品のため対応を持たない（無音で進行）。

export type BgmId = 'menu' | 'single' | 'versus';

export const BGM_FILES: Record<BgmId, string> = {
  menu: 'bgm/bgm_menu.wav',
  single: 'bgm/bgm_puzzle_single.wav',
  versus: 'bgm/bgm_puzzle_versus.wav',
};

export const SFX_IDS = [
  'ui_move',
  'ui_confirm',
  'ui_cancel',
  'ui_adjust',
  'ui_invalid',
  'piece_launch',
  'piece_success',
  'piece_reject',
  'piece_return',
  'column_swap',
  'field_rise',
  'role_available',
  'role_success',
  'role_fail',
  'line_clear',
  'chain',
  'attack_send',
  'attack_row',
  'counter',
  'danger',
  'ready',
  'go',
  'countdown',
  'card_refresh',
  'level_up',
  'all_clear',
  'stage_clear',
  'all_stages_clear',
  'win',
  'lose',
] as const;

export type SfxId = (typeof SFX_IDS)[number];

export const sfxFile = (id: SfxId): string => `sfx/sfx_${id}.wav`;

/** 効果音ごとの最短再発音間隔（ms）。同じイベントIDの同一フレーム重複は AudioBus 側で1回にまとめる */
export const SFX_MIN_INTERVAL_MS: Partial<Record<SfxId, number>> = {
  ui_adjust: 60,
  ui_move: 40,
  danger: 1000,
  piece_launch: 30,
  piece_success: 30,
  field_rise: 60,
};

export type Character = 'kotaro' | 'akane';

/** 第1版：1P＝コタロー（S1）、2P＝琴葉茜（S2）。シングルはコタローのみ */
export const PLAYER_CHARACTER: readonly Character[] = ['kotaro', 'akane'];

export type VoiceLine = 'attack' | 'damage' | 'role_fail' | 'win' | 'lose' | 'ready' | 'go' | `role_${string}`;

/** 役名ボイス：役名ロゴの表示順R01〜R16（logo index 0〜15）に対応 */
export const roleVoiceLine = (logoIndex: number): VoiceLine => `role_${String(logoIndex + 1).padStart(2, '0')}`;

export const voiceFile = (c: Character, line: VoiceLine): string => `voice/voice_${c}_${line}.wav`;

export const VOICE_LINES: readonly VoiceLine[] = [
  'attack',
  'damage',
  'role_fail',
  'win',
  'lose',
  'ready',
  'go',
  ...Array.from({ length: 16 }, (_, i) => roleVoiceLine(i)),
];

/** 通常の声の優先度（補完：結果＞開始＞役名＞攻撃・被攻撃＞不成立）。低い声は鳴っている高い声を切らない */
export const VOICE_PRIORITY: Record<'result' | 'start' | 'role' | 'attack' | 'fail', number> = {
  result: 50,
  start: 40,
  role: 30,
  attack: 20,
  fail: 10,
};

/** 必須79本（BGM3・SE30・ボイス46）。読み込み対象の一覧（旧版・候補・原曲・プレビューは含めない） */
export function allAudioFiles(): string[] {
  const out: string[] = [...Object.values(BGM_FILES), ...SFX_IDS.map(sfxFile)];
  for (const c of PLAYER_CHARACTER) for (const l of VOICE_LINES) out.push(voiceFile(c, l));
  return out;
}
