# Day 3 — Text Extraction Service

## What was built

- **`src/services/extraction.ts`** — `extractText(filePath)` reads a PDF from disk, runs it through `unpdf`, and returns a typed discriminated-union result: either `{ status: 'success', text, pageCount }` or `{ status: 'extraction_failed', reason }`. It never throws.
- **`src/repositories/`** — a `DocumentRepository` interface with a `save` / `findById` contract, and `InMemoryDocumentRepository` as the current implementation. Injected into routes via Fastify plugin options. Replaced by a `MongoDocumentRepository` in Week 2 without touching route code.
- **Upload route updated** (`src/routes/documents.ts`) — after streaming the file to disk, extraction is called immediately. The result is stored in the document store and an `extraction` summary is included in the `201` response (page count on success, reason on failure — full text is not in the upload response to keep it lean).
- **`GET /documents/:id`** — returns the full document record including the complete extracted text. This is the endpoint Day 4's classifier will call to get the text to classify.
- **Schema updates** (`src/schemas/document.ts`) — `uploadResponseSchema` now includes an `extraction` field (summary only); `documentDetailSchema` is added for the GET endpoint (includes full text).
- **`src/__tests__/extraction.test.ts`** — 3 unit tests: valid PDF extracts text and page count, corrupt bytes return a typed `extraction_failed` (not a throw), missing file returns `extraction_failed` with `ENOENT` in the reason.

## Why it's built this way

- **Typed result instead of throw**: a corrupt or image-only PDF is expected input, not an exceptional condition. Returning `{ status: 'extraction_failed', reason }` means callers can pattern-match on the outcome without wrapping in try/catch everywhere. This is the pattern that enables the "ambiguous → human review queue" routing later in the month.
- **No text in the upload response**: the full extracted text can be large (think 30-page claim form). The upload response returns just the page count as confirmation; the full text lives in the store and is served by `GET /documents/:id`. Day 4's classification endpoint will fetch it from there.
- **In-memory store now, MongoDB later**: wiring Mongo in on Day 3 would pull in connection management, error handling, and schema migration concerns before the core extraction logic is even stable. The repository interface is designed so the implementation can be swapped to a Mongo-backed version without touching any route code.
- **Repository pattern for swappability**: `DocumentRepository` is a TypeScript interface; `InMemoryDocumentRepository` implements it. The route plugin receives the concrete implementation via options (Fastify's DI mechanism), so it only depends on the interface — not on any specific store.

## .NET parallel

Both patterns here map directly to idiomatic .NET:

- **Typed result instead of throw** — equivalent to returning a `OneOf<ExtractionSuccess, ExtractionFailure>` or using a `Result<T>` type (e.g. `FluentResults`). The same reasoning applies: expected failure cases (corrupt file, missing text) shouldn't be exceptions; they should be first-class return values that callers can switch on.
- **Repository pattern** — identical to the standard .NET pattern: `IDocumentRepository` interface, `InMemoryDocumentRepository` and `MongoDocumentRepository` as implementations, registered in the DI container (`services.AddScoped<IDocumentRepository, InMemoryDocumentRepository>()`). Here, Fastify's plugin-options object replaces the DI container — the route plugin declares what it needs (`repo: DocumentRepository`), and `server.ts` provides it at registration time.

## Verified manually

- Valid PDF upload → `201` with `extraction: { status: 'success', pageCount: 1 }`.
- `GET /documents/:id` → full record with extracted text included.
- Corrupt file upload → `201` with `extraction: { status: 'extraction_failed', reason: 'Invalid PDF structure.' }` — no 500, no unhandled throw.
- `pnpm test` — 6 tests passing (3 env + 3 extraction).
