// src/routes/demo.ts
//
// Week 4 Day 3: a single static showcase page — vanilla HTML/CSS/JS, no
// build step, no framework, deliberately scoped this way (see
// docs/week-4-plan.md's Day 3). It exists so a visitor can upload a real
// document and watch it move through the actual pipeline in under a
// minute, instead of reading curl commands off the README.
//
// The HTML is an inline template string, not a separate file under a
// public/ directory — this repo's build step (`tsc && cp -r
// src/db/migrations dist/db/migrations`) doesn't currently copy static
// assets, and adding a second copy step (plus a new @fastify/static
// dependency) for one file would be more machinery than the page itself
// needs. Serving it as a plain Fastify route keeps the "simplest tool that
// satisfies the requirement" instinct this project has applied elsewhere
// (pgvector vs. a dedicated vector DB, no ORM, hand-rolled retry/backoff).

import type { FastifyInstance } from 'fastify';

const DEMO_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>doctriage — live demo</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #0f1115;
    --panel: #171a21;
    --border: #2a2e38;
    --text: #e6e8ec;
    --muted: #9aa1ac;
    --accent: #5b9dff;
    --ok: #4caf7d;
    --warn: #d9a441;
    --err: #e0616b;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f7f8fa;
      --panel: #ffffff;
      --border: #e1e4e9;
      --text: #1b1e24;
      --muted: #5c6370;
      --accent: #2563eb;
      --ok: #1a8a56;
      --warn: #a15c00;
      --err: #b3222f;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: var(--bg);
    color: var(--text);
    padding: 2rem 1rem 4rem;
  }
  main { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
  p.subtitle { color: var(--muted); margin-top: 0; margin-bottom: 2rem; }
  .panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1.25rem;
    margin-bottom: 1rem;
  }
  .stage-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-weight: 600;
    margin-bottom: 0.5rem;
  }
  .badge {
    display: inline-block;
    font-size: 0.72rem;
    font-weight: 600;
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    background: var(--border);
    color: var(--muted);
  }
  .badge.ok { background: color-mix(in srgb, var(--ok) 20%, transparent); color: var(--ok); }
  .badge.warn { background: color-mix(in srgb, var(--warn) 20%, transparent); color: var(--warn); }
  .badge.err { background: color-mix(in srgb, var(--err) 20%, transparent); color: var(--err); }
  button {
    background: var(--accent);
    color: white;
    border: none;
    border-radius: 6px;
    padding: 0.5rem 1rem;
    font-size: 0.9rem;
    cursor: pointer;
  }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  input[type="file"], input[type="text"] {
    color: var(--text);
    font-size: 0.9rem;
  }
  pre {
    background: color-mix(in srgb, var(--border) 40%, transparent);
    border-radius: 6px;
    padding: 0.75rem;
    overflow-x: auto;
    font-size: 0.8rem;
    margin: 0.5rem 0 0;
  }
  .row { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
  a { color: var(--accent); }
</style>
</head>
<body>
<main>
  <h1>doctriage — live pipeline demo</h1>
  <p class="subtitle">Upload a claim document (PDF) and watch it move through the real API — extraction, classification, review-queue routing, embedding, and retrieval. Every response below is exactly what the API returned, not a mock.</p>

  <div class="panel">
    <div class="stage-title">1. Upload</div>
    <div class="row">
      <input type="file" id="fileInput" accept="application/pdf" />
      <button id="uploadBtn">Upload</button>
    </div>
    <pre id="uploadOut" style="display:none"></pre>
  </div>

  <div class="panel" id="classifyPanel" style="display:none">
    <div class="stage-title">2. Classify <span class="badge" id="classifyBadge"></span></div>
    <button id="classifyBtn">Classify</button>
    <pre id="classifyOut" style="display:none"></pre>
    <div id="resolvePanel" style="display:none; margin-top:0.75rem">
      <div class="row">
        <select id="resolveType">
          <option value="claim_form">claim_form</option>
          <option value="medical_report">medical_report</option>
          <option value="police_report">police_report</option>
          <option value="repair_estimate">repair_estimate</option>
          <option value="other">other</option>
        </select>
        <button id="resolveBtn">Resolve as human reviewer</button>
      </div>
      <pre id="resolveOut" style="display:none"></pre>
    </div>
  </div>

  <div class="panel" id="embedPanel" style="display:none">
    <div class="stage-title">3. Embed</div>
    <button id="embedBtn">Embed</button>
    <pre id="embedOut" style="display:none"></pre>
  </div>

  <div class="panel" id="queryPanel" style="display:none">
    <div class="stage-title">4. Query</div>
    <div class="row">
      <input type="text" id="questionInput" placeholder="Ask a question about the document" size="40" />
      <button id="queryBtn">Query</button>
    </div>
    <pre id="queryOut" style="display:none"></pre>
  </div>

  <p class="subtitle">
    See <code>/metrics</code> for live token-usage/cost totals, and
    <code>/review-queue</code> for anything currently awaiting human resolution.
    Source: <a href="https://github.com" target="_blank" rel="noopener">this project's repo</a>.
  </p>
</main>

<script>
let documentId = null;

function show(el) { el.style.display = ''; }
function setOut(el, data) { el.textContent = JSON.stringify(data, null, 2); show(el); }

const uploadBtn = document.getElementById('uploadBtn');
const fileInput = document.getElementById('fileInput');
const uploadOut = document.getElementById('uploadOut');
const classifyPanel = document.getElementById('classifyPanel');
const classifyBtn = document.getElementById('classifyBtn');
const classifyOut = document.getElementById('classifyOut');
const classifyBadge = document.getElementById('classifyBadge');
const resolvePanel = document.getElementById('resolvePanel');
const resolveBtn = document.getElementById('resolveBtn');
const resolveOut = document.getElementById('resolveOut');
const resolveType = document.getElementById('resolveType');
const embedPanel = document.getElementById('embedPanel');
const embedBtn = document.getElementById('embedBtn');
const embedOut = document.getElementById('embedOut');
const queryPanel = document.getElementById('queryPanel');
const queryBtn = document.getElementById('queryBtn');
const queryOut = document.getElementById('queryOut');
const questionInput = document.getElementById('questionInput');

uploadBtn.addEventListener('click', async () => {
  const file = fileInput.files[0];
  if (!file) { alert('Choose a PDF first'); return; }
  const form = new FormData();
  form.append('file', file);
  uploadBtn.disabled = true;
  try {
    const res = await fetch('/documents', { method: 'POST', body: form });
    const body = await res.json();
    setOut(uploadOut, body);
    if (res.ok) {
      documentId = body.documentId;
      show(classifyPanel);
    }
  } finally {
    uploadBtn.disabled = false;
  }
});

classifyBtn.addEventListener('click', async () => {
  classifyBtn.disabled = true;
  try {
    const res = await fetch(\`/documents/\${documentId}/classify\`, { method: 'POST' });
    const body = await res.json();
    setOut(classifyOut, body);
    if (body.status === 'pending_review') {
      classifyBadge.textContent = 'pending review';
      classifyBadge.className = 'badge warn';
      show(resolvePanel);
    } else if (res.ok) {
      classifyBadge.textContent = 'auto-accepted';
      classifyBadge.className = 'badge ok';
      show(embedPanel);
    } else {
      classifyBadge.textContent = 'failed';
      classifyBadge.className = 'badge err';
    }
  } finally {
    classifyBtn.disabled = false;
  }
});

resolveBtn.addEventListener('click', async () => {
  resolveBtn.disabled = true;
  try {
    const res = await fetch(\`/review-queue/\${documentId}/resolve\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentType: resolveType.value }),
    });
    const body = await res.json();
    setOut(resolveOut, body);
    if (res.ok) {
      classifyBadge.textContent = 'resolved by human';
      classifyBadge.className = 'badge ok';
      show(embedPanel);
    }
  } finally {
    resolveBtn.disabled = false;
  }
});

embedBtn.addEventListener('click', async () => {
  embedBtn.disabled = true;
  try {
    const res = await fetch(\`/documents/\${documentId}/embed\`, { method: 'POST' });
    const body = await res.json();
    setOut(embedOut, body);
    if (res.ok) show(queryPanel);
  } finally {
    embedBtn.disabled = false;
  }
});

queryBtn.addEventListener('click', async () => {
  const question = questionInput.value.trim();
  if (!question) { alert('Type a question first'); return; }
  queryBtn.disabled = true;
  try {
    const res = await fetch(\`/documents/\${documentId}/query\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    setOut(queryOut, await res.json());
  } finally {
    queryBtn.disabled = false;
  }
});
</script>
</body>
</html>
`;

export async function demoRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (_request, reply) => {
    reply.type('text/html').send(DEMO_HTML);
  });
}
