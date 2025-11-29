// server.js
// SkyMessage — single-file server + embedded client + SQLite
// Dependencies: express, socket.io, cookie-parser, sqlite3
// Install: npm install express socket.io cookie-parser sqlite3
// Run: node server.js

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cookieParser = require('cookie-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
app.use(express.json());
app.use(cookieParser());

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'skymessage.db');

// ----------------- SQLite init -----------------
const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) {
    console.error('Failed to open DB', err);
    process.exit(1);
  }
});

db.serialize(() => {
  // users: username unique, password (plaintext for demo), displayName, created_at
  db.run(`CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    password TEXT NOT NULL,
    displayName TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  )`);

  // messages: persisted chat messages
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user TEXT NOT NULL,
    to_user TEXT NOT NULL,
    text TEXT NOT NULL,
    ts INTEGER DEFAULT (strftime('%s','now'))
  )`);

  // call_logs optional
  db.run(`CREATE TABLE IF NOT EXISTS call_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    caller TEXT,
    callee TEXT,
    ts_start INTEGER,
    ts_end INTEGER
  )`);
});

// ----------------- In-memory runtime maps -----------------
// socket.id -> username
const socketToUser = {};
// username -> socket.id
const userSockets = {};

// Helper: list users with online flag, search by substring
function listUsersSql(q = '') {
  return new Promise((resolve, reject) => {
    const like = '%' + (q || '') + '%';
    db.all(
      `SELECT username, displayName FROM users WHERE username LIKE ? OR displayName LIKE ? ORDER BY username LIMIT 200`,
      [like, like],
      (err, rows) => {
        if (err) return reject(err);
        const res = rows.map(r => ({
          username: r.username,
          displayName: r.displayName || r.username,
          online: !!userSockets[r.username]
        }));
        resolve(res);
      }
    );
  });
}

// ----------------- HTTP API -----------------

// tiny favicon (svg) to prevent 404 spam
app.get('/favicon.ico', (req, res) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect fill="#3d7fff" width="64" height="64" rx="8"/><text x="50%" y="54%" font-size="28" fill="white" font-family="Arial" text-anchor="middle">SM</text></svg>`;
  res.type('image/svg+xml').send(svg);
});

// register
app.post('/api/register', (req, res) => {
  const { username, password, displayName } = req.body || {};
  if (!username || !password) return res.status(400).json({ ok: false, error: 'username & password required' });
  db.run(
    `INSERT INTO users (username, password, displayName) VALUES (?, ?, ?)`,
    [username, password, displayName || username],
    function (err) {
      if (err) {
        if (err.code === 'SQLITE_CONSTRAINT') return res.status(409).json({ ok: false, error: 'username taken' });
        console.error('DB insert user err', err);
        return res.status(500).json({ ok: false, error: 'db error' });
      }
      return res.json({ ok: true });
    }
  );
});

// login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ ok: false, error: 'username & password required' });
  db.get(`SELECT username, displayName FROM users WHERE username = ? AND password = ?`, [username, password], (err, row) => {
    if (err) {
      console.error('DB get user err', err);
      return res.status(500).json({ ok: false, error: 'db error' });
    }
    if (!row) return res.status(401).json({ ok: false, error: 'invalid credentials' });
    // set cookie (demo)
    res.cookie('username', username, { httpOnly: false });
    res.json({ ok: true, username: row.username, displayName: row.displayName || row.username });
  });
});

// search users
app.get('/api/users', async (req, res) => {
  const q = (req.query.q || '').trim();
  try {
    const list = await listUsersSql(q);
    res.json(list);
  } catch (e) {
    console.error('listUsersSql error', e);
    res.status(500).json([]);
  }
});

// message history between a and b
app.get('/api/messages', (req, res) => {
  const { a, b } = req.query;
  if (!a || !b) return res.status(400).json({ ok: false, error: 'a and b required' });
  db.all(
    `SELECT from_user as fromUser, to_user as toUser, text, ts FROM messages
     WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)
     ORDER BY ts ASC LIMIT 1000`,
    [a, b, b, a],
    (err, rows) => {
      if (err) {
        console.error('messages select err', err);
        return res.status(500).json({ ok: false, error: 'db error' });
      }
      res.json({ ok: true, messages: rows });
    }
  );
});

