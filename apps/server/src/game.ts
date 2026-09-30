import { randomInt } from "node:crypto";
import {
  ENEMIES,
  ABILITY_COOLDOWNS,
  GAME_CONFIG,
  getShopPrices,
  getContinuePhase,
  ROLE_ABILITIES,
  type Ability,
  type Card,
  type DeckScene,
  type Outcome,
  type Player,
  type Reveal,
  type Role,
  type RoomState,
  type ShopItem,
} from "@dungeon/shared";

export type Timers = { deadline?: NodeJS.Timeout };
export type DeckEntry = { type: "question"; card: Card } | { type: "scene"; scene: DeckScene };

/** Estado real de la sala. Los campos fuera de RoomState NUNCA se transmiten: ver publicView(). */
export type GameRoom = RoomState & {
  sockets: Map<string, string>;
  cards: Card[];
  timeline: DeckEntry[];
  remaining: DeckEntry[];
  drawn: Card | null;
  discardedFor: string | null;
  wrongPlayers: Set<string>;
  votes: Map<string, number>;
  timers: Timers;
};

export type EngineHooks = {
  onState: (room: GameRoom) => void;
  onReveal: (room: GameRoom, reveal: Reveal) => void;
  onError: (room: GameRoom, playerId: string, code: string, message: string) => void;
  onAbility?: (room: GameRoom, player: Player, ability: Ability) => void;
  onItem?: (room: GameRoom, player: Player, item: ShopItem) => void;
  onShop?: (room: GameRoom, coinsAwarded: number) => void;
};

const clean = (value: unknown, max: number) =>
  typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";

export function validateDeckTitle(raw: unknown) {
  const title = clean(raw, GAME_CONFIG.maxTitleLength);
  return title || "Mazo sin título";
}

