const assert = require('node:assert/strict');
const { test } = require('node:test');
const { chunkText } = require('../dist/documents/text-chunking');

test('empty and short text produce zero or one chunk', async () => {
  assert.deepEqual(await chunkText(' \n\t'), []);
  assert.deepEqual(await chunkText('Short text'), [{ index: 0, text: 'Short text', characterCount: 10 }]);
});

test('long unbroken text preserves order with 1000-character chunks and 200-character overlap', async () => {
  const text = Array.from({ length: 2500 }, (_, i) => String.fromCharCode(33 + i % 90)).join('');
  const chunks = await chunkText(text);
  assert.deepEqual(chunks.map(chunk => chunk.characterCount), [1000, 1000, 900]);
  chunks.forEach((chunk, index) => {
    assert.equal(chunk.index, index);
    assert.equal(chunk.text, text.slice(index * 800, index * 800 + 1000));
    assert.equal(chunk.characterCount, chunk.text.length);
    if (index > 0) assert.equal(chunks[index - 1].text.slice(-200), chunk.text.slice(0, 200));
  });
});

test('paragraph boundaries preserve order and can produce less than 200 characters of overlap', async () => {
  const paragraphs = ['A'.repeat(600), 'B'.repeat(600), 'C'.repeat(600)];
  const chunks = await chunkText(paragraphs.join('\n\n'));
  assert.deepEqual(chunks.map(chunk => chunk.text), paragraphs);
  assert.ok(chunks.every(chunk => chunk.characterCount <= 1000));
});