// serve UI (embedded single file)
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderHTML());
});

// ----------------- Socket.IO (signaling & chat) -----------------
const server = http.createServer(app);
const io = new Server(server, { /* default options */ });

// helper to send users-updated broadcast
async function broadcastUsersUpdated() {
  try {
    const list = await listUsersSql('');
    io.emit('users-updated', list);
  } catch (e) {
    console.warn('broadcastUsersUpdated fail', e);
  }
}

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  // login announcement from client
  socket.on('socket-login', (username) => {
    if (!username) return;
    socketToUser[socket.id] = username;
    userSockets[username] = socket.id;
    console.log('socket-login', username, socket.id);
    broadcastUsersUpdated();
  });

  // register via socket (optional)
  socket.on('register', ({ username, password, displayName }, cb) => {
    if (!username || !password) return cb && cb({ ok: false, error: 'username & password required' });
    db.run(`INSERT INTO users (username, password, displayName) VALUES (?, ?, ?)`, [username, password, displayName || username], function (err) {
      if (err) {
        if (err.code === 'SQLITE_CONSTRAINT') return cb && cb({ ok: false, error: 'username taken' });
        console.error('register socket db err', err);
        return cb && cb({ ok: false, error: 'db error' });
      }
      // auto-login socket
      socketToUser[socket.id] = username;
      userSockets[username] = socket.id;
      broadcastUsersUpdated();
      cb && cb({ ok: true });
    });
  });

  // search users (socket)
  socket.on('search-users', async (q, cb) => {
    try {
      const res = await listUsersSql(q || '');
      cb && cb(res);
    } catch (e) {
      cb && cb([]);
    }
  });

  // call initiation
  socket.on('call', ({ to }, cb) => {
    const from = socketToUser[socket.id];
    if (!from) return cb && cb({ ok: false, error: 'not logged in' });
    const targetSocket = userSockets[to];
    if (!targetSocket) return cb && cb({ ok: false, error: 'user offline' });
    io.to(targetSocket).emit('incoming-call', { from, displayName: null });
    cb && cb({ ok: true });
  });

  // signaling: offer
  socket.on('offer', ({ to, sdp }) => {
    const from = socketToUser[socket.id];
    if (!from) return;
    const targetSocket = userSockets[to];
    if (targetSocket) io.to(targetSocket).emit('offer', { from, sdp });
  });

  // signaling: answer
  socket.on('answer', ({ to, sdp }) => {
    const from = socketToUser[socket.id];
    if (!from) return;
    const targetSocket = userSockets[to];
    if (targetSocket) io.to(targetSocket).emit('answer', { from, sdp });
  });

  // ice
  socket.on('ice-candidate', ({ to, candidate }) => {
    const from = socketToUser[socket.id];
    if (!from) return;
    const targetSocket = userSockets[to];
    if (targetSocket) io.to(targetSocket).emit('ice-candidate', { from, candidate });
  });

  // end-call
  socket.on('end-call', ({ to }) => {
    const from = socketToUser[socket.id];
    if (!from) return;
    const targetSocket = userSockets[to];
    if (targetSocket) io.to(targetSocket).emit('end-call', { from });
    // optionally record in call_logs (ts_start/ts_end not tracked here)
    db.run(`INSERT INTO call_logs (caller, callee, ts_start, ts_end) VALUES (?, ?, ?, ?)`, [from, to, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000)], (err) => {
      if (err) console.warn('insert call_logs err', err);
    });
  });

  // chat message (persist + deliver)
  socket.on('chat-message', ({ to, text }, cb) => {
    const from = socketToUser[socket.id];
    if (!from) return cb && cb({ ok: false, error: 'not logged in' });
    const ts = Math.floor(Date.now() / 1000);
    db.run(`INSERT INTO messages (from_user, to_user, text, ts) VALUES (?, ?, ?, ?)`, [from, to, text, ts], function (err) {
      if (err) {
        console.error('insert message err', err);
        return cb && cb({ ok: false, error: 'db error' });
      }
      // deliver to recipient if online
      const targetSocket = userSockets[to];
      if (targetSocket) io.to(targetSocket).emit('chat-message', { from, text, ts });
      // ack to sender
      socket.emit('chat-acked', { to, text, ts });
      cb && cb({ ok: true });
    });
  });

  socket.on('disconnect', () => {
    const username = socketToUser[socket.id];
    if (username) {
      delete socketToUser[socket.id];
      delete userSockets[username];
      console.log('user disconnected', username);
      broadcastUsersUpdated();
    } else {
      console.log('socket disconnected', socket.id);
    }
  });
});

