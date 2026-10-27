// 検証用の固定値（受入時に照合した採用版の値）
export const CARGO_CHECK = {
  /** 第2.3版 sprite_manifest_v2.json（v1.0.0-rc1 採用）の S4〜S12 の SHA-256。第3版は同一ファイルを再利用する */
  legacySha256: {
    S4: '60df1bbea86ec1ccf4f2e36c896687372a9edb79603421f98a499f7ce4d5a758',
    S5: '6a637ca1b6b0ba575f0340c7070d3846ae198431d868563f019034293c30d161',
    S6: 'eab8e0b7a5c44b9e95ac2dd22d41576be9e61145c0efc544356b009553fd19c6',
    // v3.2.0：S7（役名）・S9（告知）はグラフィック修正 r2／r1 を採用（下の v320Sha256）。第2.3版の値は記録として残す
    S7: 'd43012d7440fc95f1605b44560ef19f5190641c3539f7c8ad82b0f3d20cb394a',
    S8: 'a9d50a097faacc00875deb23f940f1d0d6c61a868db61ae736eafef08d8d027e',
    S9: 'acd728bac72d496734a8a98e67707562e16c665a6f51312b1b79c60f5a26fb45',
    S10: '6bc8456cbe99b3cb52f0881ed518b07638ad541c9364ae90a247a371c2d10805',
    S11: 'ae89e2cc0075b45e5ad39caf6798f1d983e9b1529982ae3787dfbd601cfc40c9',
    S12: '7a7586a355fb6fb3d53c806477702fc3273b0162f5e166b827d3c75fa0aa52aa',
  } as Record<string, string>,
  /** v3.2.0 グラフィック修正の採用版（S7＝r2 の role_name_sheet、S9＝r1 の announcements_sheet） */
  v320Sha256: {
    S7: '4624e5da4bd92c9c54f568ebebb9d2aaa5b5fabc97b57448f7f2c6aca08c83ca',
    S9: 'af28895d4c9902869ef2d66c3ab6f9c6eb0ce1df27978615855237df74d40da6',
  } as Record<string, string>,
};
