const { createClient } = require('@libsql/client');

const db = createClient({
  url: 'libsql://callcenter-nikpereira.aws-ap-south-1.turso.io',
  authToken: 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3Nzk2NzAyNzMsImlkIjoiMDE5ZTVjOWMtYTIwMS03OTE4LWFjYmUtZjVmMWMwYzRlZGI2IiwicmlkIjoiOGI1YzU5NWItNTU4MS00MGY3LThjNzAtMWZhY2IxNjc5YjlmIn0.CKv8tUkY2UY2sshYW4c7Vn3FQWaCXiCgRgESquwVQQX63xw7wVVsKp0nWkncBZbdQXUjVUdIvERTovJjmcm4Cg',
});

async function initDB() {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'agent',
      created_at TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      auto_record INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS calls (
      id TEXT PRIMARY KEY,
      agent_id TEXT,
      customer_name TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      duration_seconds INTEGER DEFAULT 0,
      disposition TEXT DEFAULT 'resolved',
      notes TEXT DEFAULT '',
      rating INTEGER DEFAULT 0,
      call_date TEXT NOT NULL,
      transferred_from TEXT,
      escalated INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      call_id TEXT,
      agent_id TEXT,
      customer_name TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      chat_date TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      sender_role TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      content TEXT,
      file_name TEXT,
      file_data TEXT,
      file_type TEXT,
      msg_type TEXT NOT NULL DEFAULT 'text',
      sent_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daily_stats (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      stat_date TEXT NOT NULL,
      calls_received INTEGER DEFAULT 0,
      calls_handled INTEGER DEFAULT 0,
      calls_missed INTEGER DEFAULT 0,
      total_duration INTEGER DEFAULT 0,
      avg_rating REAL DEFAULT 0,
      chats_handled INTEGER DEFAULT 0,
      UNIQUE(agent_id, stat_date)
    );

    CREATE TABLE IF NOT EXISTS escalations (
      id TEXT PRIMARY KEY,
      from_agent_id TEXT NOT NULL,
      from_agent_name TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      status TEXT DEFAULT 'pending'
    );

    CREATE TABLE IF NOT EXISTS call_notes (
      id TEXT PRIMARY KEY,
      call_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_name TEXT,
      customer_name TEXT,
      content TEXT NOT NULL,
      saved_at TEXT NOT NULL,
      call_date TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kb_documents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      file_type TEXT NOT NULL,
      chunk_count INTEGER DEFAULT 0,
      uploaded_at TEXT NOT NULL,
      uploaded_by TEXT
    );

    CREATE TABLE IF NOT EXISTS kb_chunks (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      doc_name TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding TEXT
    );
  `);

  // ── Migrations: add columns that may not exist in older deployments ──────────
  const migrations = [
    `ALTER TABLE agents ADD COLUMN auto_record INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE calls ADD COLUMN escalated INTEGER DEFAULT 0`,
  ];
  for (const sql of migrations) {
    try { await db.execute(sql); } catch(e) { /* column already exists — safe to ignore */ }
  }

  // Seed supervisor if not exists
  const bcrypt = require('bcryptjs');
  const { v4: uuidv4 } = require('uuid');
  const existing = await db.execute(`SELECT id FROM agents WHERE role='supervisor' LIMIT 1`);
  if (existing.rows.length === 0) {
    const hash = await bcrypt.hash('supervisor123', 10);
    await db.execute({
      sql: `INSERT INTO agents (id, name, email, password_hash, role, created_at) VALUES (?,?,?,?,?,?)`,
      args: [uuidv4(), 'Supervisor', 'supervisor@callcenter.com', hash, 'supervisor', new Date().toISOString()]
    });
    console.log('[DB] Default supervisor created: supervisor@callcenter.com / supervisor123');
  }
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

async function upsertDailyStat(agentId, field, increment = 1) {
  const { v4: uuidv4 } = require('uuid');
  const date = todayStr();
  await db.execute({
    sql: `INSERT INTO daily_stats (id, agent_id, stat_date, ${field})
          VALUES (?, ?, ?, ?)
          ON CONFLICT(agent_id, stat_date) DO UPDATE SET ${field} = ${field} + ?`,
    args: [uuidv4(), agentId, date, increment, increment]
  });
}

async function saveCall(callData) {
  const { v4: uuidv4 } = require('uuid');
  const id = callData.id || uuidv4();
  await db.execute({
    sql: `INSERT OR REPLACE INTO calls
          (id, agent_id, customer_name, started_at, ended_at, duration_seconds, disposition, notes, rating, call_date, transferred_from, escalated)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      id, callData.agentId, callData.customerName,
      callData.startedAt, callData.endedAt || new Date().toISOString(),
      callData.duration || 0, callData.disposition || 'resolved',
      callData.notes || '', callData.rating || 0,
      todayStr(), callData.transferredFrom || null, callData.escalated ? 1 : 0
    ]
  });
  // Update daily stats
  if (callData.agentId) {
    await upsertDailyStat(callData.agentId, 'calls_handled');
    await upsertDailyStat(callData.agentId, 'total_duration', callData.duration || 0);
  }
  return id;
}

