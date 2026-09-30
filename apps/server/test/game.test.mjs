import assert from "node:assert/strict";
import { afterEach, before, describe, it } from "node:test";
import { GAME_CONFIG } from "@dungeon/shared";
import { buyShopItem, useItem, continueGame, claimEncounter, reconcileContinue, reconcileVotes, continueScene, reconcileSceneReady, forfeitPlayer, clearTimers, handleAnswer, publicView, startGame, useAbility, validateDeck } from "../dist/game.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const last = (arr) => arr[arr.length - 1];

const deck = () => [
  { id: "c0", prompt: "P0", options: ["a", "b", "c", "d"], answer: 2, explanation: "porque sí" },
  { id: "c1", prompt: "P1", options: ["a", "b", "c", "d"], answer: 0 },
  { id: "c2", prompt: "P2", options: ["a", "b", "c", "d"], answer: 1 },
  { id: "c3", prompt: "P3", options: ["a", "b", "c", "d"], answer: 3 },
];

/** Cada test trae su propio juego de gathers: si no, los rooms de tests anteriores
 *  siguen emitiendo timeouts en background y contaminan las aserciones. */
function makeRoom(roles = ["Guerrero", "Mago"], cards = deck()) {
  const reveals = [];
  const errors = [];
  const hooks = {
    onState: () => {},
    onReveal: (_room, reveal) => reveals.push(reveal),
    onError: (_room, _playerId, code, message) => errors.push({ code, message }),
  };
  const room = {
    code: "TEST",
    status: "lobby",
    creatorId: "p0",
    players: roles.map((role, i) => ({
      id: `p${i}`,
      nickname: `P${i}`,
      role,
      online: true,
      isCreator: i === 0,
      hp: GAME_CONFIG.playerMaxHp,
      maxHp: GAME_CONFIG.playerMaxHp,
      eliminated: false,
    })),
    settings: { questionTimeSeconds: GAME_CONFIG.questionTimeSeconds, cardCount: 0 },
    deck: { title: "Test", size: cards.length },
    game: null,
    updatedAt: Date.now(),
    sockets: new Map(),
    cards,
    remaining: [],
    drawn: null,
    discardedFor: null,
    timers: {},
  };
  openRooms.push(room);
  return { room, hooks, reveals, errors };
}

/**
 * Arranca la partida con un enemigo SIN rasgo. El enemigo se sortea al azar y su
 * rasgo altera el daño y la cantidad de opciones, así que para medir una habilidad
 * puntual hay que descartar los sorteos que vengan con rasgo.
 */
function started(roles, cards) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const ctx = makeRoom(roles, cards);
    startGame(ctx.room, ctx.hooks);
    if (ctx.room.game.enemy.trait === null) return ctx;
    clearTimers(ctx.room);
  }
  throw new Error("no salió ningún enemigo sin rasgo en 40 intentos");
}

const wrongAnswer = (room) => room.game.visibleOptions.find(i => i !== room.drawn.answer);

const openRooms = [];

before(() => {
  GAME_CONFIG.answerRevealMs = 5;
  GAME_CONFIG.promptPreviewSeconds = 0;
  GAME_CONFIG.questionTimeSeconds = 0.08;
});

afterEach(() => {
  for (const room of openRooms) clearTimers(room);
  openRooms.length = 0;
});

describe("validateDeck", () => {
  it("rechaza preguntas sin prompt, sin opciones, repetidas o con respuesta fuera de rango", () => {
    assert.match(validateDeck([{ prompt: "", options: ["a", "b"], answer: 0 }]).error, /sin pregunta/);
    assert.match(validateDeck([{ prompt: "P", options: ["a"], answer: 0 }]).error, /opciones/);
    assert.match(validateDeck([{ prompt: "P", options: ["a", "b"], answer: 5 }]).error, /fuera de rango/);
    assert.match(validateDeck([{ prompt: "P", options: ["a", "a"], answer: 0 }]).error, /repite/);
    assert.match(validateDeck([]).error, /vacío/);
  });

  it("acepta un mazo válido y normaliza los espacios", () => {
    const result = validateDeck([{ prompt: "  ¿Qué   es? ", options: [" a ", "b"], answer: 1 }]);
    assert.equal(result.error, null);
    assert.deepEqual(result.cards[0], { id: "c0", prompt: "¿Qué es?", options: ["a", "b"], answer: 1 });
  });
});