// ----------------- start server -----------------
server.listen(PORT, '0.0.0.0', () => {
  console.log(`SkyMessage running on http://0.0.0.0:${PORT} (port ${PORT})`);
});

// ----------------- Embedded client HTML/JS -----------------
function renderHTML() {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SkyMessage (SQLite)</title>
<style>
:root{--bg:#071026;--card:#0d1726;--muted:#9aa9c3;--accent:#7c5cff;--danger:#ff6b6b}
*{box-sizing:border-box;font-family:Inter, Arial, sans-serif}
body{margin:0;background:linear-gradient(180deg,#071024,#081426);color:#e6eef8;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:18px}
.app{width:100%;max-width:1100px;background:linear-gradient(180deg, rgba(255,255,255,0.02), rgba(0,0,0,0.06));border-radius:12px;overflow:hidden;display:grid;grid-template-columns:320px 1fr;gap:16px;padding:16px}
.panel{background:var(--card);padding:12px;border-radius:10px}
h1{margin:0 0 8px 0}
.muted{color:var(--muted);font-size:13px}
input, textarea{width:100%;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.04);background:transparent;color:inherit}
button{padding:8px 10px;border-radius:8px;border:0;background:var(--accent);color:#041025;cursor:pointer;font-weight:600}
button.ghost{background:transparent;border:1px solid rgba(255,255,255,0.04);color:var(--muted)}
.user-item{display:flex;align-items:center;justify-content:space-between;padding:8px;border-radius:8px;margin-top:6px;background:rgba(255,255,255,0.01)}
.status-dot{width:10px;height:10px;border-radius:50%}
.online{background:#2ee6a8}
.offline{background:#374258}
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
      <div><h1>SkyMessage</h1><div class="muted">Сохранение в SQLite</div></div>
      <div class="note" id="status">Отключено</div>
    </div>

    <div style="margin-top:12px">
      <div id="auth-block">
        <input id="reg-login" placeholder="Логин">
        <input id="reg-pass" placeholder="Пароль" type="password" style="margin-top:8px">
        <div style="display:flex;gap:8px;margin-top:8px">
          <button id="btn-register">Регистрация</button>
          <button id="btn-login" class="ghost">Войти</button>
        </div>
      </div>

      <div id="logged-block" style="display:none;margin-top:8px">
        <div class="muted">Вы вошли как <strong id="me-name"></strong></div>
        <div style="margin-top:8px;display:flex;gap:6px">
          <button id="btn-logout" class="ghost">Выйти</button>
          <button id="btn-copy" class="ghost">Копировать</button>
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
      Демо — SQLite локально. Для продакшн: HTTPS, TURN, хеш паролей.
    </div>
  </div>

  <div class="panel" style="display:flex;flex-direction:column;height:80vh">
    <div id="video-area">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div class="note" id="call-info">Ожидание</div>
        <div style="display:flex;gap:8px;align-items:center">
          <div id="remote-name" class="muted">—</div>
        </div>
      </div>

      <div id="videos" style="margin-top:12px">
        <div style="flex:1;position:relative">
          <video id="remoteVideo" autoplay playsinline></video>
          <div id="incoming" role="status">
            <div style="font-weight:700" id="incoming-title">Входящий звонок</div>
            <div class="muted small" id="incoming-from">От: —</div>
            <div style="margin-top:8px;display:flex;gap:8px">
              <button id="btn-accept">Принять</button>
              <button id="btn-decline" class="ghost">Отклонить</button>
            </div>
          </div>
        </div>

        <div style="width:260px;display:flex;flex-direction:column;gap:8px">
          <div class="local-small"><video id="localVideo" autoplay muted playsinline style="width:100%;height:100%;object-fit:cover;border-radius:8px"></video></div>

          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button id="btn-call" class="ghost">Позвонить</button>
            <button id="btn-end" class="danger hide">Завершить</button>
            <button id="btn-mic" class="ghost">Мик выкл</button>
            <button id="btn-cam" class="ghost">Вкл кам</button>
            <button id="btn-full" class="ghost">Full</button>
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
          <h3>Инструменты</h3>
          <div class="note">Нажмите пользователя в списке => чат/звонок. История загружается автоматически.</div>
          <div style="margin-top:8px">
            <label>Найти пользователя:</label>
            <input id="call-target" placeholder="логин для звонка" />
            <div style="margin-top:8px;display:flex;gap:8px">
              <button id="btn-call-target">Позвонить</button>
              <button id="btn-clear" class="ghost">Очистить чат</button>
            </div>
          </div>
        </div>
      </div>

    </div>
  </div>

</div>

<script src="/socket.io/socket.io.js"></script>
<script>
/* Client script (embedded) */
const socket = io();
let me = { username: null, displayName: null };
let pc = null, localStream = null, remoteStream = null;
let currentPeer = null, pendingOffer = null;
let iceQueue = [];

// UI elements
const statusEl = document.getElementById('status');
const authBlock = document.getElementById('auth-block');
const loggedBlock = document.getElementById('logged-block');
const regLogin = document.getElementById('reg-login');
const regPass = document.getElementById('reg-pass');
const btnRegister = document.getElementById('btn-register');
const btnLogin = document.getElementById('btn-login');
const meNameEl = document.getElementById('me-name');
const usersListEl = document.getElementById('users-list');
const searchQ = document.getElementById('search-q');
const btnSearch = document.getElementById('btn-search');

const remoteVideo = document.getElementById('remoteVideo');
const localVideo = document.getElementById('localVideo');
const incomingBox = document.getElementById('incoming');
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
const callTargetInput = document.getElementById('call-target');
const btnCallTarget = document.getElementById('btn-call-target');
const btnClear = document.getElementById('btn-clear');

let micMuted = false, camOn = false;

function logChat(text, who='') {
  const d = document.createElement('div'); d.className = 'msg';
  d.textContent = (who ? who + ': ' : '') + text;
  chatEl.appendChild(d);
  chatEl.scrollTop = chatEl.scrollHeight;
}

function getCookie(name) {
  const v = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
  return v ? v.pop() : '';
}

// ---------- Auth ----------
btnRegister.onclick = async () => {
  const username = regLogin.value.trim(), password = regPass.value;
  if (!username || !password) return alert('Введите логин и пароль');
  const res = await fetch('/api/register', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username, password })});
  const data = await res.json();
  if (data.ok) alert('Готово, теперь войдите'); else alert(data.error || 'Ошибка');
};

btnLogin.onclick = async () => {
  const username = regLogin.value.trim(), password = regPass.value;
  if (!username || !password) return alert('Введите логин и пароль');
  const res = await fetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username, password })});
  const data = await res.json();
  if (data.ok) {
    me.username = username; me.displayName = data.displayName || username;
    authBlock.style.display = 'none'; loggedBlock.style.display = 'block';
    meNameEl.textContent = me.username;
    statusEl.textContent = 'Socket: подключение...';
    socket.emit('socket-login', me.username);
    await prepareLocalMedia();
    refreshUsers('');
  } else {
    alert(data.error || 'Ошибка входа');
  }
};

