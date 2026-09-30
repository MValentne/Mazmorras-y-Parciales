/**
 * Prueba end-to-end contra el server real por WebSocket: dos jugadores crean la
 * sala, suben un mazo, juegan y llegan a los dos finales posibles. Los mazos están
 * armados para que las respuestas sean deterministas (siempre 0 o siempre 1), así
 * que responder siempre un índice fijo produce aciertos o fallos sin azar.
 *
 *   node apps/server/test/e2e.mjs      (con el server en BASE, por defecto :3001)
 */
import assert from "node:assert/strict";
import { io } from "socket.io-client";
import { getContinuePhase } from "@dungeon/shared";

const BASE = process.env.BASE ?? "http://127.0.0.1:3001";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (name, fn) => {
  try { fn(); console.log(`  ✔ ${name}`); }
  catch (e) { failures.push(name); console.log(`  ✖ ${name}\n    ${e.message}`); }
};

const deckWith = (answer) => Array.from({ length: 4 }, (_, i) => ({
  prompt: `Pregunta ${i}`,
  options: ["Opción A", "Opción B"],
  answer,
  ...(i === 0 ? { explanation: "La explicación." } : {}),
}));

function client(playerId, nickname) {
  const socket = io(BASE, { transports: ["websocket"] });
  const state = { socket, playerId, nickname, room: null, reveals: [], errors: [], abilities: [], votes: [] };
  socket.on("room:state", (r) => { state.room = r; });
  socket.on("game:reveal", (r) => state.reveals.push(r));
  socket.on("game:ability", (effect) => state.abilities.push(effect));
  socket.on("game:vote", (vote) => state.votes.push(vote));
  socket.on("room:error", (e) => state.errors.push(e));
  return state;
}

const once = (socket, event) => new Promise((resolve) => socket.once(event, resolve));
async function until(label, check, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    await wait(50);
  }
  throw new Error(`Timeout esperando: ${label}`);
}

const a = client("pa", "Ana");
const b = client("pb", "Beto");
const beto = () => a.room.players.find((p) => p.id === "pb");
const ana = () => a.room.players.find((p) => p.id === "pa");

