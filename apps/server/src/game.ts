import { randomInt } from "node:crypto";
import {
  ENEMIES,
  GAME_CONFIG,
  type Ability,
  type Card,
  type Outcome,
  type Player,
  type Reveal,
  type Role,
  type RoomState,
} from "@dungeon/shared";

export type Timers = { deadline?: NodeJS.Timeout; advance?: NodeJS.Timeout };

/** Estado real de la sala. Los campos fuera de RoomState NUNCA se transmiten: ver publicView(). */
export type GameRoom = RoomState & {
  sockets: Map<string, string>;
  cards: Card[];
  remaining: Card[];
  drawn: Card | null;
  discardedFor: string | null;
  timers: Timers;
};

export type EngineHooks = {
  onState: (room: GameRoom) => void;
  onReveal: (room: GameRoom, reveal: Reveal) => void;
  onError: (room: GameRoom, playerId: string, code: string, message: string) => void;
};

const clean = (value: unknown, max: number) =>
  typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";

export function validateDeckTitle(raw: unknown) {
  const title = clean(raw, GAME_CONFIG.maxTitleLength);
  return title || "Mazo sin título";
}

export function validateDeck(raw: unknown): { cards: Card[]; error: string | null } {
  if (!Array.isArray(raw)) return { cards: [], error: "El mazo tiene que ser una lista de preguntas." };
  if (raw.length === 0) return { cards: [], error: "El mazo está vacío: subí al menos una pregunta." };
  if (raw.length > GAME_CONFIG.maxCards)
    return { cards: [], error: `El mazo tiene ${raw.length} cartas y el máximo es ${GAME_CONFIG.maxCards}.` };

  const cards: Card[] = [];
  for (const [index, item] of raw.entries()) {
    const n = index + 1;
    if (!item || typeof item !== "object") return { cards: [], error: `La carta ${n} no es una pregunta válida.` };
    const row = item as Record<string, unknown>;
    const prompt = clean(row.prompt, GAME_CONFIG.maxPromptLength);
    if (!prompt) return { cards: [], error: `La carta ${n} está sin pregunta.` };

    const options = Array.isArray(row.options) ? row.options.map((o) => clean(o, GAME_CONFIG.maxOptionLength)) : [];
    if (options.length < GAME_CONFIG.minOptions || options.length > GAME_CONFIG.maxOptions)
      return { cards: [], error: `La carta ${n} tiene ${options.length} opciones y se permiten entre ${GAME_CONFIG.minOptions} y ${GAME_CONFIG.maxOptions}.` };
    if (new Set(options).size !== options.length) return { cards: [], error: `La carta ${n} repite opciones.` };
    if (options.some((o) => !o)) return { cards: [], error: `La carta ${n} tiene una opción vacía.` };

    const answer = Number(row.answer);
    if (!Number.isInteger(answer) || answer < 0 || answer >= options.length)
      return { cards: [], error: `La carta ${n} tiene respuesta "${String(row.answer)}" fuera de rango (va de 0 a ${options.length - 1}).` };

    const explanation = clean(row.explanation, 400);
    cards.push({ id: `c${index}`, prompt, options, answer, ...(explanation ? { explanation } : {}) });
  }
  return { cards, error: null };
}

