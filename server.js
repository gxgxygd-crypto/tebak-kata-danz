const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// ─── Static files ────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── State ───────────────────────────────────────────────
const players = new Map(); // id → { id, name, color, x, y, z, ry, ws }
let playerIdCounter = 0;

const COLORS = [
  0xff8c00, 0x00cfff, 0x00ff88, 0xff4466,
  0xffcc00, 0xaa44ff, 0xff6699, 0x44ffaa,
];

function broadcast(data, excludeId = null) {
  const msg = JSON.stringify(data);
  for (const [id, p] of players) {
    if (id === excludeId) continue;
    if (p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(msg);
    }
  }
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

// ─── WebSocket ───────────────────────────────────────────
wss.on('connection', (ws) => {
  const id = ++playerIdCounter;
  const color = COLORS[(id - 1) % COLORS.length];

  const player = {
    id,
    name: `Player_${id}`,
    color,
    x: 0, y: 3, z: 0,
    ry: 0,
    ws,
  };
  players.set(id, player);

  console.log(`[+] Player ${id} connected | Total: ${players.size}`);

  // 1. Send this player their own ID + color + existing players
  send(ws, {
    type: 'INIT',
    id,
    color,
    players: [...players.values()]
      .filter(p => p.id !== id)
      .map(({ id, name, color, x, y, z, ry }) => ({ id, name, color, x, y, z, ry })),
  });

  // 2. Notify others that new player joined
  broadcast({
    type: 'PLAYER_JOIN',
    player: { id, name: player.name, color, x: player.x, y: player.y, z: player.z, ry: 0 },
  }, id);

  // ─── Messages from client ─────────────────────────────
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'MOVE':
        // Client sends its position every frame (or on change)
        player.x  = msg.x  ?? player.x;
        player.y  = msg.y  ?? player.y;
        player.z  = msg.z  ?? player.z;
        player.ry = msg.ry ?? player.ry;
        broadcast({
          type: 'PLAYER_MOVE',
          id,
          x: player.x, y: player.y, z: player.z,
          ry: player.ry,
        }, id);
        break;

      case 'SET_NAME':
        player.name = String(msg.name || player.name).slice(0, 20);
        broadcast({ type: 'PLAYER_NAME', id, name: player.name }, id);
        break;

      case 'CHAT':
        const text = String(msg.text || '').slice(0, 120);
        if (!text) break;
        console.log(`[chat] ${player.name}: ${text}`);
        broadcast({ type: 'CHAT', id, name: player.name, text }, null); // including sender
        break;

      default:
        break;
    }
  });

  // ─── Disconnect ───────────────────────────────────────
  ws.on('close', () => {
    players.delete(id);
    broadcast({ type: 'PLAYER_LEAVE', id });
    console.log(`[-] Player ${id} left | Total: ${players.size}`);
  });

  ws.on('error', (err) => {
    console.error(`[!] Player ${id} error:`, err.message);
  });
});

// ─── Health check ─────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    players: players.size,
    uptime: Math.floor(process.uptime()),
  });
});

// ─── Start ────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🎮 PlatformStudio Multiplayer Server`);
  console.log(`   Listening on port ${PORT}`);
  console.log(`   http://localhost:${PORT}\n`);
});