// ---------- Users ----------
btnSearch.onclick = () => refreshUsers(searchQ.value.trim());
async function refreshUsers(q='') {
  const res = await fetch('/api/users?q=' + encodeURIComponent(q || ''));
  const list = await res.json();
  usersListEl.innerHTML = '';
  list.forEach(u => {
    const item = document.createElement('div'); item.className = 'user-item';
    item.innerHTML = '<div style="display:flex;gap:10px;align-items:center"><div style="width:36px;height:36px;border-radius:8px;background:linear-gradient(135deg,#7c5cff,#4ce1b6);display:flex;align-items:center;justify-content:center;font-weight:700;color:#041025">' + u.username[0].toUpperCase() + '</div><div style="margin-left:8px"><div style="font-weight:700">'+u.displayName+'</div><div class="muted small">'+u.username+'</div></div></div><div style="display:flex;flex-direction:column;align-items:flex-end"><div class="status-dot ' + (u.online? 'online' : 'offline') + '"></div><div style="margin-top:8px;display:flex;gap:6px"><button class="ghost btn-chat" data-user="'+u.username+'">Чат</button><button class="btn-call-user" data-user="'+u.username+'">Позвонить</button></div></div>';
    usersListEl.appendChild(item);
    item.querySelector('.btn-call-user').onclick = () => initiateCallTo(u.username);
    item.querySelector('.btn-chat').onclick = () => openChatWith(u.username);
  });
}

