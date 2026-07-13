// src/services/embeddingGenerator.ts
//
// The interface for turning a piece of text into an embedding vector —
// mirrors EmbeddingRepository's role (see src/repositories/embeddingRepository.ts):
// an interface here describes *what* the rest of the app can do (turn text
// into a vector), and concrete classes elsewhere (MockEmbeddingGenerator,
// BedrockEmbeddingGenerator) describe *how* it's actually done. Routes and
// services depend only on this interface, never on a concrete generator directly.
//
// WHY THIS EXISTS AT ALL — the sync-to-async ripple:
// Through Day 1/2, embedding generation was a single plain function,
// `generateMockEmbedding(text) => number[]` — synchronous, no interface
// needed, because it never touched the network. A real Bedrock call is
// network I/O, which means it can only ever return `Promise<number[]>`, not
// `number[]` directly. That's not a detail an interface can hide — every
// caller has to `await` the result regardless of how the call is implemented
// underneath. Given every call site already has to change for that reason,
// this interface exists to make the *swap itself* (mock in tests, real
// Bedrock in production) clean, rather than leaving every caller hardwired
// to one concrete implementation.
//
// .NET parallel: identical to defining an IEmbeddingGenerator and
// registering MockEmbeddingGenerator vs. BedrockEmbeddingGenerator against
// it in a DI container depending on environment (Development vs. Production)
// — the same pattern already used here for IEmbeddingRepository /
// IDocumentRepository via DocumentRouteOptions.

export interface EmbeddingGenerator {
  generate(text: string): Promise<number[]>;
}
