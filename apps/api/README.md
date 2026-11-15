# Enterprise Knowledge Copilot API

Minimal NestJS 12 / TypeScript API with Prisma ORM 7.10.1 and PostgreSQL. Requires Node.js 22.12+ (22.x) or 24.x and npm. Node 24 is recommended. Run all commands below from `apps/api`.

## Install and configure

```sh
npm ci
```

Copy `.env.example` to `.env` if `.env` does not exist (PowerShell: `Copy-Item .env.example .env`; macOS/Linux: `cp .env.example .env`). The initial local `.env` contains placeholders, not working credentials. Replace `YOUR_USER`, `YOUR_PASSWORD`, host, port, and database name with your local PostgreSQL details. URL-encode special characters in credentials. `.env` is ignored by Git; do not commit real credentials. Process environment variables take precedence over `.env`.

Install and start PostgreSQL locally and create the `enterprise_copilot` development database using your preferred PostgreSQL administration tool. No PostgreSQL server is bundled with this project.

On Windows, if PowerShell blocks `npm.ps1`, use `npm.cmd` (and `npx.cmd`) instead of changing your execution policy.

## Generate and migrate

```sh
npm run prisma:generate
npm run prisma:migrate -- --name init
npm run start:dev
```

`prisma:generate` creates the TypeScript client and does not connect to PostgreSQL. `prisma:migrate` **requires your real local PostgreSQL credentials in DATABASE_URL and a running server**. It creates and applies a migration for the `User` model; commit the resulting `prisma/migrations` directory. Prisma development migrations also use a shadow database, so the local development role needs permission to create databases (or a separately configured shadow database). Review any reset prompt before proceeding if your development database already contains data.

After future schema changes, run `npm run prisma:migrate -- --name describe_change`, then `npm run prisma:generate`. Prisma 7 migrations do not automatically generate the client. The development and build scripts generate it automatically.

The server defaults to port 3000 (`PORT` can override it). `GET http://localhost:3000/health` returns `{"status":"ok"}`. Startup connects to PostgreSQL and fails if it cannot connect. This endpoint is a process liveness check, not an ongoing database readiness check.

## Checks and production startup

```sh
npm run prisma:validate
npm run typecheck
npm test
npm run build
npm run prisma:deploy
npm start
```

Validation, type checking, generation, and tests do not require a live database. Tests cover the HTTP health endpoint, request validation, and environment validation; the HTTP test replaces Prisma with a mock. They do not verify live PostgreSQL connectivity.

`prisma:deploy` applies committed migrations and requires credentials for the **target database**; create and commit migrations in development first. `prisma:status` also requires a live database. `npm start` runs the compiled application and needs a valid runtime `DATABASE_URL`. Build with development dependencies installed; the migration job also needs the Prisma CLI, which is a development dependency. Supply production secrets through the environment.

## Document uploads

`POST /documents/upload` accepts one multipart PDF in the `file` field (maximum 10 MB = 10,485,760 bytes). The request must declare `application/pdf`, use a `.pdf` filename (case insensitive), and have the `%PDF-` signature at the start of its content. Signature validation does not parse the PDF or perform text extraction.

```sh
curl -X POST http://localhost:3000/documents/upload -F "file=@./report.pdf;type=application/pdf"
```

Use `curl.exe` in Windows PowerShell. A successful upload returns HTTP 201:

```json
{
  "id": "be630911-2a5a-4b29-9a77-654908d08682",
  "originalName": "report.pdf",
  "size": 12345,
  "createdAt": "2026-11-15T06:00:00.000Z"
}
```

Files are buffered in memory within Multer's size limit, validated, then saved to `apps/api/uploads/` (created automatically). Stored names are generated UUIDs with a `.pdf` suffix; client filenames are metadata only. The directory is ignored by Git and is not served publicly. The API needs filesystem write permission there. Metadata uses the existing `Document` model and stores an absolute local file path. A failed database write removes the uploaded file; cleanup failures are logged. Back up the upload directory alongside the database.

Missing files, invalid PDFs, extra files, and unexpected multipart fields return HTTP 400; oversized uploads return HTTP 413. Storage or database failures return HTTP 500.

The existing `20261115055914_add_documents` migration defines the table. If it has not been applied to your database, run `npm run prisma:deploy` with your PostgreSQL `DATABASE_URL` configured. No new schema migration is needed for this endpoint. Run `npm run prisma:generate` after pulling schema changes, or use the development/build scripts which generate automatically.

`npm test` also exercises multipart uploads with temporary local storage and a mocked database, including file validation, size limits, safe filenames, and cleanup on persistence failure.

## PDF text extraction

`POST /documents/:id/process` reads an existing document's local file and returns HTTP 200 with `{ documentId, pageCount, text, characterCount }`.

```sh
curl -X POST http://localhost:3000/documents/YOUR_DOCUMENT_UUID/process
```

Use `curl.exe` in PowerShell. No request body is needed. `pdf-parse` 2.x extracts text from all pages using `PDFParse.getText()`; parser resources are released with `destroy()` in a `finally` block. Page-number decorations are omitted, outer whitespace is trimmed, and `characterCount` is the returned string's JavaScript length (UTF-16 code units).

Invalid UUIDs return 400. Missing database records or local files return 404. Corrupt/invalid or password-protected PDFs return 422. Other file-read or extraction failures return 500 without exposing local file paths. PDFs without selectable text return empty text and a zero character count; no OCR is performed.

Processing does not modify uploads, store extracted text, or require a schema migration. Tests use the real parser for multi-page, empty-text, and corrupt PDFs, with mocked database lookups.

## Structure

- `src/app.module.ts`: global environment configuration and module composition.
- `src/setup.ts`: global validation (`whitelist`, `transform`) and shutdown hooks.
- `src/health.controller.ts`: liveness endpoint.
- `src/prisma/`: injectable Prisma client, connection lifecycle, and exporting module. Import `PrismaModule` into future modules that need database access.
- `prisma/schema.prisma`: PostgreSQL datasource and `User` with UUID id, unique email, creation time, and automatically maintained update time.
- `prisma7.config.ts`: Prisma 7.10 CLI configuration; loads `.env` and supplies `DATABASE_URL` outside the schema.
- `src/generated/prisma/`: ignored generated client, compiled with application source.

The client uses `prisma-client` generation with explicit CommonJS output and the `@prisma/adapter-pg` PostgreSQL adapter, following the [NestJS Prisma integration guide](https://docs.nestjs.com/recipes/prisma). Prisma packages stay on stable 7.x rather than the Prisma 8 prerelease tag. Authentication and application features are intentionally deferred.
