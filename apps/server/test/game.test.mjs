import assert from "node:assert/strict";
import { afterEach, before, describe, it } from "node:test";
import { GAME_CONFIG } from "@dungeon/shared";
import { clearTimers, handleAnswer, publicView, startGame, useAbility, validateDeck } from "../dist/game.js";

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

const wrongAnswer = (room) => (room.drawn.answer + 1) % room.drawn.options.length;
const liveCards = (room) => room.remaining.length + (room.drawn ? 1 : 0);

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

describe("daño y mazo", () => {
  it("el Golpe demoledor del Guerrero agrega daño y la carta sale del mazo", () => {
    const { room, hooks, reveals } = started();
    const before = room.game.enemy.hp;
    useAbility(room, hooks, room.players[0], "strike");
    handleAnswer(room, hooks, room.players[0], room.drawn.answer);
    assert.equal(before - room.game.enemy.hp, 3);
    assert.equal(room.game.mastered, 1);
    assert.equal(room.remaining.length, 3, "la carta dominada ya no está en el mazo");
    assert.equal(last(reveals).correct, true);
  });

  it("el Golem blindado resiste parte del Golpe demoledor", () => {
    const { room, hooks } = started();
    room.game.enemy.trait = "blindado";
    const before = room.game.enemy.hp;
    useAbility(room, hooks, room.players[0], "strike");
    handleAnswer(room, hooks, room.players[0], room.drawn.answer);
    assert.equal(before - room.game.enemy.hp, 2);
  });

  it("fallar cuesta 1 de vida, deja la pregunta abierta y no revela la respuesta", () => {
    const { room, hooks, reveals } = started();
    handleAnswer(room, hooks, room.players[0], wrongAnswer(room));
    assert.equal(room.players[0].hp, 2);
    assert.notEqual(room.drawn, null, "la pregunta debería seguir abierta");
    assert.equal(last(reveals).answer, null, "no debe filtrarse la respuesta correcta");
    assert.equal(last(reveals).damage, 1);
  });

  it("el Espectro mudo muestra solo 3 opciones, siempre con la correcta", async () => {
    const { room, hooks } = makeRoom(["Mago", "Clérigo"]);
    startGame(room, hooks);
    handleAnswer(room, hooks, room.players[0], room.drawn.answer);
    await sleep(30);
    room.game.enemy.trait = "mudo";
    handleAnswer(room, hooks, room.players[0], room.drawn.answer);
    await sleep(30);
    assert.equal(room.game.visibleOptions.length, 3);
    assert.equal(room.game.visibleOptions.includes(room.drawn.answer), true);
  });
});

describe("habilidades", () => {
  it("el escudo del Ladrón anula un fallo y se gasta", () => {
    const { room, hooks } = started(["Ladrón", "Mago"]);
    useAbility(room, hooks, room.players[0], "evade");
    handleAnswer(room, hooks, room.players[0], wrongAnswer(room));
    assert.equal(room.players[0].hp, GAME_CONFIG.playerMaxHp);
    handleAnswer(room, hooks, room.players[0], wrongAnswer(room));
    assert.equal(room.players[0].hp, GAME_CONFIG.playerMaxHp - 1, "el segundo fallo debería doler");
  });

  it("el Mago recorta a 50/50, una vez por pregunta", () => {
    const { room, hooks, errors } = started(["Mago", "Clérigo"]);
    useAbility(room, hooks, room.players[0], "discard");
    assert.equal(room.game.visibleOptions.length, 2);
    assert.equal(room.game.visibleOptions.includes(room.drawn.answer), true);
    useAbility(room, hooks, room.players[0], "discard");
    assert.equal(last(errors).code, "ABILITY_COOLDOWN");
  });

  it("la Sanación mayor cura hasta 2 vidas al aliado más herido", () => {
    const { room, hooks, reveals } = started(["Clérigo", "Mago"]);
    room.players[1].hp = 1;
    useAbility(room, hooks, room.players[0], "heal");
    assert.equal(room.players[1].hp, 3);
  });

  it("el Crescendo del Bardo extiende la pregunta actual", () => {
    const { room, hooks } = started(["Bardo", "Mago"]);
    const previous = room.game.deadline;
    useAbility(room, hooks, room.players[0], "extend");
    assert.equal(room.game.deadline - previous, GAME_CONFIG.bardAbilitySeconds * 1000);
  });

  it("una habilidad ajena al rol no hace nada", () => {
    const { room, hooks } = started(["Guerrero", "Clérigo"]);
    useAbility(room, hooks, room.players[0], "discard");
    assert.equal(room.game.visibleOptions.length, 4);
  });
});

