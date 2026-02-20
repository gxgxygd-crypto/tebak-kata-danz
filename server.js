// ============================================================
//  BlockVerse Server  –  Express + WebSocket (ws)
//  Run: node server.js
//  Port: 3000  (ws on same port via upgrade)
// ============================================================

const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const path    = require('path');
const { v4: uuidv4 } = require('uuid');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ── Static files ──────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory game state ──────────────────────────────────
const rooms   = {};   // roomId → Room
const clients = {};   // ws → clientInfo

// ── Room factory ─────────────────────────────────────────
function createRoom(id, name, maxPlayers = 20) {
  return {
    id,
    name,
    maxPlayers,
    players: {},        // playerId → PlayerState
    mapData: generateDefaultMap(),
    scripts: {},
    chatHistory: [],
    created: Date.now(),
  };
}

// Default starter map (flat terrain + some blocks)
function generateDefaultMap() {
  const blocks = [];
  const W = 40, D = 40;

  // Floor
  for (let x = -W/2; x < W/2; x++) {
    for (let z = -D/2; z < D/2; z++) {
      blocks.push({ x, y: 0, z, type: 'grass' });
    }
  }
  // Raised platform
  for (let x = -4; x <= 4; x++) {
    for (let z = -4; z <= 4; z++) {
      blocks.push({ x, y: 1, z, type: 'stone' });
    }
  }
  // Walls
  for (let i = -3; i <= 3; i++) {
    blocks.push({ x: i,  y: 2, z: -4, type: 'brick' });
    blocks.push({ x: i,  y: 2, z:  4, type: 'brick' });
    blocks.push({ x: -4, y: 2, z:  i, type: 'brick' });
    blocks.push({ x:  4, y: 2, z:  i, type: 'brick' });
  }
  // Tower
  for (let y = 1; y <= 6; y++) {
    blocks.push({ x: 8, y, z: 8, type: 'wood' });
    blocks.push({ x: 9, y, z: 8, type: 'wood' });
    blocks.push({ x: 8, y, z: 9, type: 'wood' });
    blocks.push({ x: 9, y, z: 9, type: 'wood' });
  }
  // Scattered decoration
  const decoTypes = ['sand','snow','lava','metal','glass','leaf'];
  for (let i = 0; i < 30; i++) {
    const rx = Math.floor(Math.random()*30 - 15);
    const rz = Math.floor(Math.random()*30 - 15);
    const type = decoTypes[Math.floor(Math.random()*decoTypes.length)];
    blocks.push({ x: rx, y: 1, z: rz, type });
  }
  return blocks;
}

// ── Seed initial rooms ────────────────────────────────────
['Main World', 'PvP Arena', 'Builder Zone', 'Roleplay City'].forEach((name, i) => {
  const id = `room_${i+1}`;
  rooms[id] = createRoom(id, name);
});

// ── Broadcast helpers ─────────────────────────────────────
function broadcast(roomId, msg, excludeWs = null) {
  const room = rooms[roomId];
  if (!room) return;
  const str = JSON.stringify(msg);
  wss.clients.forEach(ws => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const info = clients[ws];
    if (!info || info.roomId !== roomId) return;
    if (ws === excludeWs) return;
    ws.send(str);
  });
}

function sendTo(ws, msg) {
  if (ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify(msg));
}

// ── HTTP API ──────────────────────────────────────────────
app.get('/api/rooms', (req, res) => {
  const list = Object.values(rooms).map(r => ({
    id: r.id,
    name: r.name,
    playerCount: Object.keys(r.players).length,
    maxPlayers: r.maxPlayers,
  }));
  res.json(list);
});

app.get('/api/rooms/:id', (req, res) => {
  const r = rooms[req.params.id];
  if (!r) return res.status(404).json({ error: 'Room not found' });
  res.json({ id: r.id, name: r.name, maxPlayers: r.maxPlayers,
             playerCount: Object.keys(r.players).length,
             mapBlockCount: r.mapData.length });
});