try {
  await Promise.all([once(a.socket, "connect"), once(b.socket, "connect")]);

  /* ---------- lobby ---------- */
  a.socket.emit("room:create", { playerId: "pa", nickname: "Ana" });
  const { code } = await once(a.socket, "room:created");
  b.socket.emit("room:join", { code, playerId: "pb", nickname: "Beto" });
  await once(b.socket, "room:joined");
  await until("dos jugadores", () => a.room?.players.length === 2);
  check("la sala tiene a los dos jugadores", () => assert.equal(a.room.players.length, 2));

  b.socket.emit("player:role", { role: "Guerrero" });
  a.socket.emit("player:role", { role: "Clérigo" });
  await until("roles", () => a.room.players.every((p) => p.role));
  check("los roles se sincronizan entre clientes", () => {
    assert.equal(ana().role, "Clérigo");
    assert.equal(beto().role, "Guerrero");
  });

  a.socket.emit("deck:upload", { title: "Mazo difícil", cards: deckWith(1) });
  await until("mazo", () => a.room.deck?.size === 4);
  check("el mazo cargado se ve en el lobby de todos", () => {
    assert.equal(a.room.deck.title, "Mazo difícil");
    assert.equal(b.room.deck.size, 4);
  });

  a.socket.emit("deck:upload", { title: "Malo", cards: [{ prompt: "x", options: ["a"], answer: 9 }] });
  await until("mazo inválido", () => a.errors.some((e) => e.code === "INVALID_DECK"));
  check("el server rechaza un mazo inválido con un mensaje claro", () =>
    assert.match(a.errors.at(-1).message, /opciones|fuera de rango/));
  check("el mazo bueno sigue intacto tras el rechazo", () => assert.equal(a.room.deck.title, "Mazo difícil"));

  b.socket.emit("deck:upload", { title: "Intruso", cards: deckWith(0) });
  await until("no-creator", () => b.errors.some((e) => e.code === "NOT_CREATOR"));
  check("solo el creador puede cargar el mazo", () => assert.equal(b.errors.at(-1).code, "NOT_CREATOR"));

  b.socket.emit("game:start");
  await wait(120);
  check("solo el creador puede arrancar", () => assert.equal(a.room.status, "lobby"));

  /* ---------- partida 1: derrota ---------- */
  a.socket.emit("game:start");
  await until("arranca", () => a.room.status === "playing");
  check("arranca con enemigo y primera carta", () => {
    assert.equal(a.room.game.enemy.hp > 0, true);
    assert.equal(a.room.game.current.options.length, 2);
    assert.equal(a.room.game.mastered, 0);
  });
  check("el estado por cable no filtra la respuesta correcta", () =>
    assert.equal(JSON.stringify(a.room).includes('"answer"'), false));
  check("los dos arrancan con la vida llena", () => {
    assert.equal(ana().hp, 3);
    assert.equal(beto().hp, 3);
  });

  await until("aparecen las opciones", () => Date.now() >= a.room.game.answerStartsAt);

  a.socket.emit("game:answer", { answer: 7, cardId: a.room.game.current.id });
  await wait(120);
  check("una respuesta fuera de rango se ignora", () => assert.equal(ana().hp, 3));

  b.socket.emit("player:role", { role: "Ladrón" });
  await wait(120);
  check("el rol no se puede cambiar con la partida en curso", () => assert.equal(beto().role, "Guerrero"));

  // Cada pregunta se resuelve al vencer el reloj y espera las dos confirmaciones.
  let rescued = false;
  while (a.room.status === "playing") {
    if (a.room.game.shopOpen && !a.room.players.some(p => !p.eliminated)) {
      check("la primera caída abre el rescate", () => assert.equal(rescued, false));
      a.socket.emit("game:shop:buy", { item: "revive" });
      await until("vial en mochila", () => ana().inventory.revive === 1);
      a.socket.emit("game:item:use", { item: "revive", targetId: "pa" });
      await until("Ana revive", () => ana().hp === 1);
      rescued = true;
    }
    if (a.room.game.encounter || a.room.game.reveal) {
      await wait(120);
      const turn = a.room.game.turnNumber;
      const phase = a.room.game.encounter;
      a.socket.emit("game:continue", { phase: getContinuePhase(a.room.game) });
      await wait(80);
      check("un solo continuar no cambia la fase", () => {
        assert.equal(a.room.game.turnNumber, turn);
        assert.equal(a.room.game.encounter, phase);
      });
      b.socket.emit("game:continue", { phase: getContinuePhase(a.room.game) });
      await until("avanza la fase", () => a.room.status === "results" || a.room.game.turnNumber !== turn || a.room.game.encounter !== phase);
    } else if (a.room.game.answerStartsAt <= Date.now()) {
      const turn = a.room.game.turnNumber;
      if (!ana().eliminated) a.socket.emit("game:answer", { answer: 0, cardId: a.room.game.current.id });
      if (!beto().eliminated) b.socket.emit("game:answer", { answer: 0, cardId: a.room.game.current.id });
      await until("resultado de fallo", () => !!a.room.game.reveal || a.room.game.turnNumber !== turn);
    } else await wait(30);
  }
  check("un segundo equipo caído pierde después de leer el resultado", () => assert.equal(a.room.game.outcome, "lost"));
  check("el cliente recibe los reveals de fallo", () => assert.equal(a.reveals.some((r) => !r.correct), true));

  b.socket.emit("game:lobby");
  await wait(120);
  check("el que no es creador no puede volver al lobby", () => assert.equal(a.room.status, "results"));

  a.socket.emit("game:lobby");
  await until("vuelve al lobby", () => a.room.status === "lobby");
  check("el creador rearma la sala y cura al grupo", () => {
    assert.equal(a.room.game, null);
    assert.equal(a.room.players.every((p) => p.hp === p.maxHp && !p.eliminated), true);
  });

  /* ---------- partida 2: victoria ---------- */
  a.socket.emit("deck:upload", { title: "Mazo fácil", cards: Array.from({ length: 13 }, (_, i) => ({ ...deckWith(0)[0], prompt: `Pregunta ${i}` })) });
  await until("mazo nuevo", () => a.room.deck?.title === "Mazo fácil");
  a.socket.emit("game:start");
  await until("segunda partida", () => a.room.status === "playing");
  check("la segunda partida arranca con el contador en cero", () => {
    assert.equal(a.room.game.mastered, 0);
    assert.equal(a.room.game.current !== null, true);
  });

  await until("poder habilitado", () => a.room.game.answerStartsAt <= Date.now());
  b.socket.emit("game:ability", { ability: "strike" });
  await until("poder compartido", () => a.abilities.length > 0 && b.abilities.length > 0);
  check("ambos clientes ven quién activa la habilidad", () => {
    assert.equal(a.abilities.at(-1).playerId, "pb");
    assert.deepEqual(a.abilities.at(-1), b.abilities.at(-1));
  });

  const seenEvents = [];
  let reconnected = false;
  let bought = false;
  const playUntil = Date.now() + 40000;
  while (a.room.status === "playing" && Date.now() < playUntil) {
    const game = a.room.game;
    if (game.reveal) {
      if (!reconnected) {
        b.socket.disconnect();
        await until("Beto desconectado", () => !beto().online);
        b.socket.connect();
        await once(b.socket, "connect");
        b.socket.emit("room:reconnect", { code, playerId: "pb" });
        await once(b.socket, "room:joined");
        check("reconectar recupera el resultado y el voto propio", () => {
          assert.deepEqual(b.room.game.reveal, game.reveal);
          assert.equal(b.votes.at(-1).answer, 0);
        });
        reconnected = true;
      }
      await wait(120);
      a.socket.emit("game:continue", { phase: getContinuePhase(a.room.game) }); b.socket.emit("game:continue", { phase: getContinuePhase(a.room.game) });
      await until("sale del resultado", () => !a.room.game.reveal || a.room.status === "results");
    } else if (game.encounter) {
      seenEvents.push(game.encounter);
      if (game.encounter === "shop" && !bought) {
        const stock = ana().inventory.healing;
        a.socket.emit("game:shop:buy", { item: "healing" });
        await until("compra guardada", () => ana().inventory.healing === stock + 1);
        check("comprar no consume la poción con vida llena", () => assert.equal(ana().hp, 3));
        bought = true;
      } else if (game.encounter !== "shop") {
        const choice = game.encounter === "campfire" ? "focus" : "item";
        a.socket.emit("game:event:claim", { choice }); b.socket.emit("game:event:claim", { choice });
        await until("premios del evento", () => a.room.game.encounterClaimed.length === 2);
      }
      a.socket.emit("game:continue", { phase: getContinuePhase(a.room.game) }); b.socket.emit("game:continue", { phase: getContinuePhase(a.room.game) });
      await until("sale del encuentro", () => !a.room.game.encounter);
    } else if (game.answerStartsAt <= Date.now() && game.deadline > Date.now()) {
      a.socket.emit("game:answer", { answer: 0, cardId: a.room.game.current.id }); b.socket.emit("game:answer", { answer: 0, cardId: a.room.game.current.id });
      await until("resultado correcto", () => !!a.room.game.reveal);
    } else await wait(30);
  }
  await until("fin por victoria", () => a.room.status === "results");
  check("el contador separa preguntas y aciertos individuales", () => {
    assert.equal(a.room.game.outcome, "won");
    assert.equal(a.room.game.mastered, 13);
    assert.equal(a.room.game.correctAnswers, 26);
    assert.equal(ana().correctAnswers, 13);
    assert.equal(a.room.game.pending, 0);
  });
  check("se recorren tiendas y tres nuevos eventos", () => assert.deepEqual(seenEvents, ["shop", "campfire", "shop", "treasure", "shop", "shrine"]));
  check("el reveal trae la explicación cuando la carta la tiene", () =>
    assert.equal(a.reveals.some((r) => r.explanation === "La explicación."), true));
} catch (e) {
  failures.push("excepción");
  console.log(`  ✖ Excepción: ${e.stack}`);
} finally {
  a.socket.close();
  b.socket.close();
}

console.log(failures.length ? `\n${failures.length} fallo(s).` : "\nTodo OK.");
process.exit(failures.length ? 1 : 0);