async function updateCallRating(callId, rating) {
  await db.execute({ sql: `UPDATE calls SET rating=? WHERE id=?`, args: [rating, callId] });
}

async function getAgentHistory(agentId, limit = 50) {
  const r = await db.execute({
    sql: `SELECT * FROM calls WHERE agent_id=? ORDER BY started_at DESC LIMIT ?`,
    args: [agentId, limit]
  });
  return r.rows;
}

async function getDailyStats(agentId, days = 30) {
  const r = await db.execute({
    sql: `SELECT * FROM daily_stats WHERE agent_id=? ORDER BY stat_date DESC LIMIT ?`,
    args: [agentId, days]
  });
  return r.rows;
}

async function getAllAgentsSummary() {
  const r = await db.execute({
    sql: `SELECT a.id, a.name, a.email, a.role, a.is_active,
          COALESCE(SUM(ds.calls_handled),0) as total_calls,
          COALESCE(AVG(ds.avg_rating),0) as avg_rating,
          COALESCE(SUM(ds.total_duration),0) as total_duration
          FROM agents a
          LEFT JOIN daily_stats ds ON ds.agent_id = a.id
          WHERE a.role='agent'
          GROUP BY a.id`,
    args: []
  });
  return r.rows;
}

async function getTodayOverview() {
  const today = todayStr();
  const r = await db.execute({
    sql: `SELECT
          COUNT(*) as total_calls,
          COALESCE(AVG(duration_seconds),0) as avg_duration,
          COALESCE(AVG(CASE WHEN rating > 0 THEN rating END),0) as avg_rating,
          SUM(CASE WHEN disposition='resolved' THEN 1 ELSE 0 END) as resolved,
          SUM(CASE WHEN disposition='escalated' THEN 1 ELSE 0 END) as escalated,
          SUM(CASE WHEN disposition='dropped' THEN 1 ELSE 0 END) as dropped
          FROM calls WHERE call_date=?`,
    args: [today]
  });
  return r.rows[0];
}

async function getHistoricalOverview(days = 30) {
  const r = await db.execute({
    sql: `SELECT call_date,
          COUNT(*) as total_calls,
          COALESCE(AVG(duration_seconds),0) as avg_duration,
          COALESCE(AVG(CASE WHEN rating > 0 THEN rating END),0) as avg_rating
          FROM calls
          WHERE call_date >= date('now',?)
          GROUP BY call_date ORDER BY call_date ASC`,
    args: [`-${days} days`]
  });
  return r.rows;
}

async function saveChat(chatData) {
  const { v4: uuidv4 } = require('uuid');
  const id = chatData.id || uuidv4();
  await db.execute({
    sql: `INSERT OR REPLACE INTO chats (id, call_id, agent_id, customer_name, started_at, ended_at, chat_date)
          VALUES (?,?,?,?,?,?,?)`,
    args: [id, chatData.callId || null, chatData.agentId, chatData.customerName,
           chatData.startedAt, chatData.endedAt || null, todayStr()]
  });
  if (chatData.agentId) await upsertDailyStat(chatData.agentId, 'chats_handled');
  return id;
}

