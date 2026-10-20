// 表示倍率の選択（論理640×360を整数倍で表示。画面外にはみ出す倍率は使わない）
const W = 640;
const H = 360;

/** 表示倍率：0＝収まる最大の整数倍。指定倍率が収まらなければ収まる最大の整数倍（1倍も収まらなければ縮小） */
export function chooseScale(want: number, vw: number, vh: number): number {
  const fit = Math.min(vw / W, vh / H);
  const maxInt = Math.floor(fit);
  if (maxInt < 1) return fit;
  return want === 0 ? maxInt : Math.min(want, maxInt);
}
