const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');

const DB = require('./db');
const JWT_SECRET = 'cc-jwt-secret-nikpereira-2025';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 10e6 });

app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ───────────────────────────────────────────────────────────────────
app.get('/',           (req, res) => res.sendFile(path.join(__dirname, 'public/customer/index.html')));
app.get('/agent',      (req, res) => res.sendFile(path.join(__dirname, 'public/agent/index.html')));
app.get('/supervisor', (req, res) => res.sendFile(path.join(__dirname, 'public/supervisor/index.html')));

// ── Auth middleware ───────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}
function supervisorOnly(req, res, next) {
  if (req.user?.role !== 'supervisor') return res.status(403).json({ error: 'Forbidden' });
  next();
}

// ── REST API ─────────────────────────────────────────────────────────────────

// Auth
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const agent = await DB.findAgentByEmail(email);
    if (!agent) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, agent.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: agent.id, name: agent.name, email: agent.email, role: agent.role }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ token, user: { id: agent.id, name: agent.name, email: agent.email, role: agent.role } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Agent: their own history
app.get('/api/agent/history', authMiddleware, async (req, res) => {
  try {
    const history = await DB.getAgentHistory(req.user.id);
    res.json(history);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/agent/stats', authMiddleware, async (req, res) => {
  try {
    const stats = await DB.getDailyStats(req.user.id);
    res.json(stats);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/calls/:id/rating', authMiddleware, async (req, res) => {
  try {
    await DB.updateCallRating(req.params.id, req.body.rating);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Supervisor: agent management
app.get('/api/supervisor/agents', authMiddleware, supervisorOnly, async (req, res) => {
  try { res.json(await DB.getAllAgents()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/supervisor/agents', authMiddleware, supervisorOnly, async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'name, email, password required' });
    const existing = await DB.findAgentByEmail(email);
    if (existing) return res.status(400).json({ error: 'Email already exists' });
    const hash = await bcrypt.hash(password, 10);
    const id = await DB.createAgent(name, email, hash);
    res.json({ id, name, email });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/supervisor/agents/:id', authMiddleware, supervisorOnly, async (req, res) => {
  try {
    await DB.deleteAgent(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/supervisor/overview', authMiddleware, supervisorOnly, async (req, res) => {
  try {
    const [today, historical, agents, escalations] = await Promise.all([
      DB.getTodayOverview(),
      DB.getHistoricalOverview(30),
      DB.getAllAgentsSummary(),
      DB.getEscalations(20)
    ]);
    res.json({ today, historical, agents, escalations });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/supervisor/escalations', authMiddleware, supervisorOnly, async (req, res) => {
  try { res.json(await DB.getEscalations()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── RAG / Knowledge Base API ──────────────────────────────────────────────────
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const RAG = require('./rag');


const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Upload document to KB
app.post('/api/kb/upload', authMiddleware, supervisorOnly, upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file' });

    let text = '';
    const ext = file.originalname.split('.').pop().toLowerCase();

    if (ext === 'pdf') {
      const parsed = await pdfParse(file.buffer);
      text = parsed.text;
    } else if (ext === 'docx' || ext === 'doc') {
      const result = await mammoth.extractRawText({ buffer: file.buffer });
      text = result.value;
    } else if (ext === 'txt') {
      text = file.buffer.toString('utf-8');
    } else {
      return res.status(400).json({ error: 'Unsupported file type. Use PDF, DOCX, or TXT.' });
    }

    if (!text || text.trim().length < 50) {
      return res.status(400).json({ error: 'Document appears empty or too short.' });
    }

    const docId = uuidv4();
    const chunks = RAG.chunkText(text);

    // Save document record
    await DB.saveKBDocument({
      id: docId,
      name: file.originalname,
      fileType: ext,
      chunkCount: chunks.length,
      uploadedBy: req.user.name,
    });

    // Ingest in background — respond immediately
    res.json({ ok: true, docId, name: file.originalname, chunks: chunks.length });

    // Background ingestion
    RAG.ingestDocument(docId, file.originalname, text).catch(e =>
      console.error('[RAG] Ingest error:', e.message)
    );
  } catch (e) {
    console.error('[KB Upload]', e);
    res.status(500).json({ error: e.message });
  }
});

// List KB documents
app.get('/api/kb/documents', async (req, res) => {
  try { res.json(await DB.getKBDocuments()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete KB document
app.delete('/api/kb/documents/:id', authMiddleware, supervisorOnly, async (req, res) => {
  try {
    await DB.deleteKBDocument(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Call Notes API ────────────────────────────────────────────────────────────
app.post('/api/notes', authMiddleware, async (req, res) => {
  try {
    const { callId, customerName, content } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'No content' });
    await DB.saveCallNote({
      callId: callId || 'manual',
      agentId: req.user.id,
      agentName: req.user.name,
      customerName: customerName || '',
      content: content.trim(),
    });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/notes', authMiddleware, async (req, res) => {
  try { res.json(await DB.getCallNotes(req.user.id)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Auto-record toggle (supervisor sets per agent)
app.put('/api/supervisor/agents/:id/autorecord', authMiddleware, supervisorOnly, async (req, res) => {
  try {
    await DB.setAgentAutoRecord(req.params.id, req.body.enabled);
    res.json({ ok: true });
    // Notify agent in real-time if connected
    const agentSocket = Object.entries(agents).find(([,a]) => a.id === req.params.id)?.[0];
    if (agentSocket) io.to(agentSocket).emit('auto-record-changed', { enabled: req.body.enabled });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/supervisor/agents/:id/autorecord', authMiddleware, async (req, res) => {
  try { res.json({ enabled: await DB.getAgentAutoRecord(req.params.id) }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Nikki chatbot endpoint (public — customer facing)
app.post('/api/nikki/chat', async (req, res) => {
  try {
    const { message, history } = req.body;
    if (!message) return res.status(400).json({ error: 'No message' });
    const reply = await RAG.answer(history || [], message);
    res.json({ reply });
  } catch (e) {
    console.error('[Nikki]', e.message);
    res.json({ reply: "I'm sorry, I'm having trouble right now. Would you like to speak with a live agent?" });
  }
});

// ── In-memory call center state ───────────────────────────────────────────────
const agents = {};      // socketId -> { id, name, role, status, currentCallId }
const supervisors = {}; // socketId -> { id, name }
const queue = [];       // [{ socketId, name, waitingSince, chatId }]
const activeCalls = {}; // callId -> { customerId, agentId, startTime, onHold, customerName, callDbId }
const activeChats = {}; // chatId -> { customerId, agentId, customerName, messages[] }

function getAgentList() {
  return Object.entries(agents).map(([sid, d]) => ({ socketId: sid, ...d }));
}
function findAvailableAgent() {
  return Object.entries(agents).find(([, d]) => d.status === 'available' && d.role === 'agent')?.[0] || null;
}
function broadcastState() {
  const list = getAgentList();
  io.to('agents').emit('agent-list-updated', list);
  io.to('agents').emit('queue-updated', queue);
  io.to('supervisors').emit('live-state', { agents: list, queue, activeCalls: Object.values(activeCalls) });
}

// ── Socket.IO ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);

  // ── AGENT JOIN ────────────────────────────────────────────────────────────
  socket.on('agent-join', async ({ token }) => {
    try {
      const user = jwt.verify(token, JWT_SECRET);
      socket.join('agents');
      agents[socket.id] = { id: user.id, name: user.name, role: user.role, status: 'available', currentCallId: null };
      console.log(`[Agent] ${user.name} joined`);
      broadcastState();
      // Send today's stats
      const [history, stats] = await Promise.all([
        DB.getAgentHistory(user.id, 30),
        DB.getDailyStats(user.id, 7)
      ]);
      socket.emit('agent-history', history);
      socket.emit('agent-stats', stats);
    } catch(e) { socket.emit('auth-error', 'Invalid token'); }
  });

  // ── SUPERVISOR JOIN ───────────────────────────────────────────────────────
  socket.on('supervisor-join', async ({ token }) => {
    try {
      const user = jwt.verify(token, JWT_SECRET);
      if (user.role !== 'supervisor') { socket.emit('auth-error', 'Not a supervisor'); return; }
      socket.join('supervisors');
      supervisors[socket.id] = { id: user.id, name: user.name };
      console.log(`[Supervisor] ${user.name} joined`);
      socket.emit('live-state', { agents: getAgentList(), queue, activeCalls: Object.values(activeCalls) });
      const overview = await DB.getTodayOverview();
      socket.emit('today-overview', overview);
    } catch(e) { socket.emit('auth-error', 'Invalid token'); }
  });

  // ── STATUS CHANGE ─────────────────────────────────────────────────────────
  socket.on('agent-set-status', ({ status }) => {
    if (agents[socket.id]) { agents[socket.id].status = status; broadcastState(); }
  });

  // ── CALL FLOW ─────────────────────────────────────────────────────────────
  socket.on('customer-call-request', async ({ name }) => {
    const availableId = findAvailableAgent();
    const callDbId = uuidv4();
    if (availableId) {
      const callId = `call-${Date.now()}`;
      agents[availableId].status = 'busy';
      agents[availableId].currentCallId = callId;
      activeCalls[callId] = { customerId: socket.id, agentId: availableId, startTime: Date.now(), onHold: false, customerName: name, callDbId };
      socket.emit('call-accepted', { callId, agentId: availableId, agentName: agents[availableId].name, callDbId });
      io.to(availableId).emit('call-started', { callId, customerId: socket.id, customerName: name, callDbId });
      broadcastState();
    } else {
      queue.push({ socketId: socket.id, name, waitingSince: Date.now(), callDbId });
      socket.emit('call-queued', { position: queue.length, estimatedWait: queue.length * 90 });
      io.to('agents').emit('queue-updated', queue);
      io.to('supervisors').emit('queue-updated', queue);
    }
  });

  socket.on('agent-accept-call', ({ customerId }) => {
    const agent = agents[socket.id];
    if (!agent || agent.status !== 'available') return;
    const idx = queue.findIndex(c => c.socketId === customerId);
    if (idx === -1) return;
    const { name, callDbId } = queue[idx];
    queue.splice(idx, 1);
    const callId = `call-${Date.now()}`;
    agent.status = 'busy'; agent.currentCallId = callId;
    activeCalls[callId] = { customerId, agentId: socket.id, startTime: Date.now(), onHold: false, customerName: name, callDbId };
    io.to(customerId).emit('call-accepted', { callId, agentId: socket.id, agentName: agent.name, callDbId });
    socket.emit('call-started', { callId, customerId, customerName: name, callDbId });
    broadcastState();
  });

  // Agent rejected the incoming call — re-queue the customer
  socket.on('customer-cancel-by-agent', ({ customerId }) => {
    const alreadyQueued = queue.find(c => c.socketId === customerId);
    if (!alreadyQueued) {
      queue.push({ socketId: customerId, name: 'Customer', waitingSince: Date.now(), callDbId: uuidv4() });
      io.to(customerId).emit('call-queued', { position: queue.length, estimatedWait: queue.length * 90 });
      broadcastState();
      console.log(`[Reject] Customer re-queued at position ${queue.length}`);
    }
  });

  // Hold
  socket.on('agent-hold', ({ callId, onHold }) => {
    const call = activeCalls[callId];
    if (!call) return;
    call.onHold = onHold;
    io.to(call.customerId).emit('call-hold-changed', { onHold });
    io.to('supervisors').emit('call-hold-changed', { callId, onHold });
  });

  // Mute signals
  socket.on('agent-mute',    ({ callId, muted }) => { const c = activeCalls[callId]; if(c) io.to(c.customerId).emit('agent-mute-changed', { muted }); });
  socket.on('customer-mute', ({ callId, muted }) => { const c = activeCalls[callId]; if(c) io.to(c.agentId).emit('customer-mute-changed', { muted }); });

  // Screen share signal
  socket.on('screen-share-start', ({ callId }) => {
    const c = activeCalls[callId]; if (!c) return;
    const target = c.customerId === socket.id ? c.agentId : c.customerId;
    io.to(target).emit('peer-screen-share-started');
  });
  socket.on('screen-share-stop', ({ callId }) => {
    const c = activeCalls[callId]; if (!c) return;
    const target = c.customerId === socket.id ? c.agentId : c.customerId;
    io.to(target).emit('peer-screen-share-stopped');
  });

  // Transfer
  socket.on('agent-transfer', ({ callId, targetAgentId }) => {
    const call = activeCalls[callId];
    const from = agents[socket.id];
    const to = agents[targetAgentId];
    if (!call || !to || to.status !== 'available') { socket.emit('transfer-failed', { reason: 'Agent unavailable' }); return; }
    call.agentId = targetAgentId; call.onHold = false;
    to.status = 'busy'; to.currentCallId = callId;
    if (from) { from.status = 'available'; from.currentCallId = null; }
    io.to(call.customerId).emit('call-transferred', { agentName: to.name, agentId: targetAgentId });
    io.to(targetAgentId).emit('call-started', { callId, customerId: call.customerId, customerName: call.customerName, callDbId: call.callDbId, transferred: true });
    socket.emit('transfer-complete', { callId });
    broadcastState();
  });

  // Escalate to supervisor
  socket.on('agent-escalate', async ({ callId, reason }) => {
    const call = activeCalls[callId];
    const agent = agents[socket.id];
    if (!call || !agent) return;
    const escId = await DB.saveEscalation({
      fromAgentId: agent.id, fromAgentName: agent.name,
      customerName: call.customerName, reason
    });
    // Notify supervisors
    io.to('supervisors').emit('escalation-incoming', {
      escalationId: escId, callId, agentName: agent.name,
      agentSocketId: socket.id, customerName: call.customerName,
      customerId: call.customerId, reason
    });
    socket.emit('escalation-sent', { escalationId: escId });
  });

  // Supervisor accepts escalation
  socket.on('supervisor-accept-escalation', async ({ escalationId, callId }) => {
    const supSocket = socket.id;
    if (!supervisors[supSocket]) return;
    const call = activeCalls[callId];
    if (!call) return;
    await DB.resolveEscalation(escalationId);
    const oldAgent = agents[call.agentId];
    if (oldAgent) { oldAgent.status = 'available'; oldAgent.currentCallId = null; }
    call.agentId = supSocket;
    io.to(call.customerId).emit('call-transferred', { agentName: supervisors[supSocket].name, agentId: supSocket });
    io.to(call.agentId).emit('escalation-accepted', { callId });
    socket.emit('call-started', { callId, customerId: call.customerId, customerName: call.customerName, callDbId: call.callDbId, transferred: true });
    broadcastState();
  });

  // End call
  socket.on('end-call', async ({ callId, disposition, notes, rating }) => {
    const call = activeCalls[callId];
    if (!call) return;
    const duration = Math.round((Date.now() - call.startTime) / 1000);
    const agent = agents[call.agentId];
    // Save to DB
    await DB.saveCall({
      id: call.callDbId, agentId: agent?.id, customerName: call.customerName,
      startedAt: new Date(call.startTime).toISOString(), endedAt: new Date().toISOString(),
      duration, disposition: disposition || 'resolved', notes: notes || '', rating: rating || 0,
      escalated: call.escalated || false
    });
    if (agent) { agent.status = 'available'; agent.currentCallId = null; }
    io.to(call.customerId).emit('call-ended', { duration, callDbId: call.callDbId });
    io.to(call.agentId).emit('call-ended', { duration });
    // Refresh agent history
    if (agent) {
      const [history, stats] = await Promise.all([DB.getAgentHistory(agent.id, 30), DB.getDailyStats(agent.id, 7)]);
      io.to(call.agentId).emit('agent-history', history);
      io.to(call.agentId).emit('agent-stats', stats);
    }
    // Refresh supervisor overview
    const overview = await DB.getTodayOverview();
    io.to('supervisors').emit('today-overview', overview);
    delete activeCalls[callId];
    broadcastState();
  });

  // Customer submits rating post-call
  socket.on('customer-rating', async ({ callDbId, rating }) => {
    if (callDbId && rating) await DB.updateCallRating(callDbId, rating);
  });

  // ── CHAT ─────────────────────────────────────────────────────────────────
  socket.on('customer-chat-request', ({ name }) => {
    const chatId = `chat-${uuidv4()}`;
    const availableId = findAvailableAgent();
    activeChats[chatId] = { customerId: socket.id, agentId: availableId, customerName: name, messages: [], startTime: Date.now() };
    socket.emit('chat-started', { chatId, agentName: availableId ? agents[availableId]?.name : 'Waiting...' });
    if (availableId) {
      io.to(availableId).emit('chat-incoming', { chatId, customerName: name });
    } else {
      io.to('agents').emit('chat-incoming', { chatId, customerName: name });
    }
  });

  socket.on('chat-accept', ({ chatId }) => {
    const chat = activeChats[chatId];
    if (!chat || chat.agentId) return;
    chat.agentId = socket.id;
    const agent = agents[socket.id];
    io.to(chat.customerId).emit('chat-agent-joined', { agentName: agent?.name });
  });

  socket.on('chat-message', async ({ chatId, content, fileName, fileData, fileType, msgType }) => {
    const chat = activeChats[chatId];
    if (!chat) return;
    const isAgent = agents[socket.id] !== undefined || supervisors[socket.id] !== undefined;
    const senderRole = isAgent ? 'agent' : 'customer';
    const senderName = isAgent ? (agents[socket.id]?.name || supervisors[socket.id]?.name) : chat.customerName;
    const msg = { id: uuidv4(), chatId, senderRole, senderName, content, fileName, fileData, fileType, msgType: msgType || 'text', sentAt: new Date().toISOString() };
    chat.messages.push(msg);
    // Persist
    const agent = agents[chat.agentId];
    if (!chat.dbId) {
      chat.dbId = await DB.saveChat({ id: chatId, agentId: agent?.id, customerName: chat.customerName, startedAt: new Date(chat.startTime).toISOString() });
    }
    await DB.saveMessage({ chatId: chat.dbId || chatId, senderRole, senderName, content, fileName, fileData, fileType, msgType: msgType || 'text' });
    // Relay to both sides
    io.to(chat.customerId).emit('chat-message', msg);
    if (chat.agentId) io.to(chat.agentId).emit('chat-message', msg);
    io.to('supervisors').emit('chat-message', { chatId, ...msg });
  });

  socket.on('chat-end', async ({ chatId }) => {
    const chat = activeChats[chatId];
    if (!chat) return;
    io.to(chat.customerId).emit('chat-ended', { chatId });
    if (chat.agentId) io.to(chat.agentId).emit('chat-ended', { chatId });
    delete activeChats[chatId];
  });

  // ── WebRTC relay ──────────────────────────────────────────────────────────
  socket.on('webrtc-offer',   ({ to, offer })     => io.to(to).emit('webrtc-offer',   { from: socket.id, offer }));
  socket.on('webrtc-answer',  ({ to, answer })    => io.to(to).emit('webrtc-answer',  { from: socket.id, answer }));
  socket.on('webrtc-ice',     ({ to, candidate }) => io.to(to).emit('webrtc-ice',     { from: socket.id, candidate }));

  // ── DISCONNECT ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (agents[socket.id]) {
      const agentCalls = Object.entries(activeCalls).filter(([, c]) => c.agentId === socket.id);
      agentCalls.forEach(([callId, call]) => {
        io.to(call.customerId).emit('call-ended', { reason: 'Agent disconnected' });
        delete activeCalls[callId];
      });
      delete agents[socket.id];
      broadcastState();
    }
    if (supervisors[socket.id]) delete supervisors[socket.id];
    const qIdx = queue.findIndex(c => c.socketId === socket.id);
    if (qIdx !== -1) { queue.splice(qIdx, 1); broadcastState(); }
    const custCall = Object.entries(activeCalls).find(([, c]) => c.customerId === socket.id);
    if (custCall) {
      const [callId, call] = custCall;
      io.to(call.agentId).emit('call-ended', { reason: 'Customer disconnected' });
      if (agents[call.agentId]) { agents[call.agentId].status = 'available'; agents[call.agentId].currentCallId = null; }
      delete activeCalls[callId];
      broadcastState();
    }
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
DB.initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`\n🚀  http://localhost:${PORT}`);
    console.log(`   Agent:      http://localhost:${PORT}/agent`);
    console.log(`   Supervisor: http://localhost:${PORT}/supervisor\n`);
  });
}).catch(e => { console.error('DB init failed:', e); process.exit(1); });