describe("publicView", () => {
  it("nunca filtra la respuesta ni la explicación de la carta en juego", () => {
    const { room } = started();
    const correct = room.drawn.answer;
    assert.notEqual(JSON.stringify(publicView(room)).includes(`"answer":${correct}`), true, "se filtró la respuesta");
    assert.equal(publicView(room).game.current.answer, undefined);
    assert.equal(publicView(room).game.current.explanation, undefined);
    assert.equal(publicView(room).cards, undefined);
    assert.equal(publicView(room).remaining, undefined);
    assert.equal(publicView(room).drawn, undefined);
  });
});

async function resolve(ctx, picks = ctx.room.players.map(() => ctx.room.drawn.answer)) {
  const { room, hooks } = ctx;
  for (const [i, player] of room.players.entries()) if (picks[i] !== null) handleAnswer(room, hooks, player, picks[i]);
  await sleep(Math.max(0, room.game.deadline - Date.now()) + 15);
  assert.ok(room.game.reveal, "el reloj debe publicar el resultado");
}
async function next(ctx) {
  await sleep(GAME_CONFIG.answerRevealMs + 1);
  for (const p of ctx.room.players.filter(p => p.online)) continueGame(ctx.room, ctx.hooks, p);
}
async function leaveEvent(ctx) {
  if (ctx.room.game.encounter) await next(ctx);
}

