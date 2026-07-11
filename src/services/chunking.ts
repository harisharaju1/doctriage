// src/services/chunking.ts
//
// Splits a document's extracted text into smaller, overlapping pieces
// ("chunks") suitable for embedding individually — see docs/week-2-day-2.md
// for the full "why chunk at all" background. Short version: an embedding of
// an entire multi-page document is a blurry average of everything in it; an
// embedding of one focused paragraph represents that paragraph's meaning
// much more precisely, which is what makes retrieval actually find the right
// answer later.
//
// WHY WORD COUNT, NOT A REAL TOKENIZER?
// Real embedding models measure text in "tokens" (sub-word units from a
// specific tokenizer, e.g. byte-pair encoding) — not words. A word count and
// a token count for the same text are close, but not identical. Wiring in a
// real tokenizer is a reasonable future refinement, but it's an extra
// dependency that doesn't change the actual chunking *mechanics* being built
// today: split, overlap, store, retrieve. Word count proves the same pipeline
// shape with one fewer moving part — worth revisiting once Day 3's real
// embedding model makes precise chunk-size tuning actually matter.

export interface Chunk {
  text: string;
  index: number;
}

export interface ChunkingOptions {
  // How many words each chunk holds, at most.
  chunkSizeWords?: number;
  // How many trailing words from the previous chunk are repeated at the
  // start of the next one. This is the mitigation for the "the answer spans
  // a chunk boundary" problem described in the Day 2 plan doc: if a fact
  // spans a boundary, overlap makes it likely to appear whole in at least
  // one chunk, even though it's split across two others.
  overlapWords?: number;
}

const DEFAULT_CHUNK_SIZE_WORDS = 300;
const DEFAULT_OVERLAP_WORDS = 50;

export function chunkText(text: string, options: ChunkingOptions = {}): Chunk[] {
  const chunkSizeWords = options.chunkSizeWords ?? DEFAULT_CHUNK_SIZE_WORDS;
  const overlapWords = options.overlapWords ?? DEFAULT_OVERLAP_WORDS;

  if (overlapWords >= chunkSizeWords) {
    // If overlap were >= chunk size, the sliding window below would never
    // advance (or would go backwards) — this is a programming error in how
    // the function was called, not a runtime condition to handle gracefully,
    // so it throws rather than silently looping forever or producing
    // nonsensical chunks.
    throw new Error('overlapWords must be smaller than chunkSizeWords');
  }

  // Splitting on whitespace is intentionally simple — this is word COUNTING
  // for chunk-sizing purposes, not real tokenization or linguistic word
  // boundaries (it won't handle every language's word-separation rules
  // correctly, for instance). Good enough for the pipeline-shape goal today.
  const words = text.trim().split(/\s+/).filter((word) => word.length > 0);

  if (words.length === 0) {
    // Empty or whitespace-only text produces zero chunks — not one chunk
    // containing nothing. A chunk with no content would still get embedded
    // and stored, which is pure noise: it can never usefully match a real
    // query, but it does cost a row in Postgres and a wasted embedding call.
    return [];
  }

  // How far the window slides forward each step. Sliding by exactly
  // (chunkSizeWords - overlapWords) means each new chunk starts overlapWords
  // words before the previous chunk ended — the sliding-window-with-overlap
  // pattern described in the Day 2 plan doc.
  const stride = chunkSizeWords - overlapWords;

  const chunks: Chunk[] = [];
  let index = 0;

  for (let start = 0; start < words.length; start += stride) {
    const end = Math.min(start + chunkSizeWords, words.length);
    chunks.push({ text: words.slice(start, end).join(' '), index });
    index += 1;

    // If this chunk already reached the end of the text, stop — without this
    // check, a short final stride could otherwise produce one more chunk
    // that's entirely a re-repeat of the tail already covered by the
    // previous chunk (pure duplication, no new content).
    if (end === words.length) {
      break;
    }
  }

  return chunks;
}
