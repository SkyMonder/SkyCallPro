// SkyMessage — single-file Node.js + WebRTC + Chat
// Dependencies: express, ws, cookie-parser
// Run: npm init -y && npm install express ws cookie-parser
// Start: node server.js

const express = require('express');
const cookieParser = require('cookie-parser');
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();
app.use(express.json());
app.use(cookieParser());

const PORT = process.env.PORT || 3000;

// ------------------ IN-MEMORY STORAGE ------------------
let users = {}; // login -> {password, ws}

// ------------------ HTTP ROUTES ------------------
app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<title>SkyMessage</title>
<style>
body {margin:0;font-family:Arial;background:#0b0b0b;color:white;}
.container{max-width:900px;margin:auto;padding:20px;}
.card{background:#1c1c1c;padding:20px;border-radius:12px;margin-bottom:20px;box-shadow:0 0 18px rgba(0,0,0,0.5);}
input, textarea{width:100%;padding:10px;margin-bottom:10px;border-radius:8px;border:none;}
button{padding:10px 20px;background:#3d7fff;border:none;border-radius:8px;color:white;font-size:16px;cursor:pointer;}
button.red{background:#c0392b;}
video{background:black;border-radius:12px;}
#incoming{background:#3d3d3d;padding:10px;border-radius:10px;margin-top:10px;display:none;}
#chat{height:200px;background:#111;padding:10px;overflow:auto;border-radius:10px;margin-bottom:10px;}
#chat div{margin-bottom:6px;}
#fullscreenBtn{margin-left:10px;}
</style>
</head>
<body>
<div class="container">
<h1>SkyMessage</h1>

<div class="card" id="auth">
<h2>Регистрация / Вход</h2>
<input id="login" placeholder="Логин">
<input id="password" placeholder="Пароль" type="password">
<button onclick="registerUser()">Регистрация</button>
<button onclick="loginUser()">Войти</button>
</div>

<div class="card" id="app" style="display:none;">
<h2>Поиск пользователя</h2>
<input id="findUser" placeholder="Введите логин">
<button onclick="callUser()">Позвонить</button>

<div id="incoming"></div>

<h2>Ваше видео</h2>
<video id="localVideo" autoplay muted></video>
<h2>Видео собеседника</h2>
<video id="remoteVideo" autoplay></video>
<button id="fullscreenBtn" onclick="toggleFullScreen()">Вкл/Выкл весь экран</button>

<h2>Чат</h2>
<div id="chat"></div>
<textarea id="message" placeholder="Введите сообщение..."></textarea>
<button onclick="sendMessage()">Отправить</button>

<div style="margin-top:15px;">
<button onclick="toggleMic()">Микрофон</button>
<button onclick="toggleCam()">Камера</button>
<button class="red" onclick="endCall()">Завершить</button>
</div>
</div>

<script>
let ws, loginName = null, pc, localStream, remoteStream, remoteVideo = document.getElementById("remoteVideo");

// ------------------ WS ------------------
function connectWS(){
  ws = new WebSocket(location.origin.replace("https","wss").replace("http","ws"));
  ws.onmessage = async e => {
    let data = JSON.parse(e.data);
    if(data.type==="incoming") showIncoming(data.from);
    else if(data.type==="offer") await createAnswer(data.offer,data.from);
    else if(data.type==="answer") await pc.setRemoteDescription(data.answer);
    else if(data.type==="ice" && pc) pc.addIceCandidate(data.ice);
    else if(data.type==="chat") addMessage(data.from,data.msg);
  };
}

// ------------------ AUTH ------------------
function registerUser(){
  fetch("/register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({login:login.value,password:password.value})}).then(r=>r.text()).then(alert);
}
function loginUser(){
  fetch("/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({login:login.value,password:password.value})}).then(r=>r.json()).then(d=>{
    if(d.ok){loginName=login.value; auth.style.display="none"; app.style.display="block"; connectWS(); startMedia();}
    else alert(d.error);
  });
}

// ------------------ MEDIA ------------------
async function startMedia(){
  localStream = await navigator.mediaDevices.getUserMedia({audio:true,video:false}); // only mic by default
  localVideo.srcObject = localStream;
  remoteStream = new MediaStream();
  remoteVideo.srcObject = remoteStream;
}

// ------------------ CALL ------------------
async function callUser(){
  let target = findUser.value.trim();
  if(!target) return alert("Введите логин");
  ws.send(JSON.stringify({type:"call",to:target}));
  await createOffer(target);
}

function showIncoming(from){
  incoming.style.display="block";
  incoming.innerHTML=\`
  Входящий звонок от <b>\${from}</b><br>
  <button onclick="acceptCall('\${from}')">Принять</button>
  <button class="red" onclick="rejectCall('\${from}')">Отклонить</button>\`;
}

async function acceptCall(from){
  incoming.style.display="none";
  ws.send(JSON.stringify({type:"accept",to:from}));
  await createOffer(from);
}
function rejectCall(from){ incoming.style.display="none"; ws.send(JSON.stringify({type:"reject",to:from})); }

// ------------------ WEBRTC ------------------
async function createPeer(to){
  pc = new RTCPeerConnection({iceServers:[{urls:"stun:stun.l.google.com:19302"}]});
  pc.peer=to;
  localStream.getTracks().forEach(t=>pc.addTrack(t,localStream));
  pc.ontrack=e=>{e.streams[0].getTracks().forEach(t=>remoteStream.addTrack(t));};
  pc.onicecandidate=e=>{if(e.candidate) ws.send(JSON.stringify({type:"ice",ice:e.candidate,to:to}));};
}

async function createOffer(to){
  await createPeer(to);
  let offer=await pc.createOffer();
  await pc.setLocalDescription(offer);
  ws.send(JSON.stringify({type:"offer",offer,to}));
}

async function createAnswer(offer,from){
  await createPeer(from);
  await pc.setRemoteDescription(offer);
  let answer=await pc.createAnswer();
  await pc.setLocalDescription(answer);
  ws.send(JSON.stringify({type:"answer",answer,to:from}));
}

function endCall(){ if(pc) pc.close(); pc=null; remoteVideo.srcObject=null; remoteStream=new MediaStream(); }

// ------------------ TOGGLE ------------------
function toggleMic(){ localStream.getAudioTracks().forEach(t=>t.enabled=!t.enabled); }
function toggleCam(){ 
  if(!localStream.getVideoTracks().length){ 
    navigator.mediaDevices.getUserMedia({video:true}).then(stream=>{stream.getVideoTracks().forEach(t=>localStream.addTrack(t)); localVideo.srcObject=localStream; if(pc) stream.getVideoTracks().forEach(t=>pc.addTrack(t,localStream));});
  } else localStream.getVideoTracks().forEach(t=>t.enabled=!t.enabled);
}
function toggleFullScreen(){ if(!document.fullscreenElement) remoteVideo.requestFullscreen(); else document.exitFullscreen(); }

// ------------------ CHAT ------------------
function sendMessage(){
  let msg=message.value.trim();
  if(!msg) return;
  addMessage("Вы",msg);
  if(pc && ws) ws.send(JSON.stringify({type:"chat",to:pc.peer,msg}));
  message.value="";
}
function addMessage(from,msg){ let div=document.createElement("div"); div.textContent=from+": "+msg; chat.appendChild(div); chat.scrollTop=chat.scrollHeight; }

</script>
</body>
</html>
  `);
});

// ------------------ API ------------------
app.post("/register",(req,res)=>{
  const {login,password}=req.body;
  if(users[login]) return res.send("Логин занят");
  users[login]={password, ws:null};
  res.send("Готово");
});
app.post("/login",(req,res)=>{
  const {login,password}=req.body;
  if(!users[login]) return res.json({ok:false,error:"Нет такого пользователя"});
  if(users[login].password!==password) return res.json({ok:false,error:"Неверный пароль"});
  res.json({ok:true});
});

// ------------------ WS ------------------
const server=http.createServer(app);
const wss=new WebSocketServer({server});

wss.on("connection", ws=>{
  let userLogin=null;
  ws.on("message", msg=>{
    let data=JSON.parse(msg);
    if(data.type==="call"){
      for(let u in users) if(users[u].ws===ws) userLogin=u;
      if(users[data.to]?.ws) users[data.to].ws.send(JSON.stringify({type:"incoming",from:userLogin}));
    }
    else if(data.to && users[data.to]?.ws) users[data.to].ws.send(JSON.stringify(data));
  });
  ws.on("close", ()=>{ if(userLogin && users[userLogin]) users[userLogin].ws=null; });
  for(let login in users){ if(!users[login].ws){ users[login].ws=ws; break; } }
});

// ------------------ START ------------------
server.listen(PORT,"0.0.0.0",()=>console.log("SkyMessage running on port",PORT));