// load history
async function openChatWith(user) {
  if (!me.username) return alert('Сначала войдите');
  callTargetInput.value = user;
  const res = await fetch('/api/messages?a=' + encodeURIComponent(me.username) + '&b=' + encodeURIComponent(user));
  const data = await res.json();
  if (data.ok) {
    chatEl.innerHTML = '';
    data.messages.forEach(m => logChat(m.text, m.fromUser === me.username ? 'Вы' : m.fromUser));
  }
}

// ---------- Socket events ----------
socket.on('connect', () => {
  statusEl.textContent = 'Socket: connected';
  const cookieUser = getCookie('username');
  if (cookieUser && !me.username) {
    me.username = cookieUser;
    meNameEl.textContent = me.username;
    authBlock.style.display = 'none'; loggedBlock.style.display = 'block';
    socket.emit('socket-login', me.username);
    prepareLocalMedia();
    refreshUsers('');
  }
});

socket.on('users-updated', () => refreshUsers(searchQ.value.trim()));

socket.on('incoming-call', ({ from }) => {
  incomingBox.style.display = 'block';
  incomingFrom.textContent = 'От: ' + from;
  pendingOffer = { from };
});

socket.on('offer', async ({ from, sdp }) => {
  pendingOffer = { from, sdp };
  incomingBox.style.display = 'block';
  incomingFrom.textContent = 'От: ' + from;
});

socket.on('answer', async ({ from, sdp }) => {
  if (!pc) return;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    while (iceQueue.length) {
      const c = iceQueue.shift();
      try { await pc.addIceCandidate(c); } catch(e){}
    }
  } catch (e) { console.error(e); }
});

socket.on('ice-candidate', async ({ from, candidate }) => {
  try {
    const c = new RTCIceCandidate(candidate);
    if (pc && pc.remoteDescription && pc.remoteDescription.type) {
      await pc.addIceCandidate(c);
    } else {
      iceQueue.push(c);
    }
  } catch (e) { console.warn(e); }
});

socket.on('end-call', ({ from }) => {
  logChat('Собеседник завершил звонок', 'System');
  endCallLocal();
});

socket.on('chat-message', ({ from, text, ts }) => {
  logChat(text, from);
});

socket.on('chat-acked', ({ to, text, ts }) => {
  // noop
});

// ---------- Media & WebRTC ----------
async function prepareLocalMedia() {
  if (localStream) return;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio:true, video:false });
    localVideo.srcObject = localStream;
    micMuted = false; btnMic.textContent = 'Мик выкл';
  } catch (e) {
    console.warn('getUserMedia audio failed', e);
  }
}

function createPeerConnection(target) {
  const cfg = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  pc = new RTCPeerConnection(cfg);
  currentPeer = target;
  remoteStream = new MediaStream();
  remoteVideo.srcObject = remoteStream;
  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  pc.ontrack = (ev) => ev.streams[0].getTracks().forEach(t => remoteStream.addTrack(t));
  pc.onicecandidate = (ev) => { if (ev.candidate) socket.emit('ice-candidate', { to: target, candidate: ev.candidate }); };
  pc.onconnectionstatechange = () => {
    if (!pc) return;
    if (pc.connectionState === 'connected') logChat('Соединение установлено', 'System');
    if (['disconnected','failed','closed'].includes(pc.connectionState)) endCallLocal();
  };
}