describe("voto, reloj y estadísticas", () => {
  it("todos votan sin revelar ni dañar antes del reloj y cada carta cuenta una sola vez", async () => {
    const ctx = started();
    const { room, hooks } = ctx;
    const hp = room.game.enemy.hp;
    for (const p of room.players) handleAnswer(room, hooks, p, room.drawn.answer);
    assert.equal(room.game.reveal, null);
    assert.equal(room.game.enemy.hp, hp);
    assert.equal(room.game.votesReceived, 2);
    await resolve(ctx);
    assert.equal(room.game.enemy.hp, hp - 2);
    assert.equal(room.game.mastered, 1);
    assert.equal(room.game.correctAnswers, 2);
    assert.equal(room.game.totalQuestions, 4);
    assert.equal(room.game.pending, 3);
    assert.equal(room.players[0].correctAnswers, 1);
  });
  it("distingue el voto propio incorrecto aunque un compañero acierte", async () => {
    const ctx = started();
    const answer = ctx.room.drawn.answer;
    await resolve(ctx, [wrongAnswer(ctx.room), answer]);
    assert.equal(ctx.room.players[0].hp, 2);
    assert.equal(ctx.room.players[1].hp, 3);
    assert.equal(ctx.room.game.reveal.correctVotes, 1);
    assert.equal(ctx.room.game.reveal.wrongVotes, 1);
    assert.equal(ctx.room.game.reveal.answer, answer);
    assert.equal(ctx.room.players[0].correctAnswers, 0);
    assert.equal(ctx.room.players[0].answersGiven, 1);
  });
  it("ignora votos duplicados, inválidos y opciones ocultas", async () => {
    const ctx = started(["Mago", "Guerrero"]);
    const { room, hooks } = ctx;
    useAbility(room, hooks, room.players[0], "discard");
    const hidden = room.drawn.options.findIndex((_, i) => !room.game.visibleOptions.includes(i));
    for (const value of [hidden, -1, 7, NaN, 1.2]) handleAnswer(room, hooks, room.players[0], value);
    assert.equal(room.votes.size, 0);
    handleAnswer(room, hooks, room.players[0], room.drawn.answer);
    handleAnswer(room, hooks, room.players[0], wrongAnswer(room));
    assert.equal(room.votes.get("p0"), room.drawn.answer);
    await resolve(ctx);
    assert.equal(room.players[0].correctAnswers, 1);
  });
  it("rechaza respuestas y habilidades durante el preview", () => {
    const { room, hooks, errors } = started();
    room.game.answerStartsAt = Date.now() + 1000;
    handleAnswer(room, hooks, room.players[0], room.drawn.answer);
    useAbility(room, hooks, room.players[0], "strike");
    assert.equal(room.votes.size, 0);
    assert.equal(errors.length, 2);
    assert.ok(errors.every(e => e.code === "QUESTION_PREVIEW"));
  });
  it("el timeout cuenta al ausente como fallo pero respeta el acierto enviado", async () => {
    const ctx = started();
    await resolve(ctx, [ctx.room.drawn.answer, null]);
    assert.equal(ctx.room.players[0].hp, 3);
    assert.equal(ctx.room.players[1].hp, 2);
    assert.equal(ctx.room.game.reveal.damage, 1);
    assert.equal(ctx.room.game.correctAnswers, 1);
  });
  it("no repite daño ni estadísticas al desconectarse durante el resultado", async () => {
    const ctx = started();
    await resolve(ctx);
    const hp = ctx.room.game.enemy.hp;
    ctx.room.players[1].online = false;
    reconcileVotes(ctx.room, ctx.hooks);
    reconcileVotes(ctx.room, ctx.hooks);
    assert.equal(ctx.room.game.enemy.hp, hp);
    assert.equal(ctx.room.game.correctAnswers, 2);
    assert.equal(ctx.reveals.length, 1);
  });
  it("un voto enviado antes de desconectarse sigue contando", async () => {
    const ctx = started();
    handleAnswer(ctx.room, ctx.hooks, ctx.room.players[1], ctx.room.drawn.answer);
    ctx.room.players[1].online = false;
    await resolve(ctx, [ctx.room.drawn.answer, null]);
    assert.equal(ctx.room.game.correctAnswers, 2);
  });
  it("el estado de reconexión conserva el resultado y no expone los votos privados", async () => {
    const ctx = started();
    assert.equal(publicView(ctx.room).votes, undefined);
    assert.equal(publicView(ctx.room).wrongPlayers, undefined);
    await resolve(ctx);
    assert.deepEqual(publicView(ctx.room).game.reveal, ctx.reveals[0]);
  });
});

describe("continuación colectiva", () => {
  it("nunca avanza solo y espera a todos, incluidos los caídos", async () => {
    const ctx = started();
    ctx.room.players[1].hp = 1;
    await resolve(ctx, [ctx.room.drawn.answer, wrongAnswer(ctx.room)]);
    const id = ctx.room.game.current.id;
    await sleep(100);
    assert.equal(ctx.room.game.current.id, id);
    continueGame(ctx.room, ctx.hooks, ctx.room.players[0]);
    continueGame(ctx.room, ctx.hooks, ctx.room.players[0]);
    assert.deepEqual(ctx.room.game.continueReady, ["p0"]);
    assert.equal(ctx.room.game.current.id, id);
    continueGame(ctx.room, ctx.hooks, ctx.room.players[1]);
    assert.notEqual(ctx.room.game.current.id, id);
  });
  it("ignora continuar durante la pregunta y la animación inicial", async () => {
    const ctx = started();
    continueGame(ctx.room, ctx.hooks, ctx.room.players[0]);
    assert.deepEqual(ctx.room.game.continueReady, []);
    await resolve(ctx);
    ctx.room.game.revealedAt = Date.now() + 1000;
    continueGame(ctx.room, ctx.hooks, ctx.room.players[0]);
    assert.deepEqual(ctx.room.game.continueReady, []);
  });
  it("la desconexión libera una confirmación pendiente", async () => {
    const ctx = started();
    await resolve(ctx);
    continueGame(ctx.room, ctx.hooks, ctx.room.players[0]);
    ctx.room.players[1].online = false;
    reconcileContinue(ctx.room, ctx.hooks);
    assert.equal(ctx.room.game.turnNumber, 2);
  });
  it("todos desconectados abandonan tanto en pregunta como en evento", () => {
    for (const encounter of [null, "shop"]) {
      const ctx = started();
      ctx.room.game.encounter = encounter;
      for (const p of ctx.room.players) p.online = false;
      reconcileContinue(ctx.room, ctx.hooks);
      assert.equal(ctx.room.game.outcome, "abandoned");
      assert.equal(ctx.room.status, "results");
    }
  });
  it("la última pregunta también espera confirmación antes de la victoria", async () => {
    const ctx = started(undefined, [deck()[0]]);
    await resolve(ctx);
    assert.equal(ctx.room.status, "playing");
    await next(ctx);
    assert.equal(ctx.room.status, "results");
    assert.equal(ctx.room.game.outcome, "won");
    assert.equal(ctx.room.game.mastered, 1);
    assert.equal(ctx.room.game.correctAnswers, 2);
  });
});

