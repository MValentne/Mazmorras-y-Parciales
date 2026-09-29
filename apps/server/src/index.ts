import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server, type Socket } from "socket.io";
import { GAME_CONFIG, ROLE_ABILITIES, type Ability, type ClientEvents, type Player, type Role, type ServerEvents } from "@dungeon/shared";
import {
  clearTimers,
  forfeitPlayer,
  handleAnswer,
  buyShopItem,
  continueScene,
  continueFromShop,
  publicView,
  reconcileSceneReady,
  startGame,
  useAbility,
  validateDeck,
  validateDeckTitle,
  type EngineHooks,
  type GameRoom,
} from "./game.js";

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
const io = new Server<ClientEvents, ServerEvents>(httpServer, {
  cors: { origin: process.env.WEB_ORIGIN?.split(",") ?? "*" },
});

const rooms = new Map<string, GameRoom>();
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const cleanName = (value: string) => value.trim().replace(/\s+/g, " ");
function error(socketId: string, code: string, message: string) {
  io.to(socketId).emit("room:error", { code, message });
}
function publish(room: GameRoom) {
  room.updatedAt = Date.now();
  if (room.game) room.game.pending = room.remaining.length;
  io.to(room.code).emit("room:state", publicView(room));
}
const hooks: EngineHooks = {
  onState: publish,
  onReveal: (room, reveal) => io.to(room.code).emit("game:reveal", reveal),
  onAbility: (room, player, ability) => {
    if (player.role) io.to(room.code).emit("game:ability", { playerId: player.id, nickname: player.nickname, role: player.role, ability });
  },
  onShop: (room, coinsAwarded) => io.to(room.code).emit("game:shop", { coinsAwarded, enemiesDefeated: room.game?.enemiesDefeated ?? 0 }),
  onError: (room, playerId, code, message) => {
    const socketId = room.sockets.get(playerId);
    if (socketId) error(socketId, code, message);
  },
};
function findPlayer(room: GameRoom, playerId: string) { return room.players.find((p) => p.id === playerId); }
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
function attach(room: GameRoom, player: Player, socketId: string) {
  const previousSocket = room.sockets.get(player.id);
  if (previousSocket && previousSocket !== socketId) io.sockets.sockets.get(previousSocket)?.leave(room.code);
  player.online = true;
  room.sockets.set(player.id, socketId);
  const socket = io.sockets.sockets.get(socketId);
  socket?.join(room.code);
  socket?.data && (socket.data.playerId = player.id, socket.data.roomCode = room.code);
  publish(room);
}
function nicknameAvailable(room: GameRoom, nickname: string, exceptId?: string) {
  return !room.players.some((p) => p.id !== exceptId && p.nickname.toLocaleLowerCase() === nickname.toLocaleLowerCase());
}
const newPlayer = (id: string, nickname: string, isCreator: boolean): Player => ({
  id,
  nickname,
  role: null,
  online: true,
  isCreator,
  hp: GAME_CONFIG.playerMaxHp,
  maxHp: GAME_CONFIG.playerMaxHp,
  eliminated: false,
  coins: 0,
});

