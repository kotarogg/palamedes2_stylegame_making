// 音声ファイルの一元管理（イベント→ファイル）。パスは assets/audio/ からの相対で、納品と同名・同区分（bgm／voice／sfx）。
// コード・設定の他の箇所にファイル名を書かない。引分け用 sfx_draw は未納品のため対応を持たない（無音で進行）。

export type BgmId = 'menu' | 'single' | 'versus';

export const BGM_FILES: Record<BgmId, string> = {
  menu: 'bgm/bgm_menu.wav',
  single: 'bgm/bgm_puzzle_single.wav',
  versus: 'bgm/bgm_puzzle_versus.wav',
};

/**
 * 効果音のイベントID → ファイル（第3版：audio_events_v3.csv の最新対応表で統合）。
 * 第3版で置換された旧ファイル（sfx_piece_success／sfx_role_success／sfx_chain／sfx_field_rise）は、同じイベントで二重に鳴らさないため参照しない。
 * sfx_counter.wav は第3版の新しい小破裂音（同名の旧ファイルとは別物。SHA-256 で固定）。接着音は既存 sfx_attack_row.wav をそのまま使う。
 */
export const SFX_FILES = {
  ui_move: 'sfx/sfx_ui_move.wav',
  ui_confirm: 'sfx/sfx_ui_confirm.wav',
  ui_cancel: 'sfx/sfx_ui_cancel.wav',
  ui_adjust: 'sfx/sfx_ui_adjust.wav',
  ui_invalid: 'sfx/sfx_ui_invalid.wav',
  piece_launch: 'sfx/sfx_piece_launch.wav',
  piece_reject: 'sfx/sfx_piece_reject.wav',
  piece_return: 'sfx/sfx_piece_return.wav',
  column_swap: 'sfx/sfx_column_swap.wav',
  field_rise: 'sfx/se_field_rise.wav',
  role_available: 'sfx/sfx_role_available.wav',
  role_fail: 'sfx/sfx_role_fail.wav',
  line_clear: 'sfx/sfx_line_clear.wav',
  attack_send: 'sfx/sfx_attack_send.wav',
  attack_row: 'sfx/sfx_attack_row.wav',
  counter: 'sfx/sfx_counter.wav',
  danger: 'sfx/sfx_danger.wav',
  ready: 'sfx/sfx_ready.wav',
  go: 'sfx/sfx_go.wav',
  countdown: 'sfx/sfx_countdown.wav',
  card_refresh: 'sfx/sfx_card_refresh.wav',
  level_up: 'sfx/sfx_level_up.wav',
  all_clear: 'sfx/sfx_all_clear.wav',
  stage_clear: 'sfx/sfx_stage_clear.wav',
  all_stages_clear: 'sfx/sfx_all_stages_clear.wav',
  win: 'sfx/sfx_win.wav',
  lose: 'sfx/sfx_lose.wav',
  launch_success_1: 'sfx/se_launch_success_01.wav',
  launch_success_2: 'sfx/se_launch_success_02.wav',
  launch_success_3: 'sfx/se_launch_success_03.wav',
  launch_success_4: 'sfx/se_launch_success_04.wav',
  launch_success_5: 'sfx/se_launch_success_05.wav',
  role_declare_1: 'sfx/se_role_declare_01.wav',
  role_declare_2: 'sfx/se_role_declare_02.wav',
  role_declare_3: 'sfx/se_role_declare_03.wav',
  role_declare_4: 'sfx/se_role_declare_04.wav',
  role_declare_5: 'sfx/se_role_declare_05.wav',
  character_fall: 'sfx/se_character_fall.wav',
  result_cracker: 'sfx/se_result_cracker.wav',
} as const;

export type SfxId = keyof typeof SFX_FILES;

export const SFX_IDS = Object.keys(SFX_FILES) as SfxId[];

export const sfxFile = (id: SfxId): string => SFX_FILES[id];

/** 5段階SE：連続回数1〜5へ対応、6以上は5（第3版 第12章）。途切れた状態（0）は呼ばない */
export const stageOf = (count: number): 1 | 2 | 3 | 4 | 5 => Math.max(1, Math.min(5, Math.floor(count))) as 1 | 2 | 3 | 4 | 5;
export const launchSuccessSfx = (streak: number): SfxId => `launch_success_${stageOf(streak)}`;
export const roleDeclareSfx = (chain: number): SfxId => `role_declare_${stageOf(chain)}`;

/**
 * 結果・クリアの効果音。ゲーム終了時の「鳴り残りの停止」（AudioBus.stopPlaySounds）の対象外とし、終端まで鳴らす。
 * 次ラウンド・再戦・メニュー復帰（stopEffects）では止める。
 */
export const RESULT_SFX: ReadonlySet<SfxId> = new Set<SfxId>(['stage_clear', 'all_stages_clear', 'all_clear', 'win', 'lose', 'character_fall', 'result_cracker']);

/** 効果音ごとの最短再発音間隔（ms）。同じイベントIDの同一フレーム重複は AudioBus 側で1回にまとめる */
export const SFX_MIN_INTERVAL_MS: Partial<Record<SfxId, number>> = {
  ui_adjust: 60,
  ui_move: 40,
  danger: 1000,
  piece_launch: 30,
  field_rise: 60,
};

export type Character = 'kotaro' | 'akane' | 'zunko';

/** 第3版：選択できる3キャラ（キャラクター選択の並び：左からコタロー／アカネ／ずん子） */
export const CHARACTERS: readonly Character[] = ['kotaro', 'akane', 'zunko'];

export type VoiceLine = 'attack' | 'damage' | 'role_fail' | 'win' | 'lose' | 'ready' | 'go' | 'select' | `role_${string}`;

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
  'select',
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

/**
 * 必須音源の重複なし一覧（第3版：BGM3・SE39・ボイス72＝114本）。読み込み対象（旧版・原音・試聴・候補は含めない）。
 * 本数は固定値ではなく、この一覧から算出する。
 */
export function allAudioFiles(): string[] {
  const out = new Set<string>([...Object.values(BGM_FILES), ...SFX_IDS.map(sfxFile)]);
  for (const c of CHARACTERS) for (const l of VOICE_LINES) out.add(voiceFile(c, l));
  return [...out];
}