// ── WebSocket handlers ────────────────────────────────────
wss.on('connection', (ws) => {
  const playerId = uuidv4();
  clients[ws] = { playerId, roomId: null, name: 'Player' };

  // Welcome
  sendTo(ws, {
    type: 'welcome',
    playerId,
    rooms: Object.values(rooms).map(r => ({
      id: r.id, name: r.name,
      playerCount: Object.keys(r.players).length,
      maxPlayers: r.maxPlayers,
    })),
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const info = clients[ws];

    switch (msg.type) {

      // ── JOIN ROOM ────────────────────────────────────────
      case 'join_room': {
        const room = rooms[msg.roomId];
        if (!room) return sendTo(ws, { type: 'error', text: 'Room not found' });
        if (Object.keys(room.players).length >= room.maxPlayers)
          return sendTo(ws, { type: 'error', text: 'Room is full' });

        // Leave previous room
        if (info.roomId) leaveRoom(ws);

        // Pick random spawn
        const spawnX = (Math.random() - 0.5) * 10;
        const spawnZ = (Math.random() - 0.5) * 10;

        const playerName = msg.name || ('Player_' + playerId.slice(0, 6));
        const playerColor = msg.color || ('#' + Math.floor(Math.random()*0xffffff).toString(16).padStart(6,'0'));

        info.roomId = msg.roomId;
        info.name   = playerName;

        room.players[playerId] = {
          id: playerId,
          name: playerName,
          color: playerColor,
          x: spawnX, y: 2, z: spawnZ,
          rotY: 0,
          hp: 100,
          joinedAt: Date.now(),
        };

        // Send full state to new player
        sendTo(ws, {
          type: 'room_joined',
          roomId: msg.roomId,
          roomName: room.name,
          playerId,
          players: room.players,
          mapData: room.mapData,
          chatHistory: room.chatHistory.slice(-30),
        });

        // Notify others
        broadcast(msg.roomId, {
          type: 'player_joined',
          player: room.players[playerId],
        }, ws);

        // System chat
        const sysMsg = { sender: 'System', color: '#00e5ff',
                         text: `${playerName} joined the game!`, ts: Date.now() };
        room.chatHistory.push(sysMsg);
        broadcast(msg.roomId, { type: 'chat', message: sysMsg });
        break;
      }

      // ── MOVE ─────────────────────────────────────────────
      case 'move': {
        const room = rooms[info.roomId];
        if (!room || !room.players[playerId]) break;
        const p = room.players[playerId];
        p.x    = msg.x;
        p.y    = msg.y;
        p.z    = msg.z;
        p.rotY = msg.rotY;

        // Broadcast to others only
        broadcast(info.roomId, {
          type: 'player_moved',
          id: playerId,
          x: p.x, y: p.y, z: p.z,
          rotY: p.rotY,
        }, ws);
        break;
      }

      // ── CHAT ─────────────────────────────────────────────
      case 'chat': {
        const room = rooms[info.roomId];
        if (!room) break;
        const chatMsg = {
          sender: info.name,
          color: room.players[playerId]?.color || '#fff',
          text: String(msg.text).slice(0, 200),
          ts: Date.now(),
        };
        room.chatHistory.push(chatMsg);
        if (room.chatHistory.length > 100) room.chatHistory.shift();
        broadcast(info.roomId, { type: 'chat', message: chatMsg });
        break;
      }

      // ── PLACE BLOCK ──────────────────────────────────────
      case 'place_block': {
        const room = rooms[info.roomId];
        if (!room) break;
        const { x, y, z, blockType } = msg;
        // Remove existing at same position
        room.mapData = room.mapData.filter(b => !(b.x===x && b.y===y && b.z===z));
        if (blockType !== 'air') {
          room.mapData.push({ x, y, z, type: blockType });
        }
        broadcast(info.roomId, { type: 'block_update', x, y, z, blockType });
        break;
      }

      // ── SCRIPT RUN ───────────────────────────────────────
      case 'script_run': {
        const room = rooms[info.roomId];
        if (!room) break;
        // Echo output back to player (sandboxed simulation)
        const lines = simulateLua(msg.code, info.name);
        sendTo(ws, { type: 'script_output', lines });
        break;
      }

      // ── SAVE MAP (studio) ────────────────────────────────
      case 'save_map': {
        const room = rooms[info.roomId];
        if (!room) break;
        room.mapData = msg.mapData;
        broadcast(info.roomId, { type: 'map_reload', mapData: room.mapData });
        sendTo(ws, { type: 'info', text: 'Map saved and synced to all players!' });
        break;
      }

      // ── PING ─────────────────────────────────────────────
      case 'ping':
        sendTo(ws, { type: 'pong', ts: Date.now() });
        break;
    }
  });

  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => leaveRoom(ws));
});

// ── Leave room helper ─────────────────────────────────────
function leaveRoom(ws) {
  const info = clients[ws];
  if (!info || !info.roomId) { delete clients[ws]; return; }
  const room = rooms[info.roomId];
  if (room && room.players[info.playerId || '']) {
    delete room.players[info.playerId];
    const sysMsg = { sender: 'System', color: '#ff6b35',
                     text: `${info.name} left the game.`, ts: Date.now() };
    room.chatHistory.push(sysMsg);
    broadcast(info.roomId, { type: 'player_left', id: info.playerId });
    broadcast(info.roomId, { type: 'chat', message: sysMsg });
  }
  delete clients[ws];
}

// ── Lua simulator (server-side echo) ─────────────────────
function simulateLua(code, playerName) {
  const lines = [];
  const prints = code.match(/print\(([^)]+)\)/g) || [];
  prints.forEach(p => {
    let val = p.slice(6, -1).replace(/"/g, '').replace(/'/g, '');
    val = val.replace('player.Name', playerName);
    lines.push({ level: 'log', text: val });
  });
  const errs = code.match(/error\(([^)]+)\)/g) || [];
  errs.forEach(e => {
    lines.push({ level: 'error', text: 'Script error: ' + e.slice(6,-1).replace(/"/g,'') });
  });
  if (!lines.length) lines.push({ level: 'info', text: 'Script executed (no output)' });
  lines.push({ level: 'success', text: `Done in ${(Math.random()*30+5).toFixed(1)}ms` });
  return lines;
}

// ── Server ping stats (every 30s) ────────────────────────
setInterval(() => {
  const totalPlayers = Object.values(rooms).reduce((s, r) => s + Object.keys(r.players).length, 0);
  const onlineClients = [...wss.clients].filter(w => w.readyState === WebSocket.OPEN).length;
  console.log(`[${new Date().toLocaleTimeString()}] Rooms: ${Object.keys(rooms).length} | Players: ${totalPlayers} | Connections: ${onlineClients}`);
}, 30000);

// ── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎮 BlockVerse Server running!`);
  console.log(`   HTTP  → http://localhost:${PORT}`);
  console.log(`   WS    → ws://localhost:${PORT}`);
  console.log(`   Rooms → ${Object.keys(rooms).length} rooms ready\n`);
});
