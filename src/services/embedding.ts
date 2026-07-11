// src/services/embedding.ts
//
// WHAT IS AN EMBEDDING?
// An embedding is a list of numbers that represents a piece of text's
// *meaning* in a way that's comparable geometrically. Two pieces of text
// with similar meaning produce two number-lists that sit close together in
// that (here, 1536-dimensional) space; unrelated text produces number-lists
// that sit far apart. That's what makes semantic search possible — you're
// comparing meaning, not matching keywords.
//
// WHY A MOCK GENERATOR TODAY, NOT A REAL EMBEDDING API?
// Today's job (Week 2 Day 1) is proving that the pgvector *plumbing* works —
// insert a vector, ask "what's nearest?", get a sane answer back. That's a
// mechanical correctness question, answerable with any vector that behaves
// consistently, without needing real semantic understanding. Wiring a real
// embedding model (AWS Bedrock Titan) is a deliberately separate, later task
// (Day 3) — bringing in a second new external API (auth, SDK, error
// handling) on the same day as the database plumbing would blur what each
// day is actually testing.
//
// WHY NOT JUST HASH THE WHOLE STRING (e.g. SHA-256 of the full text)?
// That was the first instinct here, but it's actually wrong: cryptographic
// hashes are deliberately designed so that a tiny change to the input
// produces a completely different output (the "avalanche effect") — two
// near-identical sentences would hash to two *unrelated* vectors. That would
// make it impossible to write a meaningful test asserting "similar text
// ranks closer than different text," which is the entire point of today's
// round-trip proof.
//
// WHAT THIS DOES INSTEAD: A "HASHING TRICK" BAG-OF-WORDS VECTOR
// This is a real (if simplistic) technique used in classic NLP, sometimes
// called "feature hashing" (used by tools like Vowpal Wabbit and scikit-
// learn's HashingVectorizer): split the text into individual words, hash
// EACH WORD separately to pick one of the 1536 dimensions, and nudge that
// dimension up or down. The result: two texts that share several words end
// up with several of the *same* dimensions nudged, which makes their vectors
// point in a more similar direction — i.e. a smaller cosine distance — while
// two texts sharing no words end up with entirely different dimensions
// touched, and no particular directional similarity. It's a crude stand-in
// for "shared vocabulary implies related meaning," which is enough to
// exercise real nearest-neighbor ordering without calling a real model.
//
// This entire function is intentionally isolated behind one small, stable
// signature — `generateMockEmbedding(text) => number[]` — so that Day 3 can
// replace everything inside this file with a real Bedrock API call without
// any other file (the repository, the schema, or this file's callers)
// needing to change at all.

import { createHash } from 'node:crypto';

// Matches schema.sql's `vector(1536)` column — chosen to match Amazon Titan
// Embeddings v2's typical output dimension, so swapping in the real thing on
// Day 3 doesn't require a schema change.
const EMBEDDING_DIMENSIONS = 1536;

export function generateMockEmbedding(text: string): number[] {
  const embedding = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);

  // Lowercase + split on anything that isn't a letter/digit, so "Claim." and
  // "claim" are treated as the same word — real embedding models do a
  // version of this too (tokenization), just far more sophisticated.
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

  for (const word of words) {
    const hash = createHash('sha256').update(word).digest();

    // Use the hash's first 4 bytes as a big number, then mod down into
    // [0, 1536) — this deterministically picks "which dimension does this
    // word affect," spread roughly evenly across all 1536 dimensions.
    const dimension = hash.readUInt32BE(0) % EMBEDDING_DIMENSIONS;

    // Use one more bit of the hash to decide whether this word nudges its
    // dimension up or down. Without this, every word would only ever push
    // vectors in the positive direction, which would make most vectors end
    // up pointing roughly the same way regardless of content — the sign
    // adds enough spread that unrelated word sets actually end up far apart.
    const sign = (hash[4]! & 1) === 0 ? 1 : -1;

    // Non-null assertion is safe here: `embedding` was created with a fixed
    // length and `.fill(0)`, and `dimension` is always in [0, 1536) thanks
    // to the modulo above — every index is guaranteed to already hold a
    // number. TypeScript's noUncheckedIndexedAccess can't know that though,
    // since it treats every array index access as possibly out of bounds.
    embedding[dimension]! += sign;
  }

  return embedding;
}
