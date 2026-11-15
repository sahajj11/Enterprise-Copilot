const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, readFile, readdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, dirname } = require('node:path');
const { randomUUID } = require('node:crypto');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { DocumentsModule } = require('../dist/documents/documents.module');
const { DocumentsService } = require('../dist/documents/documents.service');
const { PrismaService } = require('../dist/prisma/prisma.service');
const { configureApp } = require('../dist/setup');

test('document upload HTTP integration', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'copilot-upload-test-'));
  const records = [];
  let failDatabase = false;
  const module = await Test.createTestingModule({ imports: [DocumentsModule] })
    .overrideProvider(PrismaService)
    .useValue({ document: { async create({ data }) {
      if (failDatabase) throw new Error('Simulated database failure');
      const record = { ...data, id: randomUUID(), createdAt: new Date() };
      records.push(record);
      return { id: record.id, originalName: record.originalName, size: record.size, createdAt: record.createdAt };
    } } })
    .compile();
  // Isolate filesystem effects from the application's real uploads directory.
  module.get(DocumentsService).uploadsDirectory = directory;
  const app = module.createNestApplication({ logger: false });
  configureApp(app);
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  await app.listen(0, '127.0.0.1');
  const url = `${await app.getUrl()}/documents/upload`;
  const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
  function form(content = pdf, name = 'report.pdf', type = 'application/pdf', field = 'file') {
    const data = new FormData();
    data.append(field, new Blob([content], { type }), name);
    return data;
  }
  const upload = (body) => fetch(url, { method: 'POST', body });

  await t.test('stores bytes and metadata with unique safe filenames and returns only public fields', async () => {
    for (let i = 0; i < 2; i++) {
      const response = await upload(form(pdf, '../../report.pdf'));
      assert.equal(response.status, 201);
      const result = await response.json();
      const saved = records[i];
      assert.deepEqual(result, {
        id: saved.id, originalName: 'report.pdf', size: pdf.length,
        createdAt: saved.createdAt.toISOString(),
      });
      assert.match(saved.filename, /^[0-9a-f-]{36}\.pdf$/);
      assert.equal(dirname(saved.filePath), directory);
      assert.equal(saved.mimeType, 'application/pdf');
      assert.deepEqual(await readFile(saved.filePath), pdf);
    }
    assert.notEqual(records[0].filename, records[1].filename);
  });

  await t.test('rejects missing files, wrong fields, non-PDF types, extensions, and forged signatures', async () => {
    for (const body of [
      new FormData(), form(pdf, 'report.pdf', 'application/pdf', 'wrong'),
      form(pdf, 'report.pdf', 'text/plain'), form(pdf, 'report.txt'),
      form(Buffer.from('not a PDF')), form(Buffer.alloc(0)),
    ]) {
      assert.equal((await upload(body)).status, 400);
    }
    assert.equal(records.length, 2);
    assert.equal((await readdir(directory)).length, 2);
  });

  await t.test('rejects multiple files without storing anything', async () => {
    const body = form();
    body.append('file', new Blob([pdf], { type: 'application/pdf' }), 'second.pdf');
    assert.equal((await upload(body)).status, 400);
    assert.equal((await readdir(directory)).length, 2);
    assert.equal(records.length, 2);
  });

  await t.test('rejects files above 10 MB with HTTP 413', async () => {
    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1);
    pdf.copy(oversized);
    assert.equal((await upload(form(oversized))).status, 413);
    assert.equal((await readdir(directory)).length, 2);
    assert.equal(records.length, 2);
  });

  await t.test('deletes the stored file if metadata persistence fails', async () => {
    failDatabase = true;
    const response = await upload(form());
    assert.equal(response.status, 500);
    assert.deepEqual((await readdir(directory)).sort(), records.map(record => record.filename).sort());
    assert.equal(records.length, 2);
  });
});
