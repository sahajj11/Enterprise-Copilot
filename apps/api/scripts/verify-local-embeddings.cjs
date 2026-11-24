// Optional real-model smoke test. First run downloads public model files.
require('reflect-metadata');
const assert = require('node:assert/strict');
const { EmbeddingsService } = require('../dist/embeddings/embeddings.service');

(async () => {
  const service = new EmbeddingsService();
  try {
    const results = await Promise.all([
      service.embedTexts(['Enterprise knowledge search', 'Local document embeddings']),
      service.embedTexts(['Enterprise knowledge search']),
    ]);
    for (const vector of results.flat()) {
      assert.equal(vector.length, 384);
      assert.ok(vector.every(Number.isFinite));
      const norm = Math.hypot(...vector);
      assert.ok(Math.abs(norm - 1) < 0.001);
    }
    results[0][0].forEach((value, index) => assert.ok(Math.abs(value - results[1][0][index]) < 0.0001));
    console.log('Local inference passed: concurrent calls, 384 dimensions, unit normalization, stable results.');
  } finally {
    await service.onModuleDestroy();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