export function validateDeck(raw: unknown): { cards: Card[]; scenes: DeckScene[]; timeline: DeckEntry[]; depth: number | null; error: string | null } {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  const rawScenes = source?.scenes;
  const hasScenes = Array.isArray(rawScenes);
  const rawCards = Array.isArray(raw) ? raw : source?.cards ?? source?.questions ?? source?.preguntas;
  const cards: Card[] = [];
  const scenes: DeckScene[] = [];
  const timeline: DeckEntry[] = [];
  let error: string | null = null;

  if (source?.scenes !== undefined && !hasScenes)
    return { cards, scenes, timeline, depth: null, error: "El campo scenes tiene que ser una lista de escenas." };

  const readCards = (list: unknown, sceneIndex?: number) => {
    if (!Array.isArray(list)) {
      error = sceneIndex === undefined ? "El mazo tiene que ser una lista de preguntas." : `La escena ${sceneIndex + 1} necesita una lista de preguntas.`;
      return [] as Card[];
    }
    const valid: Card[] = [];
    for (const item of list) {
      const index = cards.length + valid.length;
      const n = index + 1;
      if (!item || typeof item !== "object") { error = `La carta ${n} no es una pregunta válida.`; return []; }
      const row = item as Record<string, unknown>;
      const prompt = clean(row.prompt, GAME_CONFIG.maxPromptLength);
      if (!prompt) { error = `La carta ${n} está sin pregunta.`; return []; }
      const options = Array.isArray(row.options) ? row.options.map((o) => clean(o, GAME_CONFIG.maxOptionLength)) : [];
      if (options.length < GAME_CONFIG.minOptions || options.length > GAME_CONFIG.maxOptions) {
        error = `La carta ${n} tiene ${options.length} opciones y se permiten entre ${GAME_CONFIG.minOptions} y ${GAME_CONFIG.maxOptions}.`;
        return [];
      }
      if (new Set(options).size !== options.length) { error = `La carta ${n} repite opciones.`; return []; }
      if (options.some((o) => !o)) { error = `La carta ${n} tiene una opción vacía.`; return []; }
      const answer = Number(row.answer);
      if (!Number.isInteger(answer) || answer < 0 || answer >= options.length) {
        error = `La carta ${n} tiene respuesta "${String(row.answer)}" fuera de rango (va de 0 a ${options.length - 1}).`;
        return [];
      }
      const explanation = clean(row.explanation, 400);
      valid.push({ id: `c${index}`, prompt, options, answer, ...(explanation ? { explanation } : {}) });
    }
    return valid;
  };

  if (hasScenes) {
    if (!rawScenes.length) return { cards, scenes, timeline, depth: null, error: "El mazo necesita al menos una escena." };
    if (rawScenes.length > GAME_CONFIG.maxScenes)
      return { cards, scenes, timeline, depth: null, error: `El mazo supera el máximo de ${GAME_CONFIG.maxScenes} escenas.` };
    for (const [index, rawScene] of rawScenes.entries()) {
      if (!rawScene || typeof rawScene !== "object") { error = `La escena ${index + 1} no es válida.`; break; }
      const row = rawScene as Record<string, unknown>;
      const title = clean(row.title, GAME_CONFIG.maxSceneTitleLength);
      const setting = clean(row.setting, GAME_CONFIG.maxSceneSettingLength);
      const objective = clean(row.objective, GAME_CONFIG.maxSceneObjectiveLength);
      if (!title || !setting || !objective) { error = `La escena ${index + 1} necesita título, lugar y objetivo.`; break; }
      if (!Array.isArray(row.beats) || row.beats.length < GAME_CONFIG.sceneBeatCount.min || row.beats.length > GAME_CONFIG.sceneBeatCount.max) {
        error = `La escena ${index + 1} necesita entre ${GAME_CONFIG.sceneBeatCount.min} y ${GAME_CONFIG.sceneBeatCount.max} momentos narrativos.`;
        break;
      }
      const beats = row.beats.map((rawBeat) => {
        if (!rawBeat || typeof rawBeat !== "object") return { heading: "", text: "" };
        const beat = rawBeat as Record<string, unknown>;
        return { heading: clean(beat.heading, GAME_CONFIG.maxSceneBeatTitleLength), text: clean(beat.text, GAME_CONFIG.maxSceneBeatTextLength) };
      });
      if (beats.some((beat) => !beat.heading || !beat.text)) { error = `La escena ${index + 1} tiene un momento sin título o texto.`; break; }
      if (!Array.isArray(row.cards) || !row.cards.length) { error = `La escena ${index + 1} necesita al menos una pregunta.`; break; }
      const scene: DeckScene = { id: `s${index}`, title, setting, objective, beats };
      const sceneCards = readCards(row.cards, index);
      if (error) break;
      scenes.push(scene);
      timeline.push({ type: "scene", scene });
      cards.push(...sceneCards);
      timeline.push(...sceneCards.map((card): DeckEntry => ({ type: "question", card })));
    }
  } else {
    if (!Array.isArray(rawCards)) return { cards, scenes, timeline, depth: null, error: "El mazo tiene que incluir una lista de preguntas o escenas." };
    const valid = readCards(rawCards);
    if (!error) {
      cards.push(...valid);
      timeline.push(...valid.map((card): DeckEntry => ({ type: "question", card })));
    }
  }
  if (error) return { cards: [], scenes: [], timeline: [], depth: null, error };
  if (!cards.length) return { cards: [], scenes: [], timeline: [], depth: null, error: "El mazo está vacío: subí al menos una pregunta." };
  if (cards.length > GAME_CONFIG.maxCards)
    return { cards: [], scenes: [], timeline: [], depth: null, error: `El mazo tiene ${cards.length} cartas y el máximo es ${GAME_CONFIG.maxCards}.` };

  const rawDepth = source?.depth;
  const depth = rawDepth === undefined ? null : Number(rawDepth);
  if (depth !== null && !GAME_CONFIG.mazeDepths.some((allowed) => allowed === depth))
    return { cards: [], scenes: [], timeline: [], depth: null, error: `La profundidad debe ser una de estas cantidades de preguntas: ${GAME_CONFIG.mazeDepths.join(", ")}.` };
  if (depth !== null && depth !== cards.length)
    return { cards: [], scenes: [], timeline: [], depth: null, error: `La profundidad elegida es ${depth}, pero el mazo tiene ${cards.length} preguntas.` };
  return { cards, scenes, timeline, depth, error: null };
}

export function publicView(room: GameRoom): RoomState {
  const { sockets: _s, cards: _c, timeline: _tl, remaining: _r, drawn: _d, discardedFor: _dd, timers: _t, votes: _v, wrongPlayers: _w, ...state } = room;
  return {
    ...state,
    players: state.players.map((p) => ({ ...p })),
    game: state.game ? { ...state.game, current: state.game.current ? { ...state.game.current } : null, currentScene: state.game.currentScene ? { ...state.game.currentScene, beats: state.game.currentScene.beats.map((beat) => ({ ...beat })) } : null, sceneReady: [...state.game.sceneReady] } : null,
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
const onlinePlayers = (room: GameRoom) => room.players.filter((p) => p.online);

/** Ofrece un único rescate cuando cae el grupo; después, la derrota es definitiva. */
function settle(room: GameRoom, hooks: EngineHooks) {
  if (!onlinePlayers(room).length) return finish(room, hooks, "abandoned"), true;
  if (!alive(room).length) {
    const g = room.game!;
    if (g.shopOpen) return true;
    if (g.emergencyRescueGranted) return finish(room, hooks, "lost"), true;
    g.emergencyRescueGranted = true;
    const price = getShopPrices(room.players.length).revive;
    for (const player of room.players) player.coins = Math.max(price, player.coins);
    // Si la caída sucede por abandono durante una pregunta, esa carta sigue pendiente.
    if (room.drawn && !g.reveal) room.remaining.push({ type: "question", card: room.drawn });
    if (g.currentScene) room.remaining.push({ type: "scene", scene: g.currentScene });
    clearTimers(room);
    clearQuestion(room);
    g.currentScene = null;
    g.reveal = null;
    g.continueReady = [];
    g.shopOpen = true;
    g.encounter = "shop";
    hooks.onState(room);
    hooks.onShop?.(room, 0);
    return true;
  }
  return false;
}

/** Marca al jugador como fuera del combate sin cortar su conexión a la sala. */
export function forfeitPlayer(room: GameRoom, hooks: EngineHooks, player: Player) {
  if (room.status !== "playing" || player.eliminated) return;
  player.hp = 0;
  player.eliminated = true;
  if (room.game?.reveal) hooks.onState(room);
  else if (!settle(room, hooks)) hooks.onState(room);
}

/** Cierra la ronda pero deja la carta a la vista, para que el reveal pueda señalar la respuesta. */
function closeQuestion(room: GameRoom) {
  room.discardedFor = null;
  const g = room.game;
  if (g) {
    g.deadline = 0;
    g.answerStartsAt = 0;
  }
}

function clearQuestion(room: GameRoom) {
  closeQuestion(room);
  room.drawn = null;
  if (room.game) room.game.current = null;
}

function narrow(visible: number[], answer: number, keep: number) {
  const wrong = shuffle(visible.filter((i) => i !== answer));
  return shuffle([...wrong.slice(0, keep - 1), answer]);
}

function visibleFor(room: GameRoom, card: Card): number[] {
  let visible = shuffle(card.options.map((_, i) => i));
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
  room.timers.deadline = setTimeout(() => resolveVotes(room, hooks, true), previewMs + answerMs);
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
  room.timers.deadline = setTimeout(() => resolveVotes(room, hooks, true), Math.max(0, g.deadline - Date.now()));
}

function finish(room: GameRoom, hooks: EngineHooks, outcome: Outcome) {
  clearTimers(room);
  const g = room.game;
  if (g) {
    g.outcome = outcome;
    g.finishedAt = Date.now();
    g.encounter = null;
    g.shopOpen = false;
    g.reveal = null;
  }
  clearQuestion(room);
  if (g) g.currentScene = null;
  room.remaining = [];
  room.status = "results";
  hooks.onState(room);
}

function advance(room: GameRoom, hooks: EngineHooks) {
  const g = room.game;
  if (!g || room.status !== "playing") return;
  clearTimers(room);
  g.continueReady = [];
  if (g.enemy && g.enemy.hp === 0) {
    g.enemiesDefeated += 1;
    for (const player of room.players) player.coins += 2;
    g.enemy = null;
  }
  if (settle(room, hooks)) return;
  g.reveal = null;
  clearQuestion(room);
  if (!room.remaining.length) return finish(room, hooks, "won");
  if (g.questionsCompleted > 0 && g.questionsCompleted % GAME_CONFIG.encounterEveryQuestions === 0) {
    const encounters = ["shop", "campfire", "shop", "treasure", "shop", "shrine"] as const;
    g.encounter = encounters[g.encounterCount++ % encounters.length];
    g.encounterClaimed = [];
    g.shopOpen = g.encounter === "shop";
    hooks.onState(room);
    if (g.shopOpen) hooks.onShop?.(room, 0);
    return;
  }
  if (!g.enemy) spawnEnemy(room);
  dealCard(room, hooks);
}

/** Confirma la lectura del resultado o la salida de un encuentro entre todos los conectados. */
export function continueGame(room: GameRoom, hooks: EngineHooks, player: Player, phase = room.game ? getContinuePhase(room.game) : "") {
  const g = room.game;
  if (!g || phase !== getContinuePhase(g) || room.status !== "playing" || !player.online || (!g.reveal && !g.encounter)) return;
  if (g.reveal && Date.now() < g.revealedAt + GAME_CONFIG.answerRevealMs) return;
  if (g.shopOpen && !alive(room).length) return hooks.onError(room, player.id, "PARTY_DOWN", "Usá un vial de resurrección de la mochila para seguir.");
  if (!g.continueReady.includes(player.id)) g.continueReady.push(player.id);
  reconcileContinue(room, hooks);
}

/** Las confirmaciones de jugadores desconectados nunca bloquean al grupo. */
export function reconcileContinue(room: GameRoom, hooks: EngineHooks) {
  const g = room.game;
  if (!g || room.status !== "playing") return;
  const required = onlinePlayers(room);
  if (!required.length) return finish(room, hooks, "abandoned");
  if ((g.reveal || g.encounter) && required.every(player => g.continueReady.includes(player.id))) {
    if (g.encounter) {
      if (!alive(room).length) return;
      g.encounter = null;
      g.shopOpen = false;
      g.continueReady = [];
      if (!g.enemy) spawnEnemy(room);
      dealCard(room, hooks);
    } else advance(room, hooks);
  } else hooks.onState(room);
}

/** Cada integrante elige una recompensa una sola vez en el encuentro. */
export function claimEncounter(room: GameRoom, hooks: EngineHooks, player: Player, choice: string) {
  const g = room.game;
  if (!g || room.status !== "playing" || !g.encounter || g.encounter === "shop" || g.encounterClaimed.includes(player.id)) return;
  if (g.encounter === "campfire" && choice === "heal") {
    player.hp = Math.min(player.maxHp, player.hp + 1);
    player.eliminated = false;
  } else if ((g.encounter === "campfire" || g.encounter === "shrine") && choice === "focus") {
    g.abilityReadyAt[player.id] = g.turnNumber + 1;
  } else if (g.encounter === "treasure" && choice === "coins") player.coins += 4;
  else if (g.encounter === "treasure" && choice === "item") player.inventory.bomb = (player.inventory.bomb ?? 0) + 1;
  else if (g.encounter === "shrine" && choice === "item") player.inventory.ward = (player.inventory.ward ?? 0) + 1;
  else return;
  g.encounterClaimed.push(player.id);
  hooks.onState(room);
}

function dealCard(room: GameRoom, hooks: EngineHooks) {
  const g = room.game;
  if (!g) return;
  if (!room.remaining.length) return finish(room, hooks, "won");
  const entry = room.remaining.pop();
  if (!entry) return finish(room, hooks, "won");
  if (entry.type === "scene") {
    room.drawn = null;
    g.current = null;
    g.currentScene = entry.scene;
    g.sceneReady = [];
    g.answerStartsAt = 0;
    g.deadline = 0;
    g.visibleOptions = null;
    hooks.onState(room);
    return;
  }
  const card = entry.card;
  g.reveal = null;
  g.continueReady = [];
  g.currentScene = null;
  g.sceneReady = [];
  g.turnNumber += 1;
  for (const [playerId, active] of Object.entries(g.usedAbilities)) {
    g.usedAbilities[playerId] = active.filter((ability) => !["discard", "heal", "extend", "potion"].includes(ability));
  }
  room.drawn = card;
  g.current = { id: card.id, prompt: card.prompt, options: card.options };
  g.visibleOptions = visibleFor(room, card);
  room.discardedFor = null;
  room.wrongPlayers.clear();
  room.votes.clear();
  g.votesReceived = 0;
  g.pending = room.remaining.filter(entry => entry.type === "question").length + 1;
  armDeadline(room, hooks);
  hooks.onState(room);
}

function resolveVotes(room: GameRoom, hooks: EngineHooks, timeUp = false) {
  const g = room.game;
  const card = room.drawn;
  if (!g || !card || g.reveal || !g.deadline || room.status !== "playing") return;
  clearTimers(room);
  if (!onlinePlayers(room).length) return finish(room, hooks, "abandoned");
  const voters = alive(room).filter((player) => player.online || room.votes.has(player.id));
  const wrongPlayers = voters.filter((player) => room.votes.get(player.id) !== card.answer);
  const correctPlayers = voters.filter((player) => room.votes.get(player.id) === card.answer);
  const wardBlocked = g.teamWard && wrongPlayers.length > 0;
  if (wardBlocked) consumeTeamWard(room);
  const enemy = g.enemy;
  let playersDamaged = 0;
  for (const player of wrongPlayers) {
    const evaded = !wardBlocked && consumeShield(room, player);
    if (wardBlocked || evaded) continue;
    player.hp = Math.max(0, player.hp - (enemy?.trait === "furioso" ? 2 : 1));
    if (!player.hp) player.eliminated = true;
    playersDamaged++;
  }
  let damage = 0;
  if (enemy) {
    for (const player of correctPlayers) {
      let hit = 1;
      const active = activeAbilities(room, player);
      if (player.role === "Guerrero" && active.includes("strike")) {
        hit += enemy.trait === "blindado" ? 1 : 2;
        consumeAbilityEffect(room, player, "strike");
      }
      damage += hit;
    }
    const hunter = room.players.find((mate) => mate.role === "Explorador" && activeAbilities(room, mate).includes("track"));
    if (hunter && correctPlayers.length) { damage += 1; consumeAbilityEffect(room, hunter, "track"); }
    if (correctPlayers.length) damage += g.bonusDamage;
    if (correctPlayers.length) g.bonusDamage = 0;
    if (enemy.trait === "escurridizo" && damage > 0) damage -= 1;
    enemy.hp = Math.max(0, enemy.hp - damage);
    if (enemy.trait === "vampiro" && playersDamaged > 0 && enemy.hp > 0) {
      enemy.hp = Math.min(enemy.maxHp, enemy.hp + 1);
    }
  }
  g.questionsCompleted += 1;
  g.pending = room.remaining.filter(entry => entry.type === "question").length;
  g.mastered += correctPlayers.length > 0 ? 1 : 0;
  g.correctAnswers += correctPlayers.length;
  g.answersGiven += voters.length;
  for (const player of voters) {
    player.answersGiven += 1;
    if (room.votes.get(player.id) === card.answer) { player.correctAnswers += 1; player.coins += 1; }
  }
  closeQuestion(room);
  g.revealedAt = Date.now();
  g.continueReady = [];
  g.reveal = {
    correct: correctPlayers.length > 0,
    answer: card.answer,
    ...(card.explanation ? { explanation: card.explanation } : {}),
    damage,
    healedPlayer: null,
    healedAmount: 0,
    timeUp,
    wardBlocked,
    enemyDefeated: Boolean(enemy && enemy.hp === 0),
    correctVotes: correctPlayers.length,
    wrongVotes: wrongPlayers.length,
  };
  hooks.onState(room);
  hooks.onReveal(room, g.reveal);
}

/** Reconcilia desconexiones sin resolver dos veces ni anticipar el reloj. */
export function reconcileVotes(room: GameRoom, hooks: EngineHooks) {
  reconcileContinue(room, hooks);
}

/** Prepara una expedición nueva y reinicia las estadísticas y la mochila. */
export function startGame(room: GameRoom, hooks: EngineHooks) {
  if (room.status !== "lobby" || !room.cards.length) return;
  clearTimers(room);
  room.wrongPlayers ??= new Set();
  room.votes ??= new Map();
  room.timeline ??= room.cards.map((card): DeckEntry => ({ type: "question", card }));
  const limit = room.settings.cardCount > 0 ? Math.min(room.settings.cardCount, room.cards.length) : room.cards.length;
  const selected: DeckEntry[] = [];
  let selectedCards = 0;
  for (const entry of room.timeline) {
    if (entry.type === "scene") {
      if (selectedCards < limit) selected.push(entry);
    } else if (selectedCards < limit) {
      selected.push(entry);
      selectedCards += 1;
    }
  }
  room.remaining = selected.reverse();
  room.drawn = null;
  room.discardedFor = null;
  for (const p of room.players) {
    p.hp = GAME_CONFIG.playerMaxHp;
    p.maxHp = GAME_CONFIG.playerMaxHp;
    p.eliminated = false;
    p.coins = 3;
    p.inventory = { healing: 1 };
    p.correctAnswers = 0;
    p.answersGiven = 0;
  }
  room.status = "playing";
  room.game = {
    pending: selectedCards,
    totalQuestions: selectedCards,
    questionsCompleted: 0,
    correctAnswers: 0,
    answersGiven: 0,
    reveal: null,
    revealedAt: 0,
    continueReady: [],
    encounter: null,
    encounterCount: 0,
    encounterClaimed: [],
    mastered: 0,
    enemiesDefeated: 0,
    enemy: null,
    current: null,
    currentScene: null,
    sceneReady: [],
    scenesCompleted: 0,
    sceneCount: selected.filter((entry) => entry.type === "scene").length,
    answerStartsAt: 0,
    deadline: 0,
    visibleOptions: null,
    votesReceived: 0,
    usedAbilities: {},
    turnNumber: 0,
    abilityReadyAt: {},
    teamWard: false,
    startedAt: Date.now(),
    finishedAt: null,
    outcome: null,
    shopOpen: false,
    bonusDamage: 0,
    emergencyRescueGranted: false,
  };
  spawnEnemy(room);
  dealCard(room, hooks);
}

function advanceFromSceneIfReady(room: GameRoom, hooks: EngineHooks) {
  const g = room.game;
  if (!g?.currentScene) return false;
  if (!onlinePlayers(room).length) { finish(room, hooks, "abandoned"); return true; }
  const required = onlinePlayers(room);
  if (!required.length || !required.every((player) => g.sceneReady.includes(player.id))) return false;
  g.currentScene = null;
  g.sceneReady = [];
  g.scenesCompleted += 1;
  dealCard(room, hooks);
  return true;
}

/** Registra la confirmación del jugador y avanza cuando ya confirmó todo el equipo conectado. */
export function continueScene(room: GameRoom, hooks: EngineHooks, player: Player) {
  const g = room.game;
  if (!g?.currentScene || room.status !== "playing") return;
  if (!g.sceneReady.includes(player.id)) g.sceneReady.push(player.id);
  if (!advanceFromSceneIfReady(room, hooks)) hooks.onState(room);
}

/** Evita que la desconexión de alguien deje la escena esperando una confirmación imposible. */
export function reconcileSceneReady(room: GameRoom, hooks: EngineHooks) {
  if (!advanceFromSceneIfReady(room, hooks)) hooks.onState(room);
}

export function handleAnswer(room: GameRoom, hooks: EngineHooks, player: Player, answer: number) {
  const g = room.game;
  const card = room.drawn;
  if (!g || room.status !== "playing" || !card || g.reveal || !g.deadline) return;
  if (player.eliminated) {
    hooks.onError(room, player.id, "ELIMINATED", "Caíste: podés mirar, pero ya no respondés.");
    return;
  }
  if (Date.now() < g.answerStartsAt) {
    hooks.onError(room, player.id, "QUESTION_PREVIEW", "Esperá a que aparezcan las opciones para responder.");
    return;
  }
  if (Date.now() > g.deadline) return;
  if (!Number.isInteger(answer) || answer < 0 || answer >= card.options.length || !g.visibleOptions?.includes(answer) || room.votes.has(player.id)) return;
  room.votes.set(player.id, answer);
  g.votesReceived = room.votes.size;
  hooks.onState(room);
}

/** Compra objetos para guardarlos, incluso cuando todavía no hacen falta. */
export function buyShopItem(room: GameRoom, hooks: EngineHooks, player: Player, item: ShopItem, _targetId?: string) {
  const g = room.game;
  if (!g || room.status !== "playing" || !g.shopOpen || !Object.hasOwn(getShopPrices(room.players.length), item)) return;
  const price = getShopPrices(room.players.length)[item];
  if (player.coins < price) return hooks.onError(room, player.id, "NOT_ENOUGH_COINS", "No te alcanzan las monedas para ese objeto.");
  player.coins -= price;
  player.inventory[item] = (player.inventory[item] ?? 0) + 1;
  hooks.onState(room);
}

/** Usa un objeto de la mochila en cualquier fase de la partida; sólo se consume si aplica. */
export function useItem(room: GameRoom, hooks: EngineHooks, player: Player, item: ShopItem, targetId?: string) {
  const g = room.game;
  if (!g || room.status !== "playing" || !Object.hasOwn(player.inventory, item) || !(player.inventory[item]! > 0)) return;
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
    const nextTurn = g.turnNumber + (g.deadline ? 0 : 1);
    if (!room.players.some(mate => (g.abilityReadyAt[mate.id] ?? 0) > nextTurn)) return hooks.onError(room, player.id, "FOCUS_NOT_NEEDED", "Las habilidades ya están listas para el próximo combate.");
    for (const mate of room.players) g.abilityReadyAt[mate.id] = g.turnNumber;
  }
  player.inventory[item]! -= 1;
  hooks.onState(room);
  hooks.onItem?.(room, player, item);
}

export function useAbility(room: GameRoom, hooks: EngineHooks, player: Player, ability: Ability) {
  const g = room.game;
  if (!g || room.status !== "playing" || !g.current || g.reveal || !g.deadline) return;
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
  if (active.includes(ability) && ["strike", "evade", "track"].includes(ability)) return hooks.onError(room, player.id, "ABILITY_ACTIVE", "Ese poder sigue preparado para el próximo impacto.");
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