describe("fin de ronda y de partida", () => {
  it("el timeout devuelve la carta al mazo en vez de perderla", async () => {
    const { room, hooks, reveals } = makeRoom(["Guerrero", "Mago"], [deck()[0]]);
    startGame(room, hooks);
    const card = room.drawn;
    await sleep(150);
    assert.equal(last(reveals).timeUp, true);
    assert.equal(last(reveals).answer, card.answer);
    assert.equal(room.game.mastered, 0);
    assert.equal(room.status, "playing", "la carta volvió al mazo, así que la partida sigue");
    assert.equal(liveCards(room), 1, "la carta sigue viva en el mazo");
    assert.equal(room.players.every((player) => player.hp === GAME_CONFIG.playerMaxHp - 1), true, "el tiempo agotado daña a todo el grupo");
  });

  it("cuando muere un enemigo a mitad del mazo aparece el siguiente", async () => {
    const { room, hooks, reveals } = makeRoom(["Guerrero", "Mago"], [deck()[0], deck()[1]]);
    startGame(room, hooks);
    room.game.enemy.hp = 1;
    handleAnswer(room, hooks, room.players[0], room.drawn.answer);
    await sleep(30);
    assert.equal(last(reveals).enemyDefeated, true);
    assert.equal(room.game.enemiesDefeated, 1);
    assert.notEqual(room.game.enemy, null, "debe aparecer un enemigo nuevo");
    // El siguiente sale al azar entre los cuatro, así que puede ser la misma especie:
    // lo que no puede pasar es que siga el mismo con la vida gastada.
    assert.equal(room.game.enemy.hp, room.game.enemy.maxHp, "y tiene que arrancar con la vida llena");
    assert.notEqual(room.drawn, null, "y repartirse la siguiente carta");
  });

  it("quedarse sin vida elimina y bloquea las respuestas", () => {
    const { room, hooks, errors } = started();
    const p = room.players[0];
    for (let i = 0; i < GAME_CONFIG.playerMaxHp; i++) handleAnswer(room, hooks, p, wrongAnswer(room));
    assert.equal(p.eliminated, true);
    assert.equal(p.hp, 0);
    const mastered = room.game.mastered;
    handleAnswer(room, hooks, p, room.drawn.answer);
    assert.equal(room.game.mastered, mastered, "un eliminado no puede acertar");
    assert.equal(last(errors).code, "ELIMINATED");
  });

  it("ganar al agotar el mazo termina la partida", async () => {
    const { room, hooks } = started();
    for (let i = 0; i < 40 && room.status === "playing"; i++) {
      if (room.drawn) handleAnswer(room, hooks, room.players[0], room.drawn.answer);
      await sleep(20);
    }
    assert.equal(room.status, "results");
    assert.equal(room.game.outcome, "won");
    assert.equal(room.game.mastered, 4);
  });

  it("perder cuando todo el equipo cae termina la partida", async () => {
    const { room, hooks } = started();
    for (const p of room.players) {
      for (let i = 0; i < GAME_CONFIG.playerMaxHp; i++) handleAnswer(room, hooks, p, wrongAnswer(room));
    }
    await sleep(150);
    assert.equal(room.status, "results");
    assert.equal(room.game.outcome, "lost");
  });

  it("si todos se desconectan la partida se abandona, no se pierde", async () => {
    const { room, hooks } = started();
    for (const p of room.players) p.online = false;
    await sleep(150);
    assert.equal(room.status, "results");
    assert.equal(room.game.outcome, "abandoned");
  });

  it("si nadie responde, cada timeout daña al grupo hasta perder", async () => {
    const { room, hooks } = started();
    await sleep(1000);
    assert.equal(room.status, "results");
    assert.equal(room.game.outcome, "lost");
  });
});