export function publicView(room: GameRoom): RoomState {
  const { sockets: _s, cards: _c, remaining: _r, drawn: _d, discardedFor: _dd, timers: _t, ...state } = room;
  return {
    ...state,
    players: state.players.map((p) => ({ ...p })),
    game: state.game ? { ...state.game, current: state.game.current ? { ...state.game.current } : null } : null,
  };
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function clearTimers(room: GameRoom) {
  for (const timer of Object.values(room.timers)) if (timer) clearTimeout(timer);
  room.timers = {};
}

const alive = (room: GameRoom) => room.players.filter((p) => !p.eliminated);

/**
 * Cierra la partida si corresponde. Son dos finales distintos: "abandoned" es que
 * se fueron todos (y la sala es memoria, no podemos esperar un reconnect eterno),
 * "lost" es que el equipo fue derrotado.
 * @returns true si la partida terminó.
 */
function settle(room: GameRoom, hooks: EngineHooks) {
  if (!room.players.some((p) => p.online)) return finish(room, hooks, "abandoned"), true;
  if (!alive(room).length) return finish(room, hooks, "lost"), true;
  return false;
}

/** Cierra la ronda pero deja la carta a la vista, para que el reveal pueda señalar la respuesta. */
function closeQuestion(room: GameRoom) {
  room.discardedFor = null;
  const g = room.game;
  if (g) {
    g.deadline = 0;
    g.answerStartsAt = 0;
    g.visibleOptions = null;
  }
}

function clearQuestion(room: GameRoom) {
  closeQuestion(room);
  room.drawn = null;
  if (room.game) room.game.current = null;
}

function narrow(visible: number[], answer: number, keep: number) {
  const wrong = shuffle(visible.filter((i) => i !== answer));
  return [...wrong.slice(0, keep - 1), answer].sort((a, b) => a - b);
}

function visibleFor(room: GameRoom, card: Card): number[] {
  let visible = card.options.map((_, i) => i);
  if (room.game?.enemy?.trait === "mudo" && visible.length > GAME_CONFIG.mutedEnemyOptions) {
    visible = narrow(visible, card.answer, GAME_CONFIG.mutedEnemyOptions);
  }
  if (room.discardedFor === card.id && visible.length > 2) {
    visible = narrow(visible, card.answer, 2);
  }
  return visible;
}

function armDeadline(room: GameRoom, hooks: EngineHooks) {
  const g = room.game;
  if (!g) return;
  clearTimers(room);
  const previewMs = GAME_CONFIG.promptPreviewSeconds * 1000;
  const answerMs = room.settings.questionTimeSeconds * 1000 + g.timeBonusMs;
  g.timeBonusMs = 0;
  g.answerStartsAt = Date.now() + previewMs;
  g.deadline = g.answerStartsAt + answerMs;
  room.timers.deadline = setTimeout(() => onTimeout(room, hooks), previewMs + answerMs);
}

function spawnEnemy(room: GameRoom) {
  const g = room.game;
  if (!g) return;
  const players = Math.max(1, room.players.length);
  const pick = ENEMIES[randomInt(ENEMIES.length)];
  const hp = pick.hp + Math.max(0, players - 1) * 2;
  g.enemy = { id: pick.id, name: pick.name, hp, maxHp: hp, trait: pick.trait };
  g.usedAbilities = {};
}

function consumeShield(room: GameRoom, player: Player) {
  const g = room.game;
  if (!g || player.role !== "Ladrón") return false;
  const used = g.usedAbilities[player.id] ?? [];
  if (!used.includes("evade")) return false;
  g.usedAbilities[player.id] = used.filter((a) => a !== "evade");
  return true;
}

function healTeam(room: GameRoom) {
  const candidates = alive(room).filter((p) => p.hp < p.maxHp);
  if (!candidates.length) return { nickname: null as string | null, amount: 0 };
  const target = candidates.reduce((a, b) => (a.hp <= b.hp ? a : b));
  const amount = Math.min(1, target.maxHp - target.hp);
  target.hp += amount;
  return { nickname: target.nickname, amount };
}

function finish(room: GameRoom, hooks: EngineHooks, outcome: Outcome) {
  clearTimers(room);
  const g = room.game;
  if (g) {
    g.outcome = outcome;
    g.finishedAt = Date.now();
  }
  clearQuestion(room);
  room.remaining = [];
  room.status = "results";
  hooks.onState(room);
}

function scheduleAdvance(room: GameRoom, hooks: EngineHooks) {
  room.timers.advance = setTimeout(() => advance(room, hooks), GAME_CONFIG.answerRevealMs);
}

function advance(room: GameRoom, hooks: EngineHooks) {
  const g = room.game;
  if (!g) return;
  clearTimers(room);
  if (settle(room, hooks)) return;
  if (g.enemy && g.enemy.hp === 0) {
    g.enemiesDefeated += 1;
    g.enemy = null;
    g.usedAbilities = {};
    g.timeBonusMs = 0;
    if (!room.remaining.length) return finish(room, hooks, "won");
    spawnEnemy(room);
  }
  dealCard(room, hooks);
}

function dealCard(room: GameRoom, hooks: EngineHooks) {
  const g = room.game;
  if (!g) return;
  if (!room.remaining.length) return finish(room, hooks, "won");
  const card = room.remaining.pop() ?? null;
  if (!card) return finish(room, hooks, "won");
  room.drawn = card;
  g.current = { id: card.id, prompt: card.prompt, options: card.options };
  g.visibleOptions = visibleFor(room, card);
  room.discardedFor = null;
  armDeadline(room, hooks);
  hooks.onState(room);
}

function onTimeout(room: GameRoom, hooks: EngineHooks) {
  const g = room.game;
  const card = room.drawn;
  if (!g || room.status !== "playing" || !card) return;
  if (settle(room, hooks)) return;
  for (const player of alive(room)) {
    player.hp = Math.max(0, player.hp - 1);
    if (!player.hp) player.eliminated = true;
  }

  room.remaining.push(card);
  const reveal: Reveal = {
    correct: false,
    answer: card.answer,
    ...(card.explanation ? { explanation: card.explanation } : {}),
    damage: 1,
    healedPlayer: null,
    healedAmount: 0,
    timeUp: true,
    enemyDefeated: false,
  };
  closeQuestion(room);
  hooks.onState(room);
  if (settle(room, hooks)) return;
  hooks.onReveal(room, reveal);
  scheduleAdvance(room, hooks);
}

export function startGame(room: GameRoom, hooks: EngineHooks) {  if (room.status !== "lobby" || !room.cards.length) return;
  clearTimers(room);
  const limit = room.settings.cardCount > 0 ? Math.min(room.settings.cardCount, room.cards.length) : room.cards.length;
  room.remaining = shuffle(room.cards.slice(0, limit));
  room.drawn = null;
  room.discardedFor = null;
  for (const p of room.players) {
    p.hp = GAME_CONFIG.playerMaxHp;
    p.maxHp = GAME_CONFIG.playerMaxHp;
    p.eliminated = false;
  }
  room.status = "playing";
  room.game = {
    pending: room.remaining.length,
    mastered: 0,
    enemiesDefeated: 0,
    enemy: null,
    current: null,
    answerStartsAt: 0,
    deadline: 0,
    timeBonusMs: 0,
    visibleOptions: null,
    usedAbilities: {},
    startedAt: Date.now(),
    finishedAt: null,
    outcome: null,
  };
  spawnEnemy(room);
  dealCard(room, hooks);
}

export function handleAnswer(room: GameRoom, hooks: EngineHooks, player: Player, answer: number) {
  const g = room.game;
  const card = room.drawn;
  if (!g || room.status !== "playing" || !card) return;
  if (player.eliminated) {
    hooks.onError(room, player.id, "ELIMINATED", "Caíste: podés mirar, pero ya no respondés.");
    return;
  }
  if (Date.now() < g.answerStartsAt) {
    hooks.onError(room, player.id, "QUESTION_PREVIEW", "Esperá a que aparezcan las opciones para responder.");
    return;
  }
  if (Date.now() > g.deadline) return;
  if (!Number.isInteger(answer) || answer < 0 || answer >= card.options.length) return;

  if (answer !== card.answer) {
    const evaded = consumeShield(room, player);
    if (!evaded) {
      player.hp = Math.max(0, player.hp - 1);
      if (!player.hp) player.eliminated = true;
    }
    hooks.onState(room);
    // Si este fallo soltó al último del equipo, la partida se cierra ya: no tiene
    // sentido dejar al grupo mirando una pregunta sin nadie que la conteste.
    if (settle(room, hooks)) return;
    hooks.onReveal(room, {
      correct: false,
      answer: null,
      damage: evaded ? 0 : 1,
      healedPlayer: null,
      healedAmount: 0,
      timeUp: false,
      enemyDefeated: false,
    });
    return;
  }

  const enemy = g.enemy;
  if (!enemy) return;
  const damage = player.role === "Guerrero" && enemy.trait !== "blindado" ? 2 : 1;
  enemy.hp = Math.max(0, enemy.hp - damage);
  const heal = player.role === "Clérigo" ? healTeam(room) : { nickname: null, amount: 0 };
  if (player.role === "Bardo") g.timeBonusMs += GAME_CONFIG.extraTimeSeconds * 1000;
  g.mastered += 1;

  const reveal: Reveal = {
    correct: true,
    answer: card.answer,
    ...(card.explanation ? { explanation: card.explanation } : {}),
    damage,
    healedPlayer: heal.nickname,
    healedAmount: heal.amount,
    timeUp: false,
    enemyDefeated: enemy.hp === 0,
  };
  closeQuestion(room);
  hooks.onState(room);
  hooks.onReveal(room, reveal);
  scheduleAdvance(room, hooks);
}

export function useAbility(room: GameRoom, hooks: EngineHooks, player: Player, ability: Ability) {
  const g = room.game;
  if (!g || room.status !== "playing") return;
  if (Date.now() < g.answerStartsAt) {
    hooks.onError(room, player.id, "QUESTION_PREVIEW", "Esperá a que aparezcan las opciones para usar habilidades.");
    return;
  }
  if (player.eliminated) {
    hooks.onError(room, player.id, "ELIMINATED", "Caíste: ya no podés usar habilidades.");
    return;
  }
  const role: Role | null = player.role;

  if (ability === "discard") {
    if (role !== "Mago") return;
    const card = room.drawn;
    if (!card) return;
    if (room.discardedFor === card.id) {
      hooks.onError(room, player.id, "ABILITY_USED", "Ya recortaste las opciones de esta pregunta.");
      return;
    }
    room.discardedFor = card.id;
    g.visibleOptions = visibleFor(room, card);
    hooks.onState(room);
    return;
  }

  if (ability === "evade") {
    if (role !== "Ladrón") return;
    const used = g.usedAbilities[player.id] ?? [];
    if (used.includes("evade")) {
      hooks.onError(room, player.id, "ABILITY_USED", "Ya usaste tu escudo contra este enemigo.");
      return;
    }
    g.usedAbilities[player.id] = [...used, "evade"];
    hooks.onState(room);
    return;
  }

  // "extend" es pasiva: el Bardo suma tiempo cuando alguien acierta.
}
