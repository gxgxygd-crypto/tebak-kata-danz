// ============================================================
//  BlockVerse Server  –  Express + WebSocket (ws)
//  Run: node server.js   →   http://localhost:3000
// ============================================================

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const path      = require('path');
const { v4: uuidv4 } = require('uuid');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── State ─────────────────────────────────────────────────
// FIX: Use Map so WebSocket objects work as real unique keys.
// Plain {} converts any object key to "[object WebSocket]"
// causing ALL clients to collide on the exact same slot!
const clients = new Map();   // ws  → { playerId, roomId, name }
const rooms   = {};          // id  → Room

// ── Room helpers ──────────────────────────────────────────
function makeRoom(id, name, maxPlayers = 20) {
  return { id, name, maxPlayers, players: {}, mapData: buildDefaultMap(), chatHistory: [] };
}

function buildDefaultMap() {
  const blocks = [];
  for (let x = -20; x < 20; x++)
    for (let z = -20; z < 20; z++)
      blocks.push({ x, y: 0, z, type: 'grass' });

  for (let x = -4; x <= 4; x++)
    for (let z = -4; z <= 4; z++)
      blocks.push({ x, y: 1, z, type: 'stone' });

  for (let i = -3; i <= 3; i++) {
    blocks.push({ x: i, y: 2, z: -4, type: 'brick' });
    blocks.push({ x: i, y: 2, z:  4, type: 'brick' });
    blocks.push({ x: -4, y: 2, z: i, type: 'brick' });
    blocks.push({ x:  4, y: 2, z: i, type: 'brick' });
  }
  for (let y = 1; y <= 6; y++) {
    blocks.push({ x: 8, y, z: 8, type: 'wood' });
    blocks.push({ x: 9, y, z: 8, type: 'wood' });
    blocks.push({ x: 8, y, z: 9, type: 'wood' });
    blocks.push({ x: 9, y, z: 9, type: 'wood' });
  }
  const decos = ['sand','snow','lava','metal','glass','leaf'];
  for (let i = 0; i < 30; i++)
    blocks.push({ x: Math.floor(Math.random()*30-15), y:1, z: Math.floor(Math.random()*30-15), type: decos[i%decos.length] });
  return blocks;
}

['Main World','PvP Arena','Builder Zone','Roleplay City']
  .forEach((name, i) => { rooms[`room_${i+1}`] = makeRoom(`room_${i+1}`, name); });

// ── Helpers ───────────────────────────────────────────────
function broadcast(roomId, msg, skipWs = null) {
  const str = JSON.stringify(msg);
  wss.clients.forEach(ws => {
    if (ws === skipWs || ws.readyState !== WebSocket.OPEN) return;
    const info = clients.get(ws);
    if (info && info.roomId === roomId) ws.send(str);
  });
}
function sendTo(ws, msg) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }

// ── HTTP ─────────────────────────────────────────────────
app.get('/api/rooms', (_req, res) => {
  res.json(Object.values(rooms).map(r => ({
    id: r.id, name: r.name,
    playerCount: Object.keys(r.players).length,
    maxPlayers: r.maxPlayers,
  })));
});

