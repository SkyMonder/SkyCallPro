// server.js
// SkyMessage — single-file expanded server + frontend
// Dependencies: express, socket.io, cookie-parser
// Run: npm init -y && npm install express socket.io cookie-parser
// Start: node server.js

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cookieParser = require('cookie-parser');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cookieParser());

const PORT = process.env.PORT || 3000;

// ----------------- In-memory storage (demo only) -----------------
const users = {}; // username -> { password, displayName, socketId: string|null }
const messages = []; // { from, to, text, ts }

// Helper to list users with online flag
function listUsers(q = '') {
  const ql = (q || '').toLowerCase();
  return Object.keys(users)
    .filter(u => u.toLowerCase().includes(ql))
    .map(u => ({ username: u, displayName: users[u].displayName || u, online: !!users[u].socketId }));
}

// ----------------- HTTP routes -----------------

// serve a small favicon (svg) to avoid 404
app.get('/favicon.ico', (req, res) => {
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect fill="#3d7fff" width="64" height="64" rx="8"/><text x="50%" y="54%" font-size="34" fill="white" font-family="Arial" text-anchor="middle">SM</text></svg>`
  );
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(svg);
});

// API: register
app.post('/api/register', (req, res) => {
  const { username, password, displayName } = req.body || {};
  if (!username || !password) return res.status(400).json({ ok: false, error: 'username & password required' });
  if (users[username]) return res.status(409).json({ ok: false, error: 'username taken' });
  users[username] = { password, displayName: displayName || username, socketId: null };
  return res.json({ ok: true });
});

// API: login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ ok: false, error: 'username & password required' });
  const u = users[username];
  if (!u || u.password !== password) return res.status(401).json({ ok: false, error: 'invalid credentials' });
  // Not setting cookie secure; this is demo
  res.cookie('username', username, { httpOnly: false });
  return res.json({ ok: true, username, displayName: u.displayName });
});

// API: search users
app.get('/api/users', (req, res) => {
  const q = req.query.q || '';
  res.json(listUsers(q));
});

// API: get message history between two users
app.get('/api/messages', (req, res) => {
  const { a, b } = req.query;
  if (!a || !b) return res.status(400).json({ ok: false, error: 'a and b required' });
  const hist = messages.filter(m =>
    (m.from === a && m.to === b) || (m.from === b && m.to === a)
  ).slice(-200); // last 200
  res.json({ ok: true, messages: hist });
});

// Serve single-page UI (embedded)
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderHTML());
});

// ----------------- Socket.IO signaling + chat -----------------
const server = http.createServer(app);
const io = new Server(server, {
  // allow appropriate transports
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// Map socket.id -> username (reverse lookup)
const socketToUser = {};

io.on('connection', socket => {
  console.log('Socket connected:', socket.id);

  // On login via Socket (optional)
  socket.on('socket-login', (username) => {
    if (users[username]) {
      users[username].socketId = socket.id;
      socketToUser[socket.id] = username;
      console.log('User logged in on socket:', username);
      // Broadcast updated user list to all connected
      io.emit('users-updated', listUsers(''));
    }
  });

  // Register event (optional via socket)
  socket.on('register', ({ username, password, displayName }, cb) => {
    if (!username || !password) return cb && cb({ ok: false, error: 'username&password required' });
    if (users[username]) return cb && cb({ ok: false, error: 'username taken' });
    users[username] = { password, displayName: displayName || username, socketId: socket.id };
    socketToUser[socket.id] = username;
    io.emit('users-updated', listUsers(''));
    cb && cb({ ok: true });
  });

  // Search users (socket)
  socket.on('search-users', (q, cb) => {
    const res = listUsers(q);
    cb && cb(res);
  });

  // Call initiation
  socket.on('call', ({ to }, cb) => {
    const from = socketToUser[socket.id];
    if (!from) return cb && cb({ ok: false, error: 'not logged in' });
    const target = users[to];
    if (!target || !target.socketId) return cb && cb({ ok: false, error: 'user offline' });
    // inform target of incoming call
    io.to(target.socketId).emit('incoming-call', { from, displayName: users[from].displayName });
    cb && cb({ ok: true });
  });

  // Signaling: offer
  socket.on('offer', ({ to, sdp }) => {
    const from = socketToUser[socket.id];
    if (!from) return;
    const target = users[to];
    if (target && target.socketId) {
      io.to(target.socketId).emit('offer', { from, sdp });
    }
  });

  // Signaling: answer
  socket.on('answer', ({ to, sdp }) => {
    const from = socketToUser[socket.id];
    if (!from) return;
    const target = users[to];
    if (target && target.socketId) {
      io.to(target.socketId).emit('answer', { from, sdp });
    }
  });

  // ICE
  socket.on('ice-candidate', ({ to, candidate }) => {
    const from = socketToUser[socket.id];
    if (!from) return;
    const target = users[to];
    if (target && target.socketId) {
      io.to(target.socketId).emit('ice-candidate', { from, candidate });
    }
  });

  // End call
  socket.on('end-call', ({ to }) => {
    const from = socketToUser[socket.id];
    if (!from) return;
    const target = users[to];
    if (target && target.socketId) {
      io.to(target.socketId).emit('end-call', { from });
    }
  });

  // Chat message
  socket.on('chat-message', ({ to, text }, cb) => {
    const from = socketToUser[socket.id];
    if (!from) return cb && cb({ ok: false, error: 'not logged in' });
    const ts = Date.now();
    messages.push({ from, to, text, ts });
    // forward to recipient if online
    const target = users[to];
    if (target && target.socketId) {
      io.to(target.socketId).emit('chat-message', { from, text, ts });
    }
    // ack sender and return
    socket.emit('chat-acked', { to, text, ts });
    cb && cb({ ok: true });
  });

  socket.on('disconnect', () => {
    const u = socketToUser[socket.id];
    if (u && users[u]) {
      users[u].socketId = null;
      console.log('User disconnected:', u);
      delete socketToUser[socket.id];
      io.emit('users-updated', listUsers(''));
    } else {
      console.log('Socket disconnected:', socket.id);
    }
  });
});

// ----------------- Start server -----------------
server.listen(PORT, '0.0.0.0', () => {
  console.log(`SkyMessage running on http://0.0.0.0:${PORT} (port ${PORT})`);
});

