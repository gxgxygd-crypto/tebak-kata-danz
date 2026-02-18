const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// ─── State ────────────────────────────────────────────────────────────────────
const battleRooms = {}; // { roomId: { p1: {id, name, word}, p2: {id, name, word}, winner, lang } }
const raceRooms   = {}; // { roomId: { players: {id: {name,won,guesses}}, solution, lang, winner, hostId } }

// ─── Helpers ──────────────────────────────────────────────────────────────────
function makeId(len = 5) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < len; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("🟢 Connected:", socket.id);

  // ══════════════════════════════════
  //  BATTLE MODE
  // ══════════════════════════════════

  // P1 creates room
  socket.on("battle:create", ({ name, lang }) => {
    const roomId = makeId(5);
    battleRooms[roomId] = {
      p1: { id: socket.id, name, word: null },
      p2: null,
      winner: null,
      lang,
    };
    socket.join(roomId);
    socket.emit("battle:created", { roomId, role: "p1" });
    console.log(`⚔️  Battle room created: ${roomId} by ${name}`);
  });

  // P2 joins room
  socket.on("battle:join", ({ roomId, name }) => {
    const room = battleRooms[roomId];
    if (!room) { socket.emit("battle:error", "Room tidak ditemukan!"); return; }
    if (room.p2) { socket.emit("battle:error", "Room sudah penuh!"); return; }

    room.p2 = { id: socket.id, name, word: null };
    socket.join(roomId);

    // Tell P2 which lang to use and their role
    socket.emit("battle:joined", { roomId, role: "p2", lang: room.lang });
    // Tell P1 that P2 joined
    io.to(room.p1.id).emit("battle:opponent_joined", { name });
    // Tell both to enter their word
    io.to(roomId).emit("battle:enter_word");
    console.log(`⚔️  ${name} joined battle room: ${roomId}`);
  });

  // Player submits their secret word
  socket.on("battle:set_word", ({ roomId, word }) => {
    const room = battleRooms[roomId];
    if (!room) return;

    if (room.p1 && room.p1.id === socket.id) room.p1.word = word;
    else if (room.p2 && room.p2.id === socket.id) room.p2.word = word;

    socket.emit("battle:word_locked");

    // Both set their word → start battle
    if (room.p1?.word && room.p2?.word) {
      // Send each player the OPPONENT's word (which they must guess)
      io.to(room.p1.id).emit("battle:start", {
        yourWord: room.p1.word,
        guessWord: room.p2.word,
        opponentName: room.p2.name,
      });
      io.to(room.p2.id).emit("battle:start", {
        yourWord: room.p2.word,
        guessWord: room.p1.word,
        opponentName: room.p1.name,
      });
      console.log(`⚔️  Battle started in room: ${roomId}`);
    }
  });

  // Player wins battle
  socket.on("battle:win", ({ roomId }) => {
    const room = battleRooms[roomId];
    if (!room || room.winner) return;
    room.winner = socket.id;

    const winnerName = room.p1?.id === socket.id ? room.p1.name : room.p2?.name;
    io.to(roomId).emit("battle:result", { winnerId: socket.id, winnerName });
    console.log(`🏆 Battle winner: ${winnerName} in room: ${roomId}`);
  });

  // Restart battle in same room
  socket.on("battle:restart", ({ roomId }) => {
    const room = battleRooms[roomId];
    if (!room) return;
    room.p1.word = null;
    room.p2.word = null;
    room.winner = null;
    io.to(roomId).emit("battle:enter_word");
    console.log(`🔄 Battle restarted in room: ${roomId}`);
  });

  // Leave battle room
  socket.on("battle:leave", ({ roomId }) => {
    const room = battleRooms[roomId];
    if (room) {
      io.to(roomId).emit("battle:opponent_left");
      delete battleRooms[roomId];
    }
    socket.leave(roomId);
  });

  // ══════════════════════════════════
  //  RACE MODE
  // ══════════════════════════════════

  // Create race room
  socket.on("race:create", ({ name, lang, solution }) => {
    const roomId = makeId(4);
    raceRooms[roomId] = {
      solution,
      lang,
      winner: null,
      hostId: socket.id,
      players: {
        [socket.id]: { name, won: false, guesses: 0 },
      },
    };
    socket.join(roomId);
    socket.emit("race:created", { roomId });
    console.log(`🏁 Race room created: ${roomId} by ${name}`);
  });

  // Join race room
  socket.on("race:join", ({ roomId, name }) => {
    const room = raceRooms[roomId];
    if (!room) { socket.emit("race:error", "Room tidak ditemukan!"); return; }

    room.players[socket.id] = { name, won: false, guesses: 0 };
    socket.join(roomId);
    socket.emit("race:joined", { solution: room.solution, lang: room.lang });

    // Tell everyone the updated player list
    io.to(roomId).emit("race:players", getPlayerList(room));
    console.log(`🏁 ${name} joined race room: ${roomId}`);
  });

  // Player makes a guess (for live scoreboard update)
  socket.on("race:guess", ({ roomId }) => {
    const room = raceRooms[roomId];
    if (!room || !room.players[socket.id]) return;
    room.players[socket.id].guesses += 1;
    io.to(roomId).emit("race:players", getPlayerList(room));
  });

  // Player wins race
  socket.on("race:win", ({ roomId, guesses }) => {
    const room = raceRooms[roomId];
    if (!room || room.winner) return;

    room.players[socket.id].won = true;
    room.players[socket.id].guesses = guesses;
    room.winner = { id: socket.id, name: room.players[socket.id].name, guesses };

    io.to(roomId).emit("race:players", getPlayerList(room));
    io.to(roomId).emit("race:winner", room.winner);
    console.log(`🏆 Race winner: ${room.winner.name} in room: ${roomId}`);
  });

  // Restart race (only host)
  socket.on("race:restart", ({ roomId, solution }) => {
    const room = raceRooms[roomId];
    if (!room || room.hostId !== socket.id) return;
    room.solution = solution;
    room.winner = null;
    Object.keys(room.players).forEach(pid => {
      room.players[pid].won = false;
      room.players[pid].guesses = 0;
    });
    io.to(roomId).emit("race:restarted", { solution, lang: room.lang });
    io.to(roomId).emit("race:players", getPlayerList(room));
    console.log(`🔄 Race restarted in room: ${roomId}`);
  });

  // Leave race room
  socket.on("race:leave", ({ roomId }) => {
    const room = raceRooms[roomId];
    if (room && room.players[socket.id]) {
      delete room.players[socket.id];
      if (Object.keys(room.players).length === 0) {
        delete raceRooms[roomId];
      } else {
        io.to(roomId).emit("race:players", getPlayerList(room));
      }
    }
    socket.leave(roomId);
  });

  // Player loses race
  socket.on("race:lose", ({ roomId }) => {
    const room = raceRooms[roomId];
    if (!room || !room.players[socket.id]) return;
    room.players[socket.id].won = false;
    room.players[socket.id].guesses = 6;
    io.to(roomId).emit("race:players", getPlayerList(room));
  });

  // Disconnect
  socket.on("disconnect", () => {
    console.log("🔴 Disconnected:", socket.id);
    // Notify battle rooms
    for (const [roomId, room] of Object.entries(battleRooms)) {
      if (room.p1?.id === socket.id || room.p2?.id === socket.id) {
        io.to(roomId).emit("battle:opponent_left");
        delete battleRooms[roomId];
      }
    }
    // Remove from race rooms
    for (const [roomId, room] of Object.entries(raceRooms)) {
      if (room.players[socket.id]) {
        delete room.players[socket.id];
        if (Object.keys(room.players).length === 0) {
          delete raceRooms[roomId];
        } else {
          io.to(roomId).emit("race:players", getPlayerList(room));
        }
      }
    }
  });
});

function getPlayerList(room) {
  return Object.entries(room.players)
    .map(([id, p]) => ({ id, ...p }))
    .sort((a, b) => {
      if (a.won && !b.won) return -1;
      if (!a.won && b.won) return 1;
      return (a.guesses || 99) - (b.guesses || 99);
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server jalan di http://localhost:${PORT}`);
});
