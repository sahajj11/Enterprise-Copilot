const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { PDFParse, PasswordException } = require('pdf-parse');
const { DocumentsModule } = require('../dist/documents/documents.module');
const { PrismaService } = require('../dist/prisma/prisma.service');
const { RecursiveCharacterTextSplitter } = require('@langchain/textsplitters');

// Small, valid two-page PDF with a real cross-reference table; no fixture dependency.
function makePdf(texts) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${texts.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${texts.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  texts.forEach((text, i) => {
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  });
  let pdf = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test('PDF processing endpoint', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'copilot-process-test-'));
  const id = randomUUID();
  const filePath = join(directory, 'document.pdf');
  const record = { id, filePath };
  const module = await Test.createTestingModule({ imports: [DocumentsModule] })
    .overrideProvider(PrismaService)
    .useValue({ document: { findUnique: async ({ where }) => where.id === id ? record : null } })
    .compile();
  const app = module.createNestApplication({ logger: false });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  await app.listen(0, '127.0.0.1');
  const request = async (documentId = id) => fetch(`${await app.getUrl()}/documents/${documentId}/process`, { method: 'POST' });
  const chunkRequest = async (documentId = id) => fetch(`${await app.getUrl()}/documents/${documentId}/chunk`, { method: 'POST' });

  await t.test('chunk endpoint propagates invalid IDs and missing records/files', async () => {
    assert.equal((await chunkRequest('invalid')).status, 400);
    assert.equal((await chunkRequest(randomUUID())).status, 404);
    assert.equal((await chunkRequest()).status, 404);
  });

  await t.test('chunk endpoint extracts real PDF pages and returns ordered bounded chunks', async () => {
    const pages = Array.from({ length: 30 }, (_, i) => `Page ${String(i).padStart(2, '0')}: Some readable PDF text for chunking verification.`);
    await writeFile(filePath, makePdf(pages));
    const extracted = await (await request()).json();
    const response = await chunkRequest();
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.documentId, id);
    assert.equal(result.chunkSize, 1000);
    assert.equal(result.chunkOverlap, 200);
    assert.equal(result.totalChunks, result.chunks.length);
    assert.ok(result.totalChunks > 1);
    let previousStart = -1;
    for (const [index, chunk] of result.chunks.entries()) {
      assert.equal(chunk.index, index);
      assert.equal(chunk.characterCount, chunk.text.length);
      assert.ok(chunk.characterCount > 0 && chunk.characterCount <= 1000);
      const start = extracted.text.indexOf(chunk.text, previousStart + 1);
      assert.ok(start > previousStart);
      previousStart = start;
    }
  });

  await t.test('chunk endpoint handles empty PDFs, corrupt PDFs, and splitter failures', async (t) => {
    await writeFile(filePath, makePdf(['']));
    const empty = await chunkRequest();
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { documentId: id, totalChunks: 0, chunkSize: 1000, chunkOverlap: 200, chunks: [] });
    await writeFile(filePath, '%PDF-1.7\ncorrupt');
    assert.equal((await chunkRequest()).status, 422);
    await writeFile(filePath, makePdf(['Readable text']));
    t.mock.method(RecursiveCharacterTextSplitter.prototype, 'splitText', async () => { throw new Error('Splitter failure'); });
    assert.equal((await chunkRequest()).status, 500);
  });

  await t.test('returns 400 for invalid UUID and 404 for absent records or files', async () => {
    await rm(filePath, { force: true });
    assert.equal((await request('invalid')).status, 400);
    assert.equal((await request(randomUUID())).status, 404);
    assert.equal((await request()).status, 404);
  });

  await t.test('extracts all pages with the real parser and releases resources', async (t) => {
    await writeFile(filePath, makePdf(['First page content', 'Second page content']));
    const destroy = t.mock.method(PDFParse.prototype, 'destroy');
    const response = await request();
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(Object.keys(result).sort(), ['characterCount', 'documentId', 'pageCount', 'text']);
    assert.equal(result.documentId, id);
    assert.equal(result.pageCount, 2);
    assert.match(result.text, /First page content/);
    assert.match(result.text, /Second page content/);
    assert.equal(result.characterCount, result.text.length);
    assert.equal(destroy.mock.callCount(), 1);
  });

  await t.test('returns empty text for a PDF without text', async () => {
    await writeFile(filePath, makePdf(['']));
    const response = await request();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { documentId: id, pageCount: 1, text: '', characterCount: 0 });
  });

  await t.test('corrupt PDFs return 422 and release parser resources', async (t) => {
    await writeFile(filePath, '%PDF-1.7\ncorrupt');
    const destroy = t.mock.method(PDFParse.prototype, 'destroy');
    assert.equal((await request()).status, 422);
    assert.equal(destroy.mock.callCount(), 1);
  });

  await t.test('password errors and unexpected failures have appropriate status codes and cleanup', async (t) => {
    const getText = t.mock.method(PDFParse.prototype, 'getText', async () => { throw new PasswordException(); });
    const destroy = t.mock.method(PDFParse.prototype, 'destroy');
    assert.equal((await request()).status, 422);
    getText.mock.mockImplementation(async () => { throw new Error('Unexpected parser failure'); });
    assert.equal((await request()).status, 500);
    assert.equal(destroy.mock.callCount(), 2);
  });
});