describe("habilidades y combate", () => {
  it("Golpe demoledor agrega dos daños, o uno contra blindados", async () => {
    for (const trait of [null, "blindado"]) {
      const ctx = started();
      ctx.room.game.enemy.trait = trait;
      ctx.room.game.enemy.hp = ctx.room.game.enemy.maxHp = 20;
      useAbility(ctx.room, ctx.hooks, ctx.room.players[0], "strike");
      await resolve(ctx);
      assert.equal(ctx.room.game.reveal.damage, trait ? 3 : 4);
      assert.ok(!ctx.room.game.usedAbilities.p0.includes("strike"));
    }
  });
  it("el escudo del Ladrón se consume una sola vez, entre preguntas distintas", async () => {
    const ctx = started(["Ladrón", "Mago"]);
    useAbility(ctx.room, ctx.hooks, ctx.room.players[0], "evade");
    await resolve(ctx, [wrongAnswer(ctx.room), ctx.room.drawn.answer]);
    assert.equal(ctx.room.players[0].hp, 3);
    await next(ctx);
    await resolve(ctx, [wrongAnswer(ctx.room), ctx.room.drawn.answer]);
    assert.equal(ctx.room.players[0].hp, 2);
  });
  it("el Mago conserva la correcta y no puede repetir el poder sin recargar", () => {
    const { room, hooks, errors } = started(["Mago", "Clérigo"]);
    useAbility(room, hooks, room.players[0], "discard");
    assert.equal(room.game.visibleOptions.length, 2);
    assert.ok(room.game.visibleOptions.includes(room.drawn.answer));
    useAbility(room, hooks, room.players[0], "discard");
    assert.equal(last(errors).code, "ABILITY_COOLDOWN");
  });
  it("no reordena las opciones durante el resultado", async () => {
    const ctx = started(["Mago", "Guerrero"]);
    useAbility(ctx.room, ctx.hooks, ctx.room.players[0], "discard");
    const visible = [...ctx.room.game.visibleOptions];
    await resolve(ctx);
    assert.deepEqual(ctx.room.game.visibleOptions, visible);
  });
  it("el Espectro muestra tres opciones y siempre incluye la correcta", async () => {
    const ctx = started();
    ctx.room.game.enemy.trait = "mudo";
    ctx.room.game.enemy.hp = 20;
    await resolve(ctx);
    await next(ctx);
    assert.equal(ctx.room.game.visibleOptions.length, 3);
    assert.ok(ctx.room.game.visibleOptions.includes(ctx.room.drawn.answer));
  });
  it("sanación y tónico curan correctamente; un intento sin efecto no gasta recarga", () => {
    const { room, hooks, errors } = started(["Clérigo", "Alquimista"]);
    useAbility(room, hooks, room.players[0], "heal");
    assert.equal(last(errors).code, "TEAM_AT_FULL_HEALTH");
    assert.equal(room.game.abilityReadyAt.p0, undefined);
    room.players[1].hp = 1;
    useAbility(room, hooks, room.players[0], "heal");
    assert.equal(room.players[1].hp, 3);
    room.players[0].hp = 1;
    room.players[1].hp = 2;
    useAbility(room, hooks, room.players[1], "potion");
    assert.deepEqual(room.players.map(p => p.hp), [2, 3]);
  });
  it("el Bardo puede extender el reloj incluso después de votar", () => {
    const { room, hooks } = started(["Bardo", "Mago"]);
    const deadline = room.game.deadline;
    handleAnswer(room, hooks, room.players[0], room.drawn.answer);
    useAbility(room, hooks, room.players[0], "extend");
    assert.equal(room.game.deadline - deadline, GAME_CONFIG.bardAbilitySeconds * 1000);
  });
  it("el Paladín bloquea el daño grupal de un enemigo furioso", async () => {
    const ctx = started(["Paladín", "Mago"]);
    ctx.room.game.enemy.trait = "furioso";
    useAbility(ctx.room, ctx.hooks, ctx.room.players[0], "ward");
    await resolve(ctx, [wrongAnswer(ctx.room), wrongAnswer(ctx.room)]);
    assert.ok(ctx.room.players.every(p => p.hp === 3));
    assert.equal(ctx.room.game.teamWard, false);
    assert.equal(ctx.room.game.reveal.wardBlocked, true);
  });
  it("Marca de presa persiste después de una ronda sin aciertos", async () => {
    const ctx = started(["Explorador", "Mago"]);
    useAbility(ctx.room, ctx.hooks, ctx.room.players[0], "track");
    await resolve(ctx, [wrongAnswer(ctx.room), wrongAnswer(ctx.room)]);
    await next(ctx);
    assert.ok(ctx.room.game.usedAbilities.p0.includes("track"));
    await resolve(ctx);
    assert.equal(ctx.room.game.reveal.damage, 3);
  });
  it("las habilidades ajenas, caídos y resultados no pueden activar poderes", async () => {
    const ctx = started();
    useAbility(ctx.room, ctx.hooks, ctx.room.players[0], "heal");
    assert.equal(last(ctx.errors).code, "INVALID_ABILITY");
    ctx.room.players[0].eliminated = true;
    useAbility(ctx.room, ctx.hooks, ctx.room.players[0], "strike");
    assert.equal(last(ctx.errors).code, "ELIMINATED");
    await resolve(ctx, [null, ctx.room.drawn.answer]);
    ctx.room.players[0].eliminated = false;
    useAbility(ctx.room, ctx.hooks, ctx.room.players[0], "strike");
    assert.equal(ctx.room.game.abilityReadyAt.p0, undefined);
  });
});

