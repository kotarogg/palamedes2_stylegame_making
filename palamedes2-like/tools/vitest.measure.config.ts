// 計測専用（通常の npm test には含めない）：npm run measure:cpu
export default { test: { include: ['tools/**/*.measure.ts'], environment: 'node', testTimeout: 3_600_000 } };
