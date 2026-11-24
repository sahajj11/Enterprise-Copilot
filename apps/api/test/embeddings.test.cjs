const assert = require('node:assert/strict');
const { test } = require('node:test');
require('reflect-metadata');
const { EmbeddingsService } = require('../dist/embeddings/embeddings.service');

function fakePipeline() {
  const calls = [];
  const pipeline = async (texts, options) => {
    calls.push({ texts, options });
    return { tolist: () => texts.map(() => [1, ...Array(383).fill(0)]) };
  };
  pipeline.dispose = async () => {};
  return { pipeline, calls };
}

test('concurrent requests share initialization, preserve batching/order, and dispose once', async (t) => {
  const service = new EmbeddingsService();
  const { pipeline, calls } = fakePipeline();
  let loads = 0;
  service.createPipeline = async () => { loads++; await new Promise(resolve => setImmediate(resolve)); return pipeline; };
  const dispose = t.mock.method(pipeline, 'dispose');
  const texts = Array.from({ length: 35 }, (_, i) => `chunk ${i}`);
  const [vectors, other] = await Promise.all([service.embedTexts(texts), service.embedTexts(['other'])]);
  assert.equal(loads, 1);
  assert.equal(vectors.length, 35);
  assert.equal(other[0].length, 384);
  assert.deepEqual(calls.filter(call => call.texts[0] !== 'other').flatMap(call => call.texts), texts);
  assert.ok(calls.every(call => call.texts.length <= 16 && call.options.pooling === 'mean' && call.options.normalize));
  await service.onModuleDestroy();
  assert.equal(dispose.mock.callCount(), 1);
});

test('empty input avoids initialization and failed initialization can be retried', async () => {
  const service = new EmbeddingsService();
  service.logger = { error() {} };
  let loads = 0;
  service.createPipeline = async () => { loads++; throw new Error('load failed'); };
  assert.deepEqual(await service.embedTexts([]), []);
  assert.equal(loads, 0);
  const failures = await Promise.allSettled([service.embedTexts(['one']), service.embedTexts(['two'])]);
  assert.equal(loads, 1);
  assert.ok(failures.every(result => result.status === 'rejected' && result.reason.getStatus() === 503));
  service.createPipeline = async () => fakePipeline().pipeline;
  assert.equal((await service.embedTexts(['retry']))[0].length, 384);
  await service.onModuleDestroy();
});

test('inference errors and invalid dimensions return 500', async () => {
  for (const pipeline of [
    async () => { throw new Error('inference failed'); },
    async () => ({ tolist: () => [[1, 2]] }),
    async () => ({ tolist: () => [Array(384).fill(NaN)] }),
  ]) {
    const service = new EmbeddingsService();
    service.logger = { error() {} };
    service.createPipeline = async () => pipeline;
    await assert.rejects(service.embedTexts(['text']), error => error.getStatus() === 500);
  }
});