io.on("connection", (socket: Socket<ClientEvents, ServerEvents>) => {
  socket.on("room:create", ({ playerId, nickname }) => {
    const name = validNickname(nickname);
    if (!name) return error(socket.id, "INVALID_NICKNAME", "Usá un apodo de 2 a 18 caracteres (letras, números, espacios, punto, guion o _).");
    const code = newCode();
    const player = newPlayer(playerId, name, true);
    const room: GameRoom = {
      code,
      status: "lobby",
      creatorId: playerId,
      players: [player],
      settings: { questionTimeSeconds: GAME_CONFIG.questionTimeSeconds, cardCount: 0 },
      deck: null,
      game: null,
      updatedAt: Date.now(),
      sockets: new Map(),
      cards: [],
      timeline: [],
      remaining: [],
      drawn: null,
      discardedFor: null,
      wrongPlayers: new Set(),
      timers: {},
    };
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
    const player = newPlayer(playerId, name, false);
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

  const roomOf = (socket: Socket<ClientEvents, ServerEvents>) => {
    const code = socket.data.roomCode as string | undefined;
    const id = socket.data.playerId as string | undefined;
    const room = code ? rooms.get(code) : undefined;
    const player = room && id ? findPlayer(room, id) : undefined;
    return room && player && id && room.sockets.get(id) === socket.id ? { room, player } : null;
  };

  socket.on("game:forfeit", () => {
    const ctx = roomOf(socket);
    if (!ctx) return error(socket.id, "NOT_IN_ROOM", "No estás en una sala.");
    if (ctx.room.status !== "playing") return error(socket.id, "NOT_IN_GAME", "No hay una partida en curso para abandonar.");
    forfeitPlayer(ctx.room, hooks, ctx.player);
  });

  socket.on("room:leave", () => {
    const ctx = roomOf(socket);
    if (!ctx) return socket.emit("room:left");
    const { room, player } = ctx;
    if (room.status === "playing") forfeitPlayer(room, hooks, player);
    room.sockets.delete(player.id);
    socket.leave(room.code);
    socket.data.playerId = undefined;
    socket.data.roomCode = undefined;
    room.players = room.players.filter((p) => p.id !== player.id);
    if (room.creatorId === player.id) {
      const successor = room.players.find((p) => p.online) ?? room.players[0];
      if (successor) {
        room.creatorId = successor.id;
        for (const p of room.players) p.isCreator = p.id === successor.id;
      }
    }
    if (!room.players.length) {
      clearTimers(room);
      rooms.delete(room.code);
    } else if (room.status === "playing" && room.game?.currentScene) reconcileSceneReady(room, hooks);
    else publish(room);
    socket.emit("room:left");
  });

  socket.on("deck:upload", ({ title, cards, scenes, depth }) => {
    const ctx = roomOf(socket);
    if (!ctx) return error(socket.id, "NOT_IN_ROOM", "No estás en una sala.");
    const { room, player } = ctx;
    if (room.creatorId !== player.id) return error(socket.id, "NOT_CREATOR", "Solo quien creó la sala puede cargar el mazo.");
    if (room.status !== "lobby") return error(socket.id, "GAME_STARTED", "No se puede cambiar el mazo con la partida en curso.");
    const { cards: valid, scenes: validScenes, timeline, depth: validDepth, error: invalid } = validateDeck(scenes ? { scenes, depth } : cards);
    if (invalid) return error(socket.id, "INVALID_DECK", invalid);
    room.cards = valid;
    room.timeline = timeline;
    room.deck = { title: validateDeckTitle(title), size: valid.length, ...(validDepth ? { depth: validDepth } : {}), ...(validScenes.length ? { scenes: validScenes.length } : {}) };
    publish(room);
  });

  socket.on("game:start", () => {
    const ctx = roomOf(socket);
    if (!ctx) return error(socket.id, "NOT_IN_ROOM", "No estás en una sala.");
    const { room, player } = ctx;
    if (room.creatorId !== player.id) return error(socket.id, "NOT_CREATOR", "Solo quien creó la sala puede empezar la partida.");
    if (room.status !== "lobby") return error(socket.id, "GAME_STARTED", "La partida ya empezó.");
    if (!room.deck) return error(socket.id, "NO_DECK", "Cargá un mazo antes de empezar.");
    const sinRol = room.players.filter((p) => !p.role).map((p) => p.nickname);
    if (sinRol.length) return error(socket.id, "MISSING_ROLE", `Elegí rol para: ${sinRol.join(", ")}.`);
    startGame(room, hooks);
  });

  socket.on("game:answer", ({ answer }) => {
    const ctx = roomOf(socket);
    if (!ctx) return;
    handleAnswer(ctx.room, hooks, ctx.player, Number(answer));
  });

  socket.on("game:scene:continue", () => {
    const ctx = roomOf(socket);
    if (!ctx) return;
    continueScene(ctx.room, hooks, ctx.player);
  });

  socket.on("game:ability", ({ ability }) => {
    const ctx = roomOf(socket);
    if (!ctx) return;
    if (!Object.values(ROLE_ABILITIES).includes(ability)) return error(socket.id, "INVALID_ABILITY", "Esa habilidad no existe.");
    useAbility(ctx.room, hooks, ctx.player, ability as Ability);
  });

  socket.on("game:shop:buy", ({ item, targetId }) => {
    const ctx = roomOf(socket);
    if (!ctx) return;
    if (!["healing", "revive", "phoenix", "ward", "partyHeal", "bomb", "focus"].includes(item)) return error(socket.id, "INVALID_ITEM", "Ese objeto no está en la tienda.");
    buyShopItem(ctx.room, hooks, ctx.player, item, targetId);
  });

  socket.on("game:shop:continue", () => {
    const ctx = roomOf(socket);
    if (!ctx) return;
    continueFromShop(ctx.room, hooks, ctx.player);
  });

  socket.on("game:lobby", () => {
    const ctx = roomOf(socket);
    if (!ctx) return error(socket.id, "NOT_IN_ROOM", "No estás en una sala.");
    if (ctx.room.creatorId !== ctx.player.id) return error(socket.id, "NOT_CREATOR", "Solo quien creó la sala puede volver al lobby.");
    if (ctx.room.status !== "results") return error(socket.id, "NOT_IN_RESULTS", "La partida sigue en curso.");
    clearTimers(ctx.room);
    ctx.room.game = null;
    ctx.room.status = "lobby";
    for (const p of ctx.room.players) {
      p.hp = p.maxHp;
      p.eliminated = false;
    }
    publish(ctx.room);
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
    if (room.status === "playing" && room.game?.currentScene) reconcileSceneReady(room, hooks);
    else publish(room);
  });
});

setInterval(() => {
  const cutoff = Date.now() - GAME_CONFIG.roomInactiveMs;
  for (const [code, room] of rooms) {
    if (room.updatedAt >= cutoff) continue;
    io.to(code).emit("room:closed", { code, message: "La sala se cerró por inactividad." });
    clearTimers(room);
    rooms.delete(code);
  }
}, 60_000).unref();

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    for (const room of rooms.values()) clearTimers(room);
    io.close(() => httpServer.close(() => process.exit(0)));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}

const port = Number(process.env.PORT ?? 3001);
httpServer.listen(port, "0.0.0.0", () => console.log(`Dungeon server listening on ${port}`));