async function initiateCallTo(target) {
  if (!me.username) return alert('Сначала войдите');
  if (!target) return alert('Укажите логин для звонка');
  if (target === me.username) return alert('Нельзя позвонить себе');
  socket.emit('call', { to: target }, async (res) => {
    if (!res || !res.ok) return alert('Не удалось дозвониться: ' + (res && res.error));
    await prepareLocalMedia();
    createPeerConnection(target);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { to: target, sdp: offer });
    callInfo.textContent = 'Звонок: ' + target; remoteName.textContent = target;
    btnEnd.classList.remove('hide'); btnCall.classList.add('hide');
    logChat('Исходящий звонок ' + target, 'System');
  });
}

async function acceptIncoming() {
  if (!pendingOffer || !pendingOffer.from) return;
  const from = pendingOffer.from;
  incomingBox.style.display = 'none';
  await prepareLocalMedia();
  createPeerConnection(from);
  try {
    if (pendingOffer.sdp) await pc.setRemoteDescription(new RTCSessionDescription(pendingOffer.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { to: from, sdp: answer });
    callInfo.textContent = 'Разговор с ' + from; remoteName.textContent = from;
    btnEnd.classList.remove('hide'); btnCall.classList.add('hide');
    pendingOffer = null;
  } catch (e) { console.error(e); }
}

function declineIncoming() {
  if (pendingOffer && pendingOffer.from) socket.emit('end-call', { to: pendingOffer.from });
  incomingBox.style.display = 'none'; pendingOffer = null;
}

function endCallLocal() {
  try {
    if (pc) {
      pc.getSenders().forEach(s => { try { if (s.track) s.track.stop(); } catch(e) {} });
      pc.close(); pc = null;
    }
    if (localStream && localStream.getVideoTracks) localStream.getVideoTracks().forEach(t => t.stop());
    remoteVideo.srcObject = null; currentPeer = null;
    btnEnd.classList.add('hide'); btnCall.classList.remove('hide');
    callInfo.textContent = 'Ожидание'; remoteName.textContent = '—';
  } catch (e) { console.warn(e); }
}

function toggleMic() {
  if (!localStream) return;
  micMuted = !micMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !micMuted);
  btnMic.textContent = micMuted ? 'Мик вкл' : 'Мик выкл';
}

async function toggleCam() {
  if (!localStream) await prepareLocalMedia();
  if (!localStream.getVideoTracks().length) {
    try {
      const cam = await navigator.mediaDevices.getUserMedia({ video: true });
      cam.getVideoTracks().forEach(track => localStream.addTrack(track));
      localVideo.srcObject = localStream;
      if (pc) cam.getVideoTracks().forEach(track => pc.addTrack(track, localStream));
      camOn = true; btnCam.textContent = 'Выкл кам';
    } catch (e) { alert('Не удалось включить камеру: ' + e.message); }
  } else {
    const cur = localStream.getVideoTracks();
    cur.forEach(t => t.enabled = !t.enabled);
    camOn = cur[0].enabled; btnCam.textContent = camOn ? 'Выкл кам' : 'Вкл кам';
  }
}

function toggleFull() {
  if (!document.fullscreenElement) remoteVideo.requestFullscreen().catch(()=>{});
  else document.exitFullscreen();
}

// ---------- Chat ----------
btnSend.onclick = () => {
  const text = msgInput.value.trim(), to = callTargetInput.value.trim();
  if (!text || !to) return alert('Введите сообщение и укажите получателя (справа)');
  socket.emit('chat-message', { to, text }, (res) => {
    if (!res || !res.ok) return alert('Не удалось отправить: ' + (res && res.error));
    logChat(text, 'Вы'); msgInput.value = '';
  });
};

btnCallTarget.onclick = () => { const t = callTargetInput.value.trim(); if (t) initiateCallTo(t); };
btnClear.onclick = () => { chatEl.innerHTML = ''; };

btnAccept.onclick = acceptIncoming;
btnDecline.onclick = declineIncoming;
btnCall.onclick = () => {
  const t = callTargetInput.value.trim() || prompt('Кому позвонить? Введите логин:');
  if (t) initiateCallTo(t);
};
btnEnd.onclick = () => { if (currentPeer) socket.emit('end-call', { to: currentPeer }); endCallLocal(); };
btnMic.onclick = toggleMic;
btnCam.onclick = toggleCam;
btnFull.onclick = toggleFull;

window.addEventListener('beforeunload', () => { try { if (me.username) socket.disconnect(); } catch(e){} });

</script>
</body>
</html>`;
}
