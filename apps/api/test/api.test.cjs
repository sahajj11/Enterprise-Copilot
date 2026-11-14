const assert = require('node:assert/strict');
const { test } = require('node:test');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { AppModule } = require('../dist/app.module');
const { PrismaService } = require('../dist/prisma/prisma.service');
const { configureApp } = require('../dist/setup');
const { validateEnvironment } = require('../dist/config/environment');
const { IsEmail } = require('class-validator');
const { ValidationPipe } = require('@nestjs/common');

test('GET /health returns HTTP 200 and the expected JSON', async () => {
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.PORT = '3000';
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue({})
    .compile();
  const app = module.createNestApplication();
  configureApp(app);
  try {
    await app.listen(0, '127.0.0.1');
    const response = await fetch(`${await app.getUrl()}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
    assert.equal((await fetch(`${await app.getUrl()}/missing`)).status, 404);
  } finally {
    await app.close();
  }
});

test('configured validation transforms DTOs, strips extra fields, and rejects invalid input', async () => {
  let pipe;
  configureApp({
    useGlobalPipes(value) { pipe = value; },
    enableShutdownHooks() {},
  });
  assert.ok(pipe instanceof ValidationPipe);
  class ExampleDto {}
  IsEmail()(ExampleDto.prototype, 'email');
  const metadata = { type: 'body', metatype: ExampleDto };
  const result = await pipe.transform({ email: 'user@example.com', extra: true }, metadata);
  assert.ok(result instanceof ExampleDto);
  assert.equal(result.email, 'user@example.com');
  assert.equal(Object.hasOwn(result, 'extra'), false);
  await assert.rejects(pipe.transform({ email: 'invalid' }, metadata), { status: 400 });
});

test('environment validation rejects missing URLs and invalid ports', () => {
  const DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  assert.equal(validateEnvironment({ DATABASE_URL }).PORT, 3000);
  assert.equal(validateEnvironment({ DATABASE_URL, PORT: '4000' }).PORT, 4000);
  assert.throws(() => validateEnvironment({}), /DATABASE_URL/);
  assert.throws(() => validateEnvironment({ DATABASE_URL: 'https://localhost' }), /PostgreSQL|protocol/);
  for (const PORT of ['', 'abc', '0', '65536', '3.5']) {
    assert.throws(() => validateEnvironment({ DATABASE_URL, PORT }), /PORT/);
  }
});
