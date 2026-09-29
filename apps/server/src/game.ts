import { randomInt } from "node:crypto";
import {
  ENEMIES,
  ABILITY_COOLDOWNS,
  GAME_CONFIG,
  ROLE_ABILITIES,
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
  wrongPlayers: Set<string>;
  timers: Timers;
};

export type EngineHooks = {
  onState: (room: GameRoom) => void;
  onReveal: (room: GameRoom, reveal: Reveal) => void;
  onError: (room: GameRoom, playerId: string, code: string, message: string) => void;
  onAbility?: (room: GameRoom, player: Player, ability: Ability) => void;
  onShop?: (room: GameRoom, coinsAwarded: number) => void;
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
 * Cierra la partida si corresponde. Si el equipo cae entero, pausa el combate en
 * una tienda de emergencia para que pueda comprar una resurrección.
 * @returns true si la partida terminó.
 */
function settle(room: GameRoom, hooks: EngineHooks) {
  if (!room.players.some((p) => p.online)) return finish(room, hooks, "abandoned"), true;
  if (!alive(room).length) {
    const g = room.game;
    if (g) {
      if (!g.shopOpen) {
        clearTimers(room);
        if (room.drawn && !room.remaining.some((card) => card.id === room.drawn?.id)) room.remaining.push(room.drawn);
        room.drawn = null;
        g.current = null;
        g.shopOpen = true;
        g.deadline = 0;
        g.answerStartsAt = 0;
        hooks.onState(room);
        hooks.onShop?.(room, 0);
      } else {
        hooks.onState(room);
      }
    }
    return true;
  }
  return false;
}

/** Marca al jugador como fuera del combate sin cortar su conexión a la sala. */
export function forfeitPlayer(room: GameRoom, hooks: EngineHooks, player: Player) {
  if (room.status !== "playing" || player.eliminated) return;
  player.hp = 0;
  player.eliminated = true;
  if (!settle(room, hooks)) hooks.onState(room);
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
  const answerMs = room.settings.questionTimeSeconds * 1000;
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
}

function consumeShield(room: GameRoom, player: Player) {
  const g = room.game;
  if (!g || player.role !== "Ladrón") return false;
  const used = g.usedAbilities[player.id] ?? [];
  if (!used.includes("evade")) return false;
  g.usedAbilities[player.id] = used.filter((a) => a !== "evade");
  return true;
}

function healMostInjured(room: GameRoom, maxAmount = 1) {
  const candidates = alive(room).filter((p) => p.hp < p.maxHp);
  if (!candidates.length) return { nickname: null as string | null, amount: 0 };
  const target = candidates.reduce((a, b) => (a.hp <= b.hp ? a : b));
  const amount = Math.min(maxAmount, target.maxHp - target.hp);
  target.hp += amount;
  return { nickname: target.nickname, amount };
}

function activeAbilities(room: GameRoom, player: Player) {
  return room.game?.usedAbilities[player.id] ?? [];
}

function consumeAbilityEffect(room: GameRoom, player: Player, ability: Ability) {
  const g = room.game;
  if (!g) return;
  const active = g.usedAbilities[player.id] ?? [];
  g.usedAbilities[player.id] = active.filter((item) => item !== ability);
}

function consumeTeamWard(room: GameRoom) {
  const g = room.game;
  if (!g) return;
  g.teamWard = false;
  for (const player of room.players) {
    g.usedAbilities[player.id] = (g.usedAbilities[player.id] ?? []).filter((ability) => ability !== "ward");
  }
}

function setAbilityCooldown(room: GameRoom, player: Player) {
  const g = room.game;
  if (!g || !player.role) return;
  g.abilityReadyAt[player.id] = g.turnNumber + ABILITY_COOLDOWNS[player.role] + 1;
}

function extendQuestion(room: GameRoom, hooks: EngineHooks) {
  const g = room.game;
  if (!g) return;
  g.deadline += GAME_CONFIG.bardAbilitySeconds * 1000;
  if (room.timers.deadline) clearTimeout(room.timers.deadline);
  room.timers.deadline = setTimeout(() => onTimeout(room, hooks), Math.max(0, g.deadline - Date.now()));
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
    const coinsAwarded = randomInt(1, 4);
    for (const player of room.players) player.coins += coinsAwarded;
    g.enemy = null;
    if (!room.remaining.length) return finish(room, hooks, "won");
    if (g.enemiesDefeated % 5 === 0) {
      g.shopOpen = true;
      hooks.onState(room);
      hooks.onShop?.(room, coinsAwarded);
      return;
    }
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
  g.turnNumber += 1;
  for (const [playerId, active] of Object.entries(g.usedAbilities)) {
    g.usedAbilities[playerId] = active.filter((ability) => !["discard", "heal", "extend", "track", "potion"].includes(ability));
  }
  room.drawn = card;
  g.current = { id: card.id, prompt: card.prompt, options: card.options };
  g.visibleOptions = visibleFor(room, card);
  room.discardedFor = null;
  room.wrongPlayers.clear();
  armDeadline(room, hooks);
  hooks.onState(room);
}

function onTimeout(room: GameRoom, hooks: EngineHooks) {
  const g = room.game;
  const card = room.drawn;
  if (!g || room.status !== "playing" || !card) return;
  if (settle(room, hooks)) return;
  const wardBlocked = g.teamWard;
  if (wardBlocked) consumeTeamWard(room);
  const timeoutPlayers = alive(room).filter((p) => !room.wrongPlayers.has(p.id));
  if (!wardBlocked) {
    for (const player of timeoutPlayers) {
      player.hp = Math.max(0, player.hp - 1);
      if (!player.hp) player.eliminated = true;
    }
  }

  room.remaining.push(card);
  const reveal: Reveal = {
    correct: false,
    answer: card.answer,
    ...(card.explanation ? { explanation: card.explanation } : {}),
    damage: wardBlocked || !timeoutPlayers.length ? 0 : 1,
    wardBlocked,
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
  room.wrongPlayers ??= new Set();
  const limit = room.settings.cardCount > 0 ? Math.min(room.settings.cardCount, room.cards.length) : room.cards.length;
  room.remaining = shuffle(room.cards.slice(0, limit));
  room.drawn = null;
  room.discardedFor = null;
  for (const p of room.players) {
    p.hp = GAME_CONFIG.playerMaxHp;
    p.maxHp = GAME_CONFIG.playerMaxHp;
    p.eliminated = false;
    p.coins = 3;
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
    visibleOptions: null,
    usedAbilities: {},
    turnNumber: 0,
    abilityReadyAt: {},
    teamWard: false,
    startedAt: Date.now(),
    finishedAt: null,
    outcome: null,
    shopOpen: false,
    bonusDamage: 0,
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
    const protectedByWard = g.teamWard;
    if (protectedByWard) consumeTeamWard(room);
    const evaded = !protectedByWard && consumeShield(room, player);
    if (!protectedByWard && !evaded) {
      room.wrongPlayers.add(player.id);
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
      damage: protectedByWard || evaded ? 0 : 1,
      healedPlayer: null,
      healedAmount: 0,
      timeUp: false,
      enemyDefeated: false,
    });
    return;
  }

  const enemy = g.enemy;
  if (!enemy) return;
  const active = activeAbilities(room, player);
  let damage = 1;
  if (player.role === "Guerrero" && active.includes("strike")) {
    damage += enemy.trait === "blindado" ? 1 : 2;
    consumeAbilityEffect(room, player, "strike");
  }
  damage += g.bonusDamage;
  g.bonusDamage = 0;
  enemy.hp = Math.max(0, enemy.hp - damage);
  g.mastered += 1;

  const reveal: Reveal = {
    correct: true,
    answer: card.answer,
    ...(card.explanation ? { explanation: card.explanation } : {}),
    damage,
    healedPlayer: null,
    healedAmount: 0,
    timeUp: false,
    enemyDefeated: enemy.hp === 0,
  };
  closeQuestion(room);
  hooks.onState(room);
  hooks.onReveal(room, reveal);
  scheduleAdvance(room, hooks);
}

export function buyShopItem(room: GameRoom, hooks: EngineHooks, player: Player, item: "healing" | "revive" | "phoenix" | "ward" | "partyHeal" | "bomb" | "focus", targetId?: string) {
  const g = room.game;
  if (!g || room.status !== "playing" || !g.shopOpen) return;
  const prices = { healing: 3, revive: 3, phoenix: 12, ward: 5, partyHeal: 7, bomb: 6, focus: 6 } as const;
  const price = prices[item];
  if (player.coins < price) return hooks.onError(room, player.id, "NOT_ENOUGH_COINS", "No te alcanzan las monedas para ese objeto.");
  if (item === "healing") {
    if (player.eliminated || player.hp >= player.maxHp) return hooks.onError(room, player.id, "HEAL_NOT_NEEDED", "Necesitás estar herido para usar una poción.");
    player.hp = Math.min(player.maxHp, player.hp + 2);
  } else if (item === "revive") {
    const target = room.players.find((mate) => mate.id === targetId);
    if (!target?.eliminated) return hooks.onError(room, player.id, "PLAYER_NOT_DOWN", "Ese compañero no necesita una poción de resurrección.");
    target.hp = 1;
    target.eliminated = false;
  } else if (item === "phoenix") {
    const downed = room.players.filter((mate) => mate.eliminated);
    if (!downed.length) return hooks.onError(room, player.id, "NO_ONE_TO_REVIVE", "No hay compañeros caídos para revivir.");
    for (const mate of downed) {
      mate.hp = 1;
      mate.eliminated = false;
    }
  } else if (item === "ward") {
    if (g.teamWard) return hooks.onError(room, player.id, "WARD_ALREADY_ACTIVE", "El Muro Sagrado ya está protegiendo al grupo.");
    g.teamWard = true;
  } else if (item === "partyHeal") {
    const injured = alive(room).filter((mate) => mate.hp < mate.maxHp);
    if (!injured.length) return hooks.onError(room, player.id, "TEAM_AT_FULL_HEALTH", "Todo el grupo está con la vida completa.");
    for (const mate of injured) mate.hp = Math.min(mate.maxHp, mate.hp + 1);
  } else if (item === "bomb") {
    if (g.bonusDamage > 0) return hooks.onError(room, player.id, "BOMB_ALREADY_ARMED", "Ya hay una bomba lista para el próximo ataque.");
    g.bonusDamage += 2;
  } else if (item === "focus") {
    for (const mate of room.players) g.abilityReadyAt[mate.id] = g.turnNumber;
  }
  player.coins -= price;
  hooks.onState(room);
}

export function continueFromShop(room: GameRoom, hooks: EngineHooks, player: Player) {
  const g = room.game;
  if (!g || room.status !== "playing" || !g.shopOpen) return;
  if (!player.isCreator) return hooks.onError(room, player.id, "NOT_CREATOR", "Solo quien creó la sala puede cerrar la tienda.");
  if (!alive(room).length) return hooks.onError(room, player.id, "PARTY_DOWN", "Reviví al menos a un aventurero antes de seguir.");
  g.shopOpen = false;
  spawnEnemy(room);
  dealCard(room, hooks);
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
  if (Date.now() > g.deadline) return;
  const role: Role | null = player.role;
  if (!role || ROLE_ABILITIES[role] !== ability) {
    hooks.onError(room, player.id, "INVALID_ABILITY", "Ese poder no corresponde a tu rol.");
    return;
  }
  const readyAt = g.abilityReadyAt[player.id] ?? 0;
  if (g.turnNumber < readyAt) {
    hooks.onError(room, player.id, "ABILITY_COOLDOWN", `Ese poder vuelve en ${readyAt - g.turnNumber} preguntas.`);
    return;
  }
  const active = activeAbilities(room, player);
  const used = () => { g.usedAbilities[player.id] = [...activeAbilities(room, player), ability]; };
  const card = room.drawn;

  switch (ability) {
    case "strike":
      used();
      break;
    case "discard": {
      if (!card || g.visibleOptions!.length <= 2) {
        hooks.onError(room, player.id, "NO_OPTIONS_TO_DISCARD", "Ya no quedan opciones para descartar.");
        return;
      }
      room.discardedFor = card.id;
      g.visibleOptions = visibleFor(room, card);
      used();
      break;
    }
    case "heal": {
      const healed = healMostInjured(room, 2);
      if (!healed.amount) {
        hooks.onError(room, player.id, "TEAM_AT_FULL_HEALTH", "Todo el grupo está con la vida completa.");
        return;
      }
      used();
      break;
    }
    case "evade":
      used();
      break;
    case "extend":
      extendQuestion(room, hooks);
      used();
      break;
    case "ward":
      if (g.teamWard) {
        hooks.onError(room, player.id, "WARD_ALREADY_ACTIVE", "El Muro Sagrado ya está protegiendo al grupo.");
        return;
      }
      g.teamWard = true;
      used();
      break;
    case "track": {
      if (!card || !g.visibleOptions || g.visibleOptions.length <= 2) {
        hooks.onError(room, player.id, "NO_OPTIONS_TO_TRACK", "El Rastreo necesita al menos tres opciones visibles.");
        return;
      }
      g.visibleOptions = narrow(g.visibleOptions, card.answer, g.visibleOptions.length - 1);
      used();
      break;
    }
    case "potion": {
      const targets = alive(room).filter((mate) => mate.hp < mate.maxHp);
      if (!targets.length) {
        hooks.onError(room, player.id, "TEAM_AT_FULL_HEALTH", "Todo el grupo está con la vida completa.");
        return;
      }
      for (const mate of targets) mate.hp = Math.min(mate.maxHp, mate.hp + 1);
      used();
      break;
    }
  }

  setAbilityCooldown(room, player);
  hooks.onState(room);
  hooks.onAbility?.(room, player, ability);
}