// ----------------- HTML / client code -----------------
function renderHTML() {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>SkyMessage — WebRTC + Chat</title>
<style>
  :root{ --bg:#071026; --card:#0d1726; --muted:#9aa9c3; --accent:#7c5cff; --danger:#ff6b6b; }
  *{box-sizing:border-box;font-family:Inter, Arial, sans-serif}
  body{margin:0;background:linear-gradient(180deg,#071024,#081426);color:#e6eef8;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:18px}
  .app{width:100%;max-width:1100px;background:linear-gradient(180deg, rgba(255,255,255,0.02), rgba(0,0,0,0.06));border-radius:12px;overflow:hidden;display:grid;grid-template-columns:320px 1fr;gap:16px;padding:16px}
  .panel{background:var(--card);padding:12px;border-radius:10px}
  h1{margin:0 0 8px 0}
  .muted{color:var(--muted);font-size:13px}
  input, textarea, select{width:100%;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.04);background:transparent;color:inherit}
  button{padding:8px 10px;border-radius:8px;border:0;background:var(--accent);color:#041025;cursor:pointer;font-weight:600}
  button.ghost{background:transparent;border:1px solid rgba(255,255,255,0.04);color:var(--muted)}
  .user-item{display:flex;align-items:center;justify-content:space-between;padding:8px;border-radius:8px;margin-top:6px;background:rgba(255,255,255,0.01)}
  .user-left{display:flex;gap:10px;align-items:center}
  .status-dot{width:10px;height:10px;border-radius:50%}
  .online{background:#2ee6a8}
  .offline{background:#374258}
  #video-area{display:flex;gap:12px;flex-direction:column}
  #videos{display:flex;gap:12px}
  video{background:#050814;border-radius:8px;flex:1;min-height:240px;object-fit:cover}
  .local-small{width:220px;height:140px;position:relative;border-radius:8px;overflow:hidden}
  #incoming{position:absolute;left:50%;transform:translateX(-50%);top:10px;background:linear-gradient(90deg,#3a2bff,#00e6b8);padding:12px;border-radius:10px;display:none;z-index:20}
  .controls{display:flex;gap:8px;align-items:center;margin-top:8px}
  .danger{background:var(--danger);color:white}
  #chat{height:220px;background:rgba(255,255,255,0.02);padding:8px;border-radius:8px;overflow:auto}
  .msg{margin-bottom:8px}
  .note{font-size:13px;color:var(--muted)}
  @media(max-width:900px){ .app{grid-template-columns:1fr} .local-small{width:160px;height:110px} }
</style>
</head>
<body>
<div class="app" role="application" aria-label="SkyMessage app">

  <div class="panel" style="display:flex;flex-direction:column;height:80vh">
    <div style="display:flex;align-items:center;justify-content:space-between">
      <div><h1>SkyMessage</h1><div class="muted">Встроенный демо-сервер</div></div>
      <div class="note" id="status">Соединение...</div>
    </div>

    <div style="margin-top:12px">
      <div id="auth-block">
        <div style="margin-bottom:8px"><input id="reg-login" placeholder="Логин (для регистрации / входа)"></div>
        <div style="margin-bottom:8px"><input id="reg-pass" placeholder="Пароль" type="password"></div>
        <div style="display:flex;gap:8px">
          <button id="btn-register">Регистрация</button>
          <button id="btn-login" class="ghost">Войти</button>
        </div>
      </div>

      <div id="logged-block" style="display:none;margin-top:8px">
        <div class="muted">Вы вошли как <strong id="me-name"></strong></div>
        <div style="margin-top:8px;display:flex;gap:6px">
          <button id="btn-logout" class="ghost">Выйти</button>
          <button id="btn-copy" class="ghost">Копировать логин</button>
        </div>
      </div>
    </div>

    <div style="margin-top:16px">
      <div style="display:flex;gap:8px">
        <input id="search-q" placeholder="Поиск по логину..." />
        <button id="btn-search" class="ghost">Поиск</button>
      </div>
      <div id="users-list" style="margin-top:10px;overflow:auto;max-height:calc(80vh - 300px)"></div>
    </div>

    <div style="margin-top:auto;font-size:12px;color:var(--muted)">
      Демо — без сохранения в БД. Для продакшна: HTTPS, TURN, хеш паролей.
    </div>
  </div>

  <div class="panel" style="display:flex;flex-direction:column;height:80vh">
    <div id="video-area">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div class="note" id="call-info">Ожидание</div>
        <div style="display:flex;gap:8px;align-items:center">
          <div id="remote-name" class="muted">—</div>
          <div class="pill note" id="conn-pill"></div>
        </div>
      </div>

      <div id="videos">
        <div style="flex:1;position:relative">
          <video id="remoteVideo" autoplay playsinline></video>
          <div id="incoming">
            <div style="font-weight:700" id="incoming-title">Входящий звонок</div>
            <div class="muted small" id="incoming-from">От: —</div>
            <div style="margin-top:8px;display:flex;gap:8px">
              <button id="btn-accept">Принять</button>
              <button id="btn-decline" class="ghost">Отклонить</button>
            </div>
          </div>
        </div>

        <div style="width:240px;display:flex;flex-direction:column;gap:8px">
          <div class="local-small">
            <video id="localVideo" autoplay muted playsinline style="width:100%;height:100%;object-fit:cover;border-radius:8px"></video>
          </div>
          <div>
            <div style="display:flex;gap:8px" class="controls">
              <button id="btn-call" class="ghost">Позвонить</button>
              <button id="btn-end" class="danger hide">Завершить</button>
              <button id="btn-mic" class="ghost">Мик выкл</button>
              <button id="btn-cam" class="ghost">Вкл кам</button>
              <button id="btn-full" class="ghost">Full</button>
            </div>
          </div>
        </div>
      </div>

      <div style="display:flex;gap:12px;margin-top:12px">
        <div style="flex:1">
          <h3>Чат</h3>
          <div id="chat" aria-live="polite"></div>
          <div style="display:flex;gap:8px;margin-top:8px">
            <input id="msg-input" placeholder="Сообщение..." />
            <button id="btn-send">Отправить</button>
          </div>
        </div>

        <div style="width:260px">
          <h3>Информация</h3>
          <div class="note">Нажмите пользователя в списке, чтобы начать чат/звонок. История загружается справа.</div>
          <div style="margin-top:8px">
            <label>Найти пользователя:</label>
            <input id="call-target" placeholder="логин для звонка" />
            <div style="margin-top:8px;display:flex;gap:8px">
              <button id="btn-call-target">Позвонить</button>
              <button id="btn-clear" class="ghost">Очистить чат</button>
            </div>
            <div style="margin-top:12px" class="note">При первом звонке камера выключена — включите вручную.</div>
          </div>
        </div>
      </div>
    </div>
  </div>

</div>

<script src="/socket.io/socket.io.js"></script>
<script>
/*
  Client logic:
  - socket.io used for signaling + chat
  - WebRTC peer connection negotiation
  - initial media: audio only; add video on demand (toggle camera)
  - message history via /api/messages
*/

const socket = io();
let me = { username: null, displayName: null };
let pc = null;
let localStream = null;
let remoteStream = null;
let currentPeer = null; // username of peer in call
let pendingOffer = null;
let iceQueue = []; // candidates before pc ready

// UI elements
const statusEl = document.getElementById('status');
const meNameEl = document.getElementById('me-name');
const loggedBlock = document.getElementById('logged-block');
const authBlock = document.getElementById('auth-block');
const usersListEl = document.getElementById('users-list');
const searchQ = document.getElementById('search-q');
const btnSearch = document.getElementById('btn-search');
const btnRegister = document.getElementById('btn-register');
const btnLogin = document.getElementById('btn-login');
const regLogin = document.getElementById('reg-login');
const regPass = document.getElementById('reg-pass');
const btnLogout = document.getElementById('btn-logout');
const btnCopy = document.getElementById('btn-copy');

const remoteVideo = document.getElementById('remoteVideo');
const localVideo = document.getElementById('localVideo');
const incomingBox = document.getElementById('incoming');
const incomingTitle = document.getElementById('incoming-title');
const incomingFrom = document.getElementById('incoming-from');
const btnAccept = document.getElementById('btn-accept');
const btnDecline = document.getElementById('btn-decline');

const btnCall = document.getElementById('btn-call');
const btnEnd = document.getElementById('btn-end');
const btnMic = document.getElementById('btn-mic');
const btnCam = document.getElementById('btn-cam');
const btnFull = document.getElementById('btn-full');
const callInfo = document.getElementById('call-info');
const remoteName = document.getElementById('remote-name');

const chatEl = document.getElementById('chat');
const msgInput = document.getElementById('msg-input');
const btnSend = document.getElementById('btn-send');
const btnCallTarget = document.getElementById('btn-call-target');
const callTargetInput = document.getElementById('call-target');
const btnClear = document.getElementById('btn-clear');

let micMuted = false;
let camOn = false;

// Helper UI
function logChat(text, who='') {
  const d = document.createElement('div');
  d.className = 'msg';
  d.textContent = (who ? who + ': ' : '') + text;
  chatEl.appendChild(d);
  chatEl.scrollTop = chatEl.scrollHeight;
}

// ------------------ Authentication ------------------
btnRegister.onclick = async () => {
  const username = regLogin.value.trim(); const password = regPass.value;
  if (!username || !password) return alert('Введите логин и пароль');
  const res = await fetch('/api/register', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username, password})});
  const data = await res.json();
  if (data.ok) { alert('Зарегистрированы. Войдите.'); }
  else alert(data.error || 'Ошибка регистрации');
};

btnLogin.onclick = async () => {
  const username = regLogin.value.trim(); const password = regPass.value;
  if (!username || !password) return alert('Введите логин и пароль');
  const res = await fetch('/api/login', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username, password})});
  const data = await res.json();
  if (data.ok) {
    me.username = username; me.displayName = data.displayName || username;
    authBlock.style.display = 'none'; loggedBlock.style.display = 'block';
    meNameEl.textContent = me.username;
    statusEl.textContent = 'Подключено';
    // inform socket about login
    socket.emit('socket-login', me.username);
    refreshUsers('');
    await prepareLocalMedia(); // prepare microphone only
  } else {
    alert(data.error || 'Ошибка входа');
  }
};

btnLogout.onclick = () => {
  // basic logout: clear client state
  me = { username: null, displayName: null };
  authBlock.style.display = 'block'; loggedBlock.style.display = 'none';
  regLogin.value=''; regPass.value='';
  statusEl.textContent = 'Отключено';
  socket.disconnect();
  setTimeout(()=> window.location.reload(), 300);
};

btnCopy.onclick = () => { navigator.clipboard.writeText(me.username || ''); alert('Скопировано'); };

// ------------------ Users list / search ------------------
btnSearch.onclick = () => refreshUsers(searchQ.value.trim());
async function refreshUsers(q='') {
  const res = await fetch('/api/users?q=' + encodeURIComponent(q || ''));
  const list = await res.json();
  usersListEl.innerHTML = '';
  list.forEach(u => {
    const item = document.createElement('div');
    item.className = 'user-item';
    item.innerHTML = \`
      <div class="user-left"><div style="width:36px;height:36px;border-radius:8px;background:linear-gradient(135deg,#7c5cff,#4ce1b6);display:flex;align-items:center;justify-content:center;font-weight:700;color:#041025">\${u.username[0].toUpperCase()}</div>
      <div style="margin-left:8px"><div style="font-weight:700">\${u.displayName}</div><div class="muted small">\${u.username}</div></div></div>
      <div style="display:flex;flex-direction:column;align-items:flex-end">
        <div class="status-dot \${u.online ? 'online' : 'offline'}"></div>
        <div style="margin-top:8px;display:flex;gap:6px">
          <button class="ghost btn-chat" data-user="\${u.username}">Чат</button>
          <button class="btn-call-user" data-user="\${u.username}">Позвонить</button>
        </div>
      </div>\`;
    usersListEl.appendChild(item);
    item.querySelector('.btn-call-user').onclick = () => initiateCallTo(u.username);
    item.querySelector('.btn-chat').onclick = () => openChatWith(u.username);
  });
}

// open chat with user (load history)
async function openChatWith(user) {
  if (!me.username) return alert('Сначала войдите');
  callTargetInput.value = user;
  await loadHistory(user);
}

// load message history via API
async function loadHistory(user) {
  if (!me.username) return;
  const res = await fetch('/api/messages?a=' + encodeURIComponent(me.username) + '&b=' + encodeURIComponent(user));
  const data = await res.json();
  if (data.ok) {
    chatEl.innerHTML = '';
    data.messages.forEach(m => {
      logChat(m.text, m.from === me.username ? 'Вы' : m.from);
    });
  }
}

// ------------------ Socket events ------------------
socket.on('connect', () => {
  statusEl.textContent = 'Socket: connected';
  // If already logged in (cookie), announce to socket
  const cookieUser = getCookie('username');
  if (cookieUser) {
    me.username = cookieUser;
    meNameEl.textContent = me.username;
    authBlock.style.display = 'none'; loggedBlock.style.display = 'block';
    socket.emit('socket-login', me.username);
    prepareLocalMedia(); // start mic
    refreshUsers('');
  }
});

socket.on('users-updated', list => {
  // refresh local list if UI visible (basic)
  if (!document.hidden) refreshUsers(searchQ.value.trim());
});

socket.on('incoming-call', ({ from, displayName }) => {
  incomingBox.style.display = 'block';
  incomingFrom.textContent = 'От: ' + (displayName || from);
  pendingOffer = { from };
  incomingTitle.textContent = 'Входящий звонок';
  // store incoming-from
  pendingOffer.from = from;
});

socket.on('offer', async ({ from, sdp }) => {
  // a direct offer (callee receives)
  pendingOffer = { from, sdp };
  incomingBox.style.display = 'block';
  incomingFrom.textContent = 'От: ' + from;
});

socket.on('answer', async ({ from, sdp }) => {
  // caller receives remote answer
  if (!pc) {
    console.warn('No pc for answer');
    return;
  }
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    // add queued ICE
    while (iceQueue.length) {
      const c = iceQueue.shift();
      try { await pc.addIceCandidate(c); } catch(e){ console.warn('addIce fail', e); }
    }
  } catch (e) { console.error('setRemoteDescription error', e); }
});

socket.on('ice-candidate', async ({ from, candidate }) => {
  try {
    const c = new RTCIceCandidate(candidate);
    if (pc && pc.remoteDescription && pc.remoteDescription.type) {
      await pc.addIceCandidate(c);
    } else {
      iceQueue.push(c);
    }
  } catch (e) {
    console.warn('ice add fail', e);
  }
});

socket.on('end-call', ({ from }) => {
  // remote ended
  logChat('Собеседник завершил звонок', 'System');
  endCallLocal();
});

socket.on('chat-message', ({ from, text, ts }) => {
  // incoming live message
  logChat(text, from);
});

// ack of own message (persisted)
socket.on('chat-acked', ({ to, text, ts }) => {
  // already appended locally on send; this is server ack
});

// ------------------ Media & WebRTC ------------------
async function prepareLocalMedia() {
  if (localStream) return;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); // only mic by default
    localVideo.srcObject = localStream;
    micMuted = false;
    btnMic.textContent = 'Мик выкл';
  } catch (e) {
    alert('Не удалось получить доступ к микрофону: ' + e.message);
    console.error(e);
  }
}

function createPeerConnection(targetUser) {
  const config = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  pc = new RTCPeerConnection(config);
  currentPeer = targetUser;
  remoteStream = new MediaStream();
  remoteVideo.srcObject = remoteStream;

  // add existing local tracks (audio at least)
  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  pc.ontrack = (ev) => {
    // add tracks to remote stream
    ev.streams[0].getTracks().forEach(t => remoteStream.addTrack(t));
  };

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      socket.emit('ice-candidate', { to: targetUser, candidate: ev.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    console.log('PC state', pc.connectionState);
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      endCallLocal();
    }
  };
}

async function initiateCallTo(target) {
  if (!me.username) return alert('Сначала войдите');
  if (target === me.username) return alert('Нельзя позвонить себе');
  // notify server
  socket.emit('call', { to: target }, async (res) => {
    if (!res || !res.ok) { alert('Не удалось дозвониться: ' + (res && res.error)); return; }
    // create local media if needed
    await prepareLocalMedia();
    createPeerConnection(target);
    // create offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { to: target, sdp: offer });
    callInfo.textContent = 'Звонок: ' + target;
    remoteName.textContent = target;
    btnEnd.classList.remove('hide'); btnCall.classList.add('hide');
    logChat('Исходящий звонок ' + target, 'System');
  });
}

async function acceptIncoming() {
  if (!pendingOffer || !pendingOffer.from) return;
  const fromUser = pendingOffer.from;
  incomingBox.style.display = 'none';
  await prepareLocalMedia();
  createPeerConnection(fromUser);
  try {
    if (pendingOffer.sdp) {
      // if offer contains sdp, set it
      await pc.setRemoteDescription(new RTCSessionDescription(pendingOffer.sdp));
    } else {
      // if there was no sdp, we have to rely on server-side signaling grammar (incoming-call triggers caller to send offer)
    }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { to: fromUser, sdp: answer });
    callInfo.textContent = 'Разговор с ' + fromUser;
    remoteName.textContent = fromUser;
    btnEnd.classList.remove('hide'); btnCall.classList.add('hide');
    pendingOffer = null;
    logChat('Принят звонок от ' + fromUser, 'System');
  } catch (e) {
    console.error('acceptIncoming error', e);
  }
}

function declineIncoming() {
  if (!pendingOffer || !pendingOffer.from) { incomingBox.style.display='none'; return; }
  socket.emit('end-call', { to: pendingOffer.from });
  incomingBox.style.display = 'none';
  pendingOffer = null;
  logChat('Отклонён входящий звонок', 'System');
}

function endCallLocal() {
  try {
    if (pc) {
      pc.getSenders().forEach(s => {
        try { if (s.track) s.track.stop(); } catch(e){ }
      });
      pc.close();
      pc = null;
    }
    if (localStream) {
      // but keep mic alive if we want persistent mic; for now we keep mic to allow quick re-call
      // localStream.getTracks().forEach(t => t.stop());
    }
    remoteVideo.srcObject = null;
    currentPeer = null;
    btnEnd.classList.add('hide'); btnCall.classList.remove('hide');
    callInfo.textContent = 'Ожидание';
    remoteName.textContent = '—';
    logChat('Звонок завершён', 'System');
  } catch (e) {
    console.error('endCallLocal error', e);
  }
}

// Toggle mic (disable/enable tracks)
function toggleMic() {
  if (!localStream) return;
  micMuted = !micMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !micMuted);
  btnMic.textContent = micMuted ? 'Мик вкл' : 'Мик выкл';
}

// Toggle camera: if no video tracks — acquire camera and add tracks to pc; else toggle enabled
async function toggleCam() {
  if (!localStream) {
    await prepareLocalMedia();
  }
  if (!localStream.getVideoTracks().length) {
    try {
      const cam = await navigator.mediaDevices.getUserMedia({ video: true });
      // attach camera tracks to localStream
      cam.getVideoTracks().forEach(t => localStream.addTrack(t));
      localVideo.srcObject = localStream;
      // if peer exists, add track to pc
      if (pc) {
        cam.getVideoTracks().forEach(t => pc.addTrack(t, localStream));
      }
      cam.getVideoTracks().forEach(t => console.log('cam track added', t));
      camOn = true;
      btnCam.textContent = 'Выкл кам';
    } catch (e) {
      alert('Не удалось включить камеру: ' + e.message);
      console.error(e);
    }
  } else {
    // toggle enabled
    const enabled = localStream.getVideoTracks()[0].enabled;
    localStream.getVideoTracks().forEach(t => t.enabled = !enabled);
    camOn = !enabled;
    btnCam.textContent = camOn ? 'Выкл кам' : 'Вкл кам';
  }
}

// Fullscreen toggle for remote video
function toggleFull() {
  if (!document.fullscreenElement) {
    remoteVideo.requestFullscreen().catch(e=>console.warn(e));
  } else {
    document.exitFullscreen();
  }
}

// ------------------ Chat send ------------------
btnSend.onclick = () => {
  const txt = msgInput.value.trim();
  const to = callTargetInput.value.trim();
  if (!txt || !to) return alert('Введите сообщение и укажите получателя (справа или в списке)');
  // send to server
  socket.emit('chat-message', { to, text: txt }, (res) => {
    if (!res || !res.ok) {
      alert('Не удалось отправить: ' + (res && res.error));
    } else {
      logChat(txt, 'Вы');
      msgInput.value = '';
    }
  });
};

// quick call target button
btnCallTarget.onclick = () => {
  const t = callTargetInput.value.trim();
  if (t) initiateCallTo(t);
};

// clear chat
btnClear.onclick = () => { chatEl.innerHTML=''; };

// incoming accept/decline
btnAccept.onclick = acceptIncoming;
btnDecline.onclick = declineIncoming;

// call, end, mic, cam, full
btnCall.onclick = () => {
  const target = callTargetInput.value.trim() || prompt('Кому позвонить? Введите логин:');
  if (target) initiateCallTo(target);
};
btnEnd.onclick = () => {
  if (currentPeer) {
    socket.emit('end-call', { to: currentPeer });
  }
  endCallLocal();
};
btnMic.onclick = toggleMic;
btnCam.onclick = toggleCam;
btnFull.onclick = toggleFull;

// helpers
function getCookie(name) {
  const v = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
  return v ? v.pop() : '';
}

// on page unload, tell server
window.addEventListener('beforeunload', () => {
  if (me.username) socket.disconnect();
});

</script>
</body>
</html>`;
}
