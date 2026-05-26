/**
 * CXeller8 RAG Pipeline
 * Chat  : Groq (llama-3.3-70b-versatile) — free
 * Embed : Simple TF-IDF keyword index — free, no binary deps
 */

const Groq = require('groq-sdk');
const DB = require('./db');

const groq = new Groq({
  apiKey: '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',
});

// ── Text chunking ─────────────────────────────────────────────────────────────
function chunkText(text, size = 400, overlap = 60) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  for (let i = 0; i < words.length; i += size - overlap) {
    const chunk = words.slice(i, i + size).join(' ');
    if (chunk.trim().length > 40) chunks.push(chunk.trim());
    if (i + size >= words.length) break;
  }
  return chunks;
}

// ── Lightweight keyword-based similarity (no external model needed) ───────────
function tokenize(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
}

const STOPWORDS = new Set([
  'the','and','for','are','but','not','you','all','can','had','her','was',
  'one','our','out','day','get','has','him','his','how','its','let','may',
  'new','now','old','see','two','use','way','who','boy','did','men','she',
  'too','any','each','from','they','this','that','have','with','been','your',
  'more','will','when','what','were','then','than','into','some','also','their'
]);

function tfidfScore(queryTokens, chunkText) {
  const chunkTokens = tokenize(chunkText);
  const chunkSet = new Set(chunkTokens);
  let score = 0;
  for (const qt of queryTokens) {
    if (chunkSet.has(qt)) score++;
    // partial match bonus
    for (const ct of chunkSet) {
      if (ct.includes(qt) || qt.includes(ct)) score += 0.3;
    }
  }
  return score / (Math.sqrt(chunkTokens.length) + 1);
}

// ── Ingest a document ─────────────────────────────────────────────────────────
async function ingestDocument(docId, docName, text) {
  const chunks = chunkText(text);
  console.log(`[RAG] Ingesting "${docName}": ${chunks.length} chunks`);
  for (let i = 0; i < chunks.length; i++) {
    await DB.saveChunk({
      docId,
      docName,
      chunkIndex: i,
      content: chunks[i],
      embedding: null, // we use keyword search, no vector needed
    });
  }
  console.log(`[RAG] Done ingesting "${docName}"`);
}

// ── Retrieve top-k relevant chunks via keyword scoring ────────────────────────
async function retrieve(query, topK = 5) {
  const allChunks = await DB.getAllChunks();
  if (!allChunks.length) return [];
  const queryTokens = tokenize(query);
  if (!queryTokens.length) return allChunks.slice(0, topK).map(c => c.content);
  const scored = allChunks
    .map(c => ({ content: c.content, score: tfidfScore(queryTokens, c.content) }))
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  return scored.map(s => s.content);
}

// ── Answer via Groq RAG ───────────────────────────────────────────────────────
async function answer(conversationHistory, userQuery) {
  const chunks = await retrieve(userQuery);
  const hasContext = chunks.length > 0;

  const systemPrompt = `You are Nikki, a friendly and professional AI assistant for CXeller8, a customer experience platform.
${hasContext ? `\nUse the following knowledge base information to answer accurately:\n\n---\n${chunks.join('\n\n---\n')}\n---\n` : ''}
Guidelines:
- Be concise, warm, and helpful. Keep replies to 2-3 sentences where possible.
- If the answer is in the context above, use it directly and confidently.
- If you genuinely don't know, say so honestly and offer to connect them with a live agent.
- Never fabricate information.
- Do not mention "context", "documents", or "knowledge base" to the customer — speak naturally.
- If the customer seems frustrated or explicitly asks for a human, proactively suggest the live agent option.`;

  const messages = [
    ...conversationHistory.slice(-8).map(m => ({ role: m.role === 'nikki' ? 'assistant' : m.role, content: m.content })),
    { role: 'user', content: userQuery }
  ];

  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    max_tokens: 400,
    temperature: 0.4,
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
  });

  return completion.choices[0].message.content;
}

module.exports = { ingestDocument, retrieve, answer, chunkText };