describe("mochila, eventos y rescate", () => {
  it("comprar guarda el objeto aunque no haga falta y usar sin efecto no lo consume", () => {
    const { room, hooks, errors } = started();
    const p = room.players[0];
    buyShopItem(room, hooks, p, "healing");
    assert.equal(p.inventory.healing, 1, "fuera de la tienda no se compra");
    room.game.shopOpen = true;
    buyShopItem(room, hooks, p, "healing");
    assert.equal(p.inventory.healing, 2);
    assert.equal(p.coins, 0);
    useItem(room, hooks, p, "healing");
    assert.equal(last(errors).code, "HEAL_NOT_NEEDED");
    assert.equal(p.inventory.healing, 2);
    buyShopItem(room, hooks, p, "bomb");
    assert.equal(last(errors).code, "NOT_ENOUGH_COINS");
  });
  it("las pociones funcionan en preview, después del voto, resultado, escena y evento", async () => {
    const ctx = started();
    const { room, hooks } = ctx;
    const p = room.players[0];
    p.inventory.healing = 5;
    for (const phase of ["preview", "vote", "reveal", "scene", "shop"]) {
      p.hp = 1;
      if (phase === "preview") room.game.answerStartsAt = Date.now() + 10;
      if (phase === "vote") { room.game.answerStartsAt = Date.now() - 1; handleAnswer(room, hooks, p, room.drawn.answer); }
      if (phase === "reveal") await resolve(ctx);
      if (phase === "scene") room.game.currentScene = { id: "s", beats: [] };
      if (phase === "shop") room.game.shopOpen = true;
      useItem(room, hooks, p, "healing");
      assert.equal(p.hp, 3, phase);
    }
    assert.equal(p.inventory.healing, 0);
    useItem(room, hooks, p, "bomb");
    assert.equal(room.game.bonusDamage, 0);
  });
  it("bomba y escudo permanecen preparados si nadie los activa", async () => {
    const ctx = started();
    const p = ctx.room.players[0];
    p.inventory.bomb = 2;
    p.inventory.ward = 1;
    useItem(ctx.room, ctx.hooks, p, "bomb");
    useItem(ctx.room, ctx.hooks, p, "bomb");
    assert.equal(p.inventory.bomb, 1);
    await resolve(ctx, [wrongAnswer(ctx.room), wrongAnswer(ctx.room)]);
    assert.equal(ctx.room.game.bonusDamage, 2);
    useItem(ctx.room, ctx.hooks, p, "ward");
    await next(ctx);
    await resolve(ctx);
    assert.equal(ctx.room.game.reveal.damage, 4);
    assert.equal(ctx.room.game.bonusDamage, 0);
    assert.equal(ctx.room.game.teamWard, true);
  });
  it("viales validan el objetivo; fénix revive al grupo; enfoque recarga y botiquín cura", () => {
    const { room, hooks } = started();
    const p = room.players[0];
    p.inventory = { revive: 1, phoenix: 1, focus: 1, partyHeal: 1 };
    useItem(room, hooks, p, "revive", "inexistente");
    assert.equal(p.inventory.revive, 1);
    room.players[1].hp = 0;
    room.players[1].eliminated = true;
    useItem(room, hooks, p, "revive", room.players[1].id);
    assert.equal(room.players[1].hp, 1);
    for (const mate of room.players) { mate.hp = 0; mate.eliminated = true; }
    useItem(room, hooks, p, "phoenix");
    assert.ok(room.players.every(p => p.hp === 1 && !p.eliminated));
    useItem(room, hooks, p, "partyHeal");
    assert.ok(room.players.every(p => p.hp === 2));
    room.game.abilityReadyAt.p0 = 100;
    useItem(room, hooks, p, "focus");
    assert.equal(room.game.abilityReadyAt.p0, room.game.turnNumber);
  });
  it("al caer todos primero se lee el resultado, luego hay un rescate y después derrota", async () => {
    const ctx = started();
    for (const p of ctx.room.players) p.hp = 1;
    await resolve(ctx, [wrongAnswer(ctx.room), wrongAnswer(ctx.room)]);
    assert.equal(ctx.room.game.shopOpen, false);
    await next(ctx);
    assert.equal(ctx.room.game.shopOpen, true);
    assert.equal(ctx.room.game.emergencyRescueGranted, true);
    continueGame(ctx.room, ctx.hooks, ctx.room.players[0]);
    assert.equal(last(ctx.errors).code, "PARTY_DOWN");
    buyShopItem(ctx.room, ctx.hooks, ctx.room.players[0], "revive");
    useItem(ctx.room, ctx.hooks, ctx.room.players[0], "revive", "p0");
    await next(ctx);
    await resolve(ctx, [wrongAnswer(ctx.room), null]);
    await next(ctx);
    assert.equal(ctx.room.status, "results");
    assert.equal(ctx.room.game.outcome, "lost");
  });
  it("los encuentros aparecen cada dos preguntas y sus recompensas no se duplican", async () => {
    const cards = Array.from({ length: 13 }, (_, i) => ({ ...deck()[0], id: `q${i}` }));
    const ctx = started(undefined, cards);
    const events = [];
    while (ctx.room.status === "playing") {
      await resolve(ctx);
      await next(ctx);
      const g = ctx.room.game;
      if (g.encounter) {
        events.push(g.encounter);
        assert.equal(g.deadline, 0);
        const p = ctx.room.players[0];
        if (g.encounter !== "shop") {
          const choice = g.encounter === "campfire" ? "heal" : g.encounter === "treasure" ? "coins" : "item";
          claimEncounter(ctx.room, ctx.hooks, p, "invalido");
          assert.deepEqual(g.encounterClaimed, []);
          claimEncounter(ctx.room, ctx.hooks, p, choice);
          const state = JSON.stringify(p);
          claimEncounter(ctx.room, ctx.hooks, p, choice);
          assert.equal(JSON.stringify(p), state);
        }
        await leaveEvent(ctx);
      }
    }
    assert.deepEqual(events, ["shop", "campfire", "shop", "treasure", "shop", "shrine"]);
    assert.equal(ctx.room.game.mastered, 13);
    assert.equal(ctx.room.game.correctAnswers, 26);
  });
  it("las escenas esperan a todos y no cuentan como preguntas pendientes", () => {
    const ctx = makeRoom();
    const scene = { id: "s0", title: "Sala", setting: "Lugar", objective: "Seguir", beats: [{ heading: "A", text: "B" }] };
    ctx.room.timeline = [{ type: "scene", scene }, ...ctx.room.cards.map(card => ({ type: "question", card }))];
    startGame(ctx.room, ctx.hooks);
    assert.equal(ctx.room.game.pending, 4);
    continueScene(ctx.room, ctx.hooks, ctx.room.players[0]);
    assert.equal(ctx.room.game.currentScene.id, "s0");
    ctx.room.players[1].online = false;
    reconcileSceneReady(ctx.room, ctx.hooks);
    assert.equal(ctx.room.game.currentScene, null);
    assert.equal(ctx.room.game.scenesCompleted, 1);
    assert.equal(ctx.room.game.turnNumber, 1);
  });
  it("abandonar durante el resultado no borra la lectura ni duplica el daño", async () => {
    const ctx = started();
    await resolve(ctx);
    forfeitPlayer(ctx.room, ctx.hooks, ctx.room.players[0]);
    assert.ok(ctx.room.game.reveal);
    assert.equal(ctx.room.game.correctAnswers, 2);
    assert.equal(ctx.room.players[0].eliminated, true);
  });
});


