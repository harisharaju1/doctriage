import { describe, expect, it } from 'vitest';
import { chunkText } from '../services/chunking.js';

// A word repeated with a numbered suffix makes it trivial to see exactly
// which words ended up in which chunk when debugging a failing assertion —
// e.g. "word47" makes a boundary obvious at a glance, "the the the..." doesn't.
function makeWords(count: number): string {
  return Array.from({ length: count }, (_, i) => `word${i}`).join(' ');
}

describe('chunkText', () => {
  it('returns zero chunks for empty text', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\t  ')).toEqual([]);
  });

  it('returns exactly one chunk when text is shorter than the chunk size', () => {
    const text = makeWords(50);
    const chunks = chunkText(text, { chunkSizeWords: 300, overlapWords: 50 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.index).toBe(0);
    expect(chunks[0]!.text).toBe(text);
  });

  it('splits long text into multiple chunks with the expected count', () => {
    const text = makeWords(700);
    const chunks = chunkText(text, { chunkSizeWords: 300, overlapWords: 50 });

    // stride = 300 - 50 = 250. Chunk starts: 0, 250, 500 (500+300=800 > 700,
    // clamped to 700, and 700 === words.length so the loop stops there) — 3 chunks.
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
  });

  it('overlaps consecutive chunks by the configured word count, without dropping text', () => {
    const text = makeWords(700);
    const chunks = chunkText(text, { chunkSizeWords: 300, overlapWords: 50 });

    const chunk0Words = chunks[0]!.text.split(' ');
    const chunk1Words = chunks[1]!.text.split(' ');

    // Chunk 0 covers word0..word299. Chunk 1 covers word250..word549 — so the
    // last 50 words of chunk 0 (word250..word299) should be exactly the
    // first 50 words of chunk 1. If overlap were silently broken (e.g. off
    // by one, or not applied at all), this equality would fail.
    expect(chunk0Words.slice(-50)).toEqual(chunk1Words.slice(0, 50));

    // The final chunk should reach all the way to the last word — proving no
    // text got dropped off the end.
    expect(chunks.at(-1)!.text.endsWith('word699')).toBe(true);
  });

  it('never produces a chunk that is purely a repeat of the previous chunk’s tail', () => {
    // 301 words with a 300-word chunk size and 50-word overlap: after the
    // first chunk (words 0-300), a naive stride could produce a tiny final
    // chunk that's almost entirely overlap with nothing new. The break
    // condition in chunkText (stop once a chunk reaches the end of the text)
    // exists specifically to avoid this — confirm it actually holds.
    const text = makeWords(301);
    const chunks = chunkText(text, { chunkSizeWords: 300, overlapWords: 50 });

    expect(chunks).toHaveLength(2);
    expect(chunks[1]!.text).toContain('word300');
  });

  it('throws if overlapWords is not smaller than chunkSizeWords', () => {
    expect(() => chunkText(makeWords(10), { chunkSizeWords: 100, overlapWords: 100 })).toThrow(
      /overlapWords must be smaller than chunkSizeWords/,
    );
  });
});
