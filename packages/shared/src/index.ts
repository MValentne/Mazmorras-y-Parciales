export const GAME_CONFIG = {
  roomCodeLength: 5,
  maxPlayers: 12,
  nicknameMinLength: 2,
  nicknameMaxLength: 18,
  roomInactiveMs: 30 * 60 * 1000,
  roles: ["Guerrero", "Mago", "Clérigo", "Ladrón", "Bardo", "Paladín", "Explorador", "Alquimista"] as const,
  playerMaxHp: 3,
  promptPreviewSeconds: 10,
  questionTimeSeconds: 25,
  bardAbilitySeconds: 10,
  answerRevealMs: 4500,
  minOptions: 2,
  maxOptions: 6,
  mutedEnemyOptions: 3,
  maxCards: 100,
  maxPromptLength: 300,
  maxOptionLength: 160,
  maxTitleLength: 60,
  maxScenes: 20,
  maxSceneTitleLength: 70,
  maxSceneSettingLength: 100,
  maxSceneObjectiveLength: 180,
  maxSceneBeatTitleLength: 70,
  maxSceneBeatTextLength: 600,
  sceneBeatCount: { min: 2, max: 4 },
  mazeDepths: [40, 60, 80, 100],
} as const;

export const ENEMIES = [
  { id: "lodo", name: "Lodo de Repaso", hp: 3, trait: null },
  { id: "esqueleto", name: "Esqueleto Olvidado", hp: 4, trait: null },
  { id: "espectro", name: "Espectro de la Distracción", hp: 5, trait: "mudo" },
  { id: "golem", name: "Golem de Apuntes", hp: 7, trait: "blindado" },
  { id: "dragon", name: "Dragón de Parciales", hp: 6, trait: null },
  { id: "spider", name: "Araña de Tinta", hp: 4, trait: null },
  { id: "mimic", name: "Cofre Tramposo", hp: 5, trait: null },
  { id: "bruja", name: "Bruja de los Apuntes", hp: 5, trait: "mudo" },
  { id: "troll", name: "Trol de Recuperatorio", hp: 8, trait: "blindado" },
  { id: "cuervo", name: "Cuervo de Tinta", hp: 4, trait: null },
] as const satisfies readonly { id: string; name: string; hp: number; trait: string | null }[];

export type Role = (typeof GAME_CONFIG.roles)[number];
export type RoomStatus = "lobby" | "playing" | "results";
export type Ability = "strike" | "discard" | "heal" | "evade" | "extend" | "ward" | "track" | "potion";
export type Outcome = "won" | "lost" | "abandoned";

export const ROLE_ABILITIES: Record<Role, Ability> = {
  Guerrero: "strike", Mago: "discard", "Clérigo": "heal", Ladrón: "evade",
  Bardo: "extend", "Paladín": "ward", Explorador: "track", Alquimista: "potion",
};

/** Preguntas completas que deben pasar antes de que cada poder vuelva a estar listo. */
export const ABILITY_COOLDOWNS: Record<Role, number> = {
  Guerrero: 3, Mago: 3, "Clérigo": 3, Ladrón: 2,
  Bardo: 3, "Paladín": 4, Explorador: 3, Alquimista: 4,
};

export const SHOP_BASE_PRICES = { healing: 3, revive: 3, phoenix: 12, ward: 5, partyHeal: 7, bomb: 6, focus: 6 } as const;
export type ShopItem = keyof typeof SHOP_BASE_PRICES;

/** Suma una moneda por cada integrante que supere el grupo base de dos. */
export function getShopPrices(playerCount: number) {
  const surcharge = Math.max(0, Math.floor(playerCount) - 2);
  return Object.fromEntries(Object.entries(SHOP_BASE_PRICES).map(([item, price]) => [item, price + surcharge])) as Record<ShopItem, number>;
}

export interface Card {
  id: string;
  prompt: string;
  options: string[];
  answer: number;
  explanation?: string;
}

export interface SceneBeat {
  heading: string;
  text: string;
}

export interface DeckScene {
  id: string;
  title: string;
  setting: string;
  objective: string;
  beats: SceneBeat[];
}