// ── WebSocket ─────────────────────────────────────────────
wss.on('connection', (ws) => {
  const playerId = uuidv4();
  clients.set(ws, { playerId, roomId: null, name: 'Player' });
  console.log(`[+] ${playerId.slice(0,8)} connected | total: ${clients.size}`);

  sendTo(ws, {
    type: 'welcome', playerId,
    rooms: Object.values(rooms).map(r => ({
      id: r.id, name: r.name,
      playerCount: Object.keys(r.players).length,
      maxPlayers: r.maxPlayers,
    })),
  });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const info = clients.get(ws);   // FIX: Map.get() returns THIS client's info
    if (!info) return;

    switch (msg.type) {
      case 'join_room': {
        const room = rooms[msg.roomId];
        if (!room) { sendTo(ws, { type:'error', text:'Room not found' }); return; }
        if (Object.keys(room.players).length >= room.maxPlayers) { sendTo(ws, { type:'error', text:'Room full' }); return; }
        if (info.roomId) doLeave(ws, info);

        const name  = String(msg.name  || 'Player').slice(0,24);
        const color = String(msg.color || '#00e5ff');
        info.roomId = msg.roomId;
        info.name   = name;

        room.players[info.playerId] = {
          id: info.playerId, name, color,
          x: (Math.random()-0.5)*10, y: 2, z: (Math.random()-0.5)*10, rotY: 0,
        };

        sendTo(ws, { type:'room_joined', roomId:room.id, roomName:room.name, playerId:info.playerId,
                     players:room.players, mapData:room.mapData, chatHistory:room.chatHistory.slice(-40) });

        broadcast(room.id, { type:'player_joined', player:room.players[info.playerId] }, ws);

        const sysMsg = { sender:'System', color:'#00e5ff', text:`${name} joined!`, ts:Date.now() };
        room.chatHistory.push(sysMsg);
        broadcast(room.id, { type:'chat', message:sysMsg });
        console.log(`[join] ${name} → ${room.name} (${Object.keys(room.players).length} players)`);
        break;
      }
      case 'move': {
        if (!info.roomId) break;
        const p = rooms[info.roomId]?.players[info.playerId];
        if (!p) break;
        p.x = +msg.x||0; p.y = +msg.y||0; p.z = +msg.z||0; p.rotY = +msg.rotY||0;
        broadcast(info.roomId, { type:'player_moved', id:info.playerId, x:p.x, y:p.y, z:p.z, rotY:p.rotY }, ws);
        break;
      }
      case 'chat': {
        if (!info.roomId) break;
        const room = rooms[info.roomId];
        const chatMsg = {
          sender: info.name, color: room.players[info.playerId]?.color||'#fff',
          text: String(msg.text||'').slice(0,200), ts: Date.now(),
        };
        room.chatHistory.push(chatMsg);
        if (room.chatHistory.length > 100) room.chatHistory.shift();
        broadcast(info.roomId, { type:'chat', message:chatMsg });
        break;
      }
      case 'place_block': {
        if (!info.roomId) break;
        const room = rooms[info.roomId];
        const { x, y, z, blockType } = msg;
        room.mapData = room.mapData.filter(b => !(b.x===x&&b.y===y&&b.z===z));
        if (blockType !== 'air') room.mapData.push({ x, y, z, type:blockType });
        broadcast(info.roomId, { type:'block_update', x, y, z, blockType });
        break;
      }
      case 'save_map': {
        if (!info.roomId || !Array.isArray(msg.mapData)) break;
        rooms[info.roomId].mapData = msg.mapData;
        broadcast(info.roomId, { type:'map_reload', mapData:msg.mapData });
        sendTo(ws, { type:'info', text:'Map synced to all players!' });
        break;
      }
      case 'script_run': {
        sendTo(ws, { type:'script_output', lines:simulateLua(String(msg.code||''), info.name) });
        break;
      }
      case 'ping':
        sendTo(ws, { type:'pong', ts:Date.now() });
        break;
    }
  });

  ws.on('close', () => { const info = clients.get(ws); doLeave(ws, info); clients.delete(ws); });
  ws.on('error', e => console.error('[ws error]', e.message));
});

function doLeave(ws, info) {
  if (!info?.roomId) return;
  const room = rooms[info.roomId];
  if (!room) return;
  delete room.players[info.playerId];
  const sysMsg = { sender:'System', color:'#ff6b35', text:`${info.name} left.`, ts:Date.now() };
  room.chatHistory.push(sysMsg);
  broadcast(room.id, { type:'player_left', id:info.playerId });
  broadcast(room.id, { type:'chat', message:sysMsg });
  console.log(`[-] ${info.name} left ${room.name}`);
  info.roomId = null;
}

function simulateLua(code, playerName) {
  const lines = [];
  for (const m of code.matchAll(/print\(["']?([^"')]+)["']?\)/g))
    lines.push({ level:'log', text:m[1].replace('player.Name', playerName) });
  for (const m of code.matchAll(/warn\(["']?([^"')]+)["']?\)/g))
    lines.push({ level:'error', text:'[WARN] '+m[1] });
  if (!lines.length) lines.push({ level:'info', text:'Script executed (no output)' });
  lines.push({ level:'success', text:`Done in ${(Math.random()*40+5).toFixed(1)}ms` });
  return lines;
}

setInterval(() => {
  const p = Object.values(rooms).reduce((s,r)=>s+Object.keys(r.players).length,0);
  console.log(`[${new Date().toLocaleTimeString()}] Connections:${clients.size} Players:${p}`);
}, 30_000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎮 BlockVerse READY`);
  console.log(`   → http://localhost:${PORT}`);
  console.log(`   → ws://localhost:${PORT}\n`);
});