async function saveMessage(msgData) {
  const { v4: uuidv4 } = require('uuid');
  await db.execute({
    sql: `INSERT INTO messages (id, chat_id, sender_role, sender_name, content, file_name, file_data, file_type, msg_type, sent_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
    args: [uuidv4(), msgData.chatId, msgData.senderRole, msgData.senderName,
           msgData.content || null, msgData.fileName || null, msgData.fileData || null,
           msgData.fileType || null, msgData.msgType || 'text', new Date().toISOString()]
  });
}

async function getChatMessages(chatId) {
  const r = await db.execute({
    sql: `SELECT * FROM messages WHERE chat_id=? ORDER BY sent_at ASC`,
    args: [chatId]
  });
  return r.rows;
}

async function getAllAgents() {
  const r = await db.execute(`SELECT id, name, email, role, is_active, created_at, COALESCE(auto_record,0) as auto_record FROM agents WHERE role='agent' ORDER BY created_at DESC`);
  return r.rows;
}

async function createAgent(name, email, passwordHash) {
  const { v4: uuidv4 } = require('uuid');
  const id = uuidv4();
  await db.execute({
    sql: `INSERT INTO agents (id, name, email, password_hash, role, created_at) VALUES (?,?,?,?,?,?)`,
    args: [id, name, email, passwordHash, 'agent', new Date().toISOString()]
  });
  return id;
}

async function deleteAgent(agentId) {
  await db.execute({ sql: `UPDATE agents SET is_active=0 WHERE id=?`, args: [agentId] });
}

async function findAgentByEmail(email) {
  const r = await db.execute({ sql: `SELECT id, name, email, password_hash, role, is_active, COALESCE(auto_record,0) as auto_record FROM agents WHERE email=? AND is_active=1 LIMIT 1`, args: [email] });
  return r.rows[0] || null;
}

async function saveEscalation(data) {
  const { v4: uuidv4 } = require('uuid');
  const id = uuidv4();
  await db.execute({
    sql: `INSERT INTO escalations (id, from_agent_id, from_agent_name, customer_name, reason, created_at, status)
          VALUES (?,?,?,?,?,?,?)`,
    args: [id, data.fromAgentId, data.fromAgentName, data.customerName, data.reason || '', new Date().toISOString(), 'pending']
  });
  return id;
}

async function resolveEscalation(id) {
  await db.execute({
    sql: `UPDATE escalations SET status='resolved', resolved_at=? WHERE id=?`,
    args: [new Date().toISOString(), id]
  });
}

async function getEscalations(limit = 50) {
  const r = await db.execute({
    sql: `SELECT * FROM escalations ORDER BY created_at DESC LIMIT ?`,
    args: [limit]
  });
  return r.rows;
}

// ── Knowledge Base ──────────────────────────────────────────────────────────
async function saveKBDocument(doc) {
  const { v4: uuidv4 } = require('uuid');
  const id = doc.id || uuidv4();
  await db.execute({
    sql: `INSERT OR REPLACE INTO kb_documents (id, name, file_type, chunk_count, uploaded_at, uploaded_by) VALUES (?,?,?,?,?,?)`,
    args: [id, doc.name, doc.fileType, doc.chunkCount || 0, new Date().toISOString(), doc.uploadedBy || null]
  });
  return id;
}

async function saveChunk(chunk) {
  const { v4: uuidv4 } = require('uuid');
  await db.execute({
    sql: `INSERT INTO kb_chunks (id, doc_id, doc_name, chunk_index, content, embedding) VALUES (?,?,?,?,?,?)`,
    args: [uuidv4(), chunk.docId, chunk.docName, chunk.chunkIndex, chunk.content, chunk.embedding || null]
  });
}

async function getAllChunks() {
  const r = await db.execute('SELECT * FROM kb_chunks');
  return r.rows;
}

async function getKBDocuments() {
  const r = await db.execute('SELECT * FROM kb_documents ORDER BY uploaded_at DESC');
  return r.rows;
}

async function deleteKBDocument(docId) {
  await db.execute({ sql: 'DELETE FROM kb_documents WHERE id=?', args: [docId] });
  await db.execute({ sql: 'DELETE FROM kb_chunks WHERE doc_id=?', args: [docId] });
}

// ── Call Notes ───────────────────────────────────────────────────────────────
async function saveCallNote(note) {
  const { v4: uuidv4 } = require('uuid');
  await db.execute({
    sql: `INSERT INTO call_notes (id, call_id, agent_id, agent_name, customer_name, content, saved_at, call_date)
          VALUES (?,?,?,?,?,?,?,?)`,
    args: [uuidv4(), note.callId, note.agentId, note.agentName || '',
           note.customerName || '', note.content, new Date().toISOString(), note.callDate || todayStr()]
  });
}

async function getCallNotes(agentId, limit = 100) {
  const r = await db.execute({
    sql: `SELECT * FROM call_notes WHERE agent_id=? ORDER BY saved_at DESC LIMIT ?`,
    args: [agentId, limit]
  });
  return r.rows;
}

// ── Auto-record setting ───────────────────────────────────────────────────────
async function setAgentAutoRecord(agentId, enabled) {
  await db.execute({
    sql: `UPDATE agents SET auto_record=? WHERE id=?`,
    args: [enabled ? 1 : 0, agentId]
  });
}

async function getAgentAutoRecord(agentId) {
  const r = await db.execute({ sql: `SELECT auto_record FROM agents WHERE id=?`, args: [agentId] });
  return r.rows[0]?.auto_record === 1;
}

module.exports = {
  db, initDB, saveCall, updateCallRating, getAgentHistory, getDailyStats,
  getAllAgentsSummary, getTodayOverview, getHistoricalOverview,
  saveChat, saveMessage, getChatMessages,
  getAllAgents, createAgent, deleteAgent, findAgentByEmail,
  saveEscalation, resolveEscalation, getEscalations, upsertDailyStat,
  saveKBDocument, saveChunk, getAllChunks, getKBDocuments, deleteKBDocument,
  saveCallNote, getCallNotes, setAgentAutoRecord, getAgentAutoRecord
};
