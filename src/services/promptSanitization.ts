// src/services/promptSanitization.ts
//
// Week 3 Day 4: a second, independent defense layer against prompt
// injection, applied to every piece of untrusted document text before it
// enters an LLM prompt (classification and judge both). This does NOT try
// to detect an injection attempt's intent — that's not a solvable problem
// with string matching. It targets PROMPT STRUCTURE a legitimate document
// has no reason to contain: fake turn markers mimicking Anthropic's own
// conversation format, and a short list of common injection phrases. See
// docs/week-3-day-4.md for the full reasoning, including why this is
// deliberately a SECOND layer, not the only one — classification's
// <document> delimiters (with an explicit "treat as data" instruction as
// of v3) and the existing schema validation on the way out are the other
// two.

// Matches are replaced with a neutral marker rather than deleted outright —
// deletion would make an attack indistinguishable from the phrase never
// having been there; a visible marker preserves the fact that SOMETHING was
// stripped, in case that's ever worth surfacing in logs later.
const REDACTED = '[redacted]';

// Anthropic's own turn-delimiter conventions — a real document has no
// legitimate reason to contain these literal strings. Case-insensitive:
// an attacker doesn't need exact casing to attempt the same trick.
const TURN_MARKER_PATTERN = /\n\n(human|assistant):/gi;

// A short, deliberately non-exhaustive list of common injection phrasings.
// Not meant to be a complete blocklist (impossible) — meant to close off
// the most mechanical, common attempts cheaply. See docs/week-3-day-4.md's
// "Looking ahead" for why this list is expected to grow over time.
const INJECTION_PHRASE_PATTERNS: RegExp[] = [
  /ignore (all |any )?(the )?(previous|above|prior) instructions/gi,
  /disregard (the )?(system prompt|previous instructions)/gi,
  /new instructions:/gi,
];

export function sanitizeForPrompt(text: string): string {
  let sanitized = text.replace(TURN_MARKER_PATTERN, REDACTED);

  for (const pattern of INJECTION_PHRASE_PATTERNS) {
    sanitized = sanitized.replace(pattern, REDACTED);
  }

  return sanitized;
}