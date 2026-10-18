// 自動テスト（vitest JSON）とブラウザ確認（e2e report.json）から結果一覧Markdownを生成する。
// 使い方: npx vitest run --reporter=json --outputFile=test-results/vitest.json && npm run e2e ; node scripts/test-report.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const vt = JSON.parse(readFileSync('test-results/vitest.json', 'utf8'));
const e2e = JSON.parse(readFileSync('test-results/e2e/report.json', 'utf8'));
const lines = [];
lines.push('## 自動テスト（Vitest）', '');
lines.push(`合計 ${vt.numTotalTests} 件：成功 ${vt.numPassedTests} / 失敗 ${vt.numFailedTests} / スキップ ${vt.numPendingTests}`, '');
for (const file of vt.testResults) {
  lines.push(`### ${file.name.replace(/^.*\/tests\//, 'tests/')}`, '', '| 結果 | テスト |', '|---|---|');
  for (const t of file.assertionResults) lines.push(`| ${t.status === 'passed' ? 'PASS' : t.status.toUpperCase()} | ${[...t.ancestorTitles, t.title].join(' › ').replaceAll('|', '\\|')} |`);
  lines.push('');
}
lines.push('## ブラウザ確認（Chromium・ビルド済み dist）', '');
const pass = e2e.results.filter((r) => r.pass).length;
lines.push(`実行日時 ${e2e.date}：${pass}/${e2e.results.length} PASS`, '', '| 結果 | 確認項目 | 詳細 |', '|---|---|---|');
for (const r of e2e.results) lines.push(`| ${r.pass ? 'PASS' : 'FAIL'} | ${r.name} | ${String(r.detail).replaceAll('|', '\\|').slice(0, 300)} |`);
lines.push('');
writeFileSync('test-results/TEST_RESULTS_GENERATED.md', lines.join('\n'));
console.log(`written test-results/TEST_RESULTS_GENERATED.md (${vt.numPassedTests}/${vt.numTotalTests} unit, ${pass}/${e2e.results.length} e2e)`);