/** Escena de carga: trae las preguntas narradas por esa sección. */
export interface DeckSceneInput extends Omit<DeckScene, "id"> {
  cards: Omit<Card, "id">[];
}

/** Lo que se manda al cliente mientras la pregunta está en juego: nunca incluye la respuesta ni la explicación. */
export interface PublicCard {
  id: string;
  prompt: string;
  options: string[];
}

export interface Enemy {
  id: string;
  name: string;
  hp: number;
  maxHp: number;
  trait: string | null;
}

export interface Player {
  id: string;
  nickname: string;
  role: Role | null;
  online: boolean;
  isCreator: boolean;
  hp: number;
  maxHp: number;
  eliminated: boolean;
  coins: number;
}

export interface RoomSettings {
  questionTimeSeconds: number;
  /** 0 = usar el mazo entero. */
  cardCount: number;
}

export interface DeckInfo {
  title: string;
  size: number;
  depth?: number;
  scenes?: number;
}

export interface GameState {
  pending: number;
  mastered: number;
  enemiesDefeated: number;
  enemy: Enemy | null;
  current: PublicCard | null;
  currentScene: DeckScene | null;
  sceneReady: string[];
  scenesCompleted: number;
  sceneCount: number;
  answerStartsAt: number;
  deadline: number;
  visibleOptions: number[] | null;
  votesReceived: number;
  usedAbilities: Record<string, Ability[]>;
  turnNumber: number;
  abilityReadyAt: Record<string, number>;
  teamWard: boolean;
  startedAt: number;
  finishedAt: number | null;
  outcome: Outcome | null;
  shopOpen: boolean;
  bonusDamage: number;
  emergencyRescueGranted: boolean;
}

export interface RoomState {
  code: string;
  status: RoomStatus;
  creatorId: string;
  players: Player[];
  settings: RoomSettings;
  deck: DeckInfo | null;
  game: GameState | null;
  updatedAt: number;
}

export interface Reveal {
  correct: boolean;
  /** null en un fallo: la respuesta correcta no se revela hasta que termina la ronda. */
  answer: number | null;
  explanation?: string;
  damage: number;
  healedPlayer: string | null;
  healedAmount: number;
  timeUp: boolean;
  wardBlocked?: boolean;
  enemyDefeated: boolean;
  correctVotes?: number;
  wrongVotes?: number;
}

export type ClientEvents = {
  "room:create": (payload: { playerId: string; nickname: string }) => void;
  "room:join": (payload: { code: string; playerId: string; nickname: string }) => void;
  "room:reconnect": (payload: { code: string; playerId: string }) => void;
  "room:leave": () => void;
  "player:role": (payload: { role: Role }) => void;
  /** Sin id: el servidor valida el mazo y le asigna los identificadores. */
  "deck:upload": (payload: { title: string; cards?: Omit<Card, "id">[]; scenes?: DeckSceneInput[]; depth?: number }) => void;
  /** Sin playerId: el servidor lo toma de la sesión del socket, no del payload. */
  "game:start": () => void;
  "game:answer": (payload: { answer: number }) => void;
  "game:scene:continue": () => void;
  "game:forfeit": () => void;
  "game:ability": (payload: { ability: Ability }) => void;
  "game:shop:buy": (payload: { item: "healing" | "revive" | "phoenix" | "ward" | "partyHeal" | "bomb" | "focus"; targetId?: string }) => void;
  "game:shop:continue": () => void;
  /** Vuelve al lobby desde la pantalla de resultados, para rearmar otra ronda. */
  "game:lobby": () => void;
};

export type ServerEvents = {
  "room:state": (room: RoomState) => void;
  "room:error": (error: { code: string; message: string }) => void;
  "room:created": (payload: { code: string }) => void;
  "room:joined": (payload: { code: string }) => void;
  "room:closed": (payload: { code: string; message: string }) => void;
  "room:left": () => void;
  "game:reveal": (reveal: Reveal) => void;
  "game:ability": (announcement: { playerId: string; nickname: string; role: Role; ability: Ability }) => void;
  "game:shop": (shop: { coinsAwarded: number; enemiesDefeated: number }) => void;
};