describe("acciones tardías y recargas", () => {
  it("no acepta un continuar de una pregunta anterior al abrir la tienda", async () => {
    const ctx = started();
    await resolve(ctx);
    await next(ctx);
    await resolve(ctx);
    await next(ctx);
    assert.equal(ctx.room.game.encounter, "shop");
    continueGame(ctx.room, ctx.hooks, ctx.room.players[0], "question:2");
    assert.deepEqual(ctx.room.game.continueReady, []);
  });
  it("el enfoque no se gasta si ninguna habilidad necesita recarga", () => {
    const { room, hooks, errors } = started();
    room.players[0].inventory.focus = 1;
    useItem(room, hooks, room.players[0], "focus");
    assert.equal(room.players[0].inventory.focus, 1);
    assert.equal(last(errors).code, "FOCUS_NOT_NEEDED");
  });
  it("no acumula un poder preparado al recargarlo y permite reactivarlo al consumirlo", async () => {
    const ctx = started();
    const p = ctx.room.players[0];
    useAbility(ctx.room, ctx.hooks, p, "strike");
    p.inventory.focus = 1;
    useItem(ctx.room, ctx.hooks, p, "focus");
    useAbility(ctx.room, ctx.hooks, p, "strike");
    assert.equal(last(ctx.errors).code, "ABILITY_ACTIVE");
    await resolve(ctx);
    await next(ctx);
    useAbility(ctx.room, ctx.hooks, p, "strike");
    assert.ok(ctx.room.game.usedAbilities.p0.includes("strike"));
  });
});
