import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import { GAME_CONFIG, type Player, type Role, type RoomState } from "@dungeon/shared";

const app = express();
app.use(cors());
app.get("/health", (_req, res) => res.json({ ok: true }));
const webDir = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const indexHtml = path.join(webDir, "index.html");
if (existsSync(indexHtml)) {
  app.use(express.static(webDir));
  app.get("*", (_req, res) => res.sendFile(indexHtml));
} else {
  console.warn(`No se encontró el frontend compilado en ${webDir}. Ejecutá "npm run build" desde la raíz.`);
}
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: process.env.WEB_ORIGIN?.split(",") ?? "*" } });

type Room = RoomState & { sockets: Map<string, string> };
const rooms = new Map<string, Room>();
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const cleanName = (value: string) => value.trim().replace(/\s+/g, " ");
function error(socketId: string, code: string, message: string) {
  io.to(socketId).emit("room:error", { code, message });
}
function snapshot(room: Room): RoomState {
  const { sockets: _sockets, ...state } = room;
  return { ...state, players: state.players.map((p) => ({ ...p })) };
}
function publish(room: Room) {
  room.updatedAt = Date.now();
  io.to(room.code).emit("room:state", snapshot(room));
}
function findPlayer(room: Room, playerId: string) { return room.players.find((p) => p.id === playerId); }
function validNickname(raw: string) {
  const name = cleanName(raw);
  return name.length >= GAME_CONFIG.nicknameMinLength && name.length <= GAME_CONFIG.nicknameMaxLength && /^[\p{L}\p{N} _.-]+$/u.test(name) ? name : null;
}
function newCode() {
  let code = "";
  do {
    code = Array.from({ length: GAME_CONFIG.roomCodeLength }, () => alphabet[randomInt(alphabet.length)]).join("");
  } while (rooms.has(code));
  return code;
}
function attach(room: Room, player: Player, socketId: string) {
  const previousSocket = room.sockets.get(player.id);
  if (previousSocket && previousSocket !== socketId) io.sockets.sockets.get(previousSocket)?.leave(room.code);
  player.online = true;
  room.sockets.set(player.id, socketId);
  const socket = io.sockets.sockets.get(socketId);
  socket?.join(room.code);
  socket?.data && (socket.data.playerId = player.id, socket.data.roomCode = room.code);
  publish(room);
}
function nicknameAvailable(room: Room, nickname: string, exceptId?: string) {
  return !room.players.some((p) => p.id !== exceptId && p.nickname.toLocaleLowerCase() === nickname.toLocaleLowerCase());
}

io.on("connection", (socket) => {
  socket.on("room:create", ({ playerId, nickname }) => {
    const name = validNickname(nickname);
    if (!name) return error(socket.id, "INVALID_NICKNAME", "Usá un apodo de 2 a 18 caracteres (letras, números, espacios, punto, guion o _).");
    const code = newCode();
    const player: Player = { id: playerId, nickname: name, role: null, online: true, isCreator: true };
    const room: Room = { code, status: "lobby", creatorId: playerId, players: [player], settings: { questionTimeSeconds: 20, cardCount: 10 }, updatedAt: Date.now(), sockets: new Map() };
    rooms.set(code, room);
    attach(room, player, socket.id);
    socket.emit("room:created", { code });
  });

  socket.on("room:join", ({ code: rawCode, playerId, nickname }) => {
    const code = rawCode.trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return error(socket.id, "ROOM_NOT_FOUND", "No encontramos esa sala. Puede que el código sea incorrecto o la sala haya cerrado.");
    const existing = findPlayer(room, playerId);
    if (existing) {
      attach(room, existing, socket.id);
      socket.emit("room:joined", { code });
      return;
    }
    if (room.status !== "lobby") return error(socket.id, "GAME_STARTED", "La partida ya empezó y no se pueden sumar jugadores nuevos.");
    const name = validNickname(nickname);
    if (!name) return error(socket.id, "INVALID_NICKNAME", "Usá un apodo de 2 a 18 caracteres (letras, números, espacios, punto, guion o _).");
    if (!nicknameAvailable(room, name)) return error(socket.id, "NICKNAME_TAKEN", "Ese apodo ya está en uso en esta sala.");
    if (room.players.length >= GAME_CONFIG.maxPlayers) return error(socket.id, "ROOM_FULL", `La sala llegó al límite de ${GAME_CONFIG.maxPlayers} jugadores.`);
    const player: Player = { id: playerId, nickname: name, role: null, online: true, isCreator: false };
    room.players.push(player);
    attach(room, player, socket.id);
    socket.emit("room:joined", { code });
  });

  socket.on("room:reconnect", ({ code: rawCode, playerId }) => {
    const code = rawCode.trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return error(socket.id, "ROOM_NOT_FOUND", "Esta sala ya no existe. Volvé al inicio para crear otra o unirte a una sala.");
    const player = findPlayer(room, playerId);
    if (!player) return error(socket.id, "PLAYER_NOT_FOUND", "No encontramos tu lugar en esta sala. Volvé al inicio para entrar de nuevo.");
    attach(room, player, socket.id);
    socket.emit("room:joined", { code });
  });

  socket.on("player:role", ({ role }) => {
    const code = socket.data.roomCode as string | undefined;
    const id = socket.data.playerId as string | undefined;
    const room = code ? rooms.get(code) : undefined;
    const player = room && id ? findPlayer(room, id) : undefined;
    if (!room || !player || room.status !== "lobby") return;
    if (!GAME_CONFIG.roles.includes(role as Role)) return error(socket.id, "INVALID_ROLE", "Ese rol no está disponible.");
    player.role = role;
    publish(room);
  });

  socket.on("disconnect", () => {
    const code = socket.data.roomCode as string | undefined;
    const id = socket.data.playerId as string | undefined;
    const room = code ? rooms.get(code) : undefined;
    const player = room && id ? findPlayer(room, id) : undefined;
    if (!room || !player || room.sockets.get(id!) !== socket.id) return;
    player.online = false;
    room.sockets.delete(id!);
    if (room.creatorId === id) {
      const successor = room.players.find((p) => p.online) ?? room.players.find((p) => p.id !== id);
      if (successor) {
        room.creatorId = successor.id;
        for (const p of room.players) p.isCreator = p.id === successor.id;
      }
    }
    publish(room);
  });
});

setInterval(() => {
  const cutoff = Date.now() - GAME_CONFIG.roomInactiveMs;
  for (const [code, room] of rooms) {
    if (room.updatedAt >= cutoff) continue;
    io.to(code).emit("room:closed", { code, message: "La sala se cerró por inactividad." });
    rooms.delete(code);
  }
}, 60_000).unref();

const port = Number(process.env.PORT ?? 3001);
httpServer.listen(port, "0.0.0.0", () => console.log(`Dungeon server listening on ${port}`));
