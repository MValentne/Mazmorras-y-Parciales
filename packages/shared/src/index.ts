export const GAME_CONFIG = {
  roomCodeLength: 5,
  maxPlayers: 12,
  nicknameMinLength: 2,
  nicknameMaxLength: 18,
  roomInactiveMs: 30 * 60 * 1000,
  roles: ["Guerrero", "Mago", "Clérigo", "Ladrón", "Bardo"] as const,
  playerMaxHp: 3,
  questionTimeSeconds: 20,
  extraTimeSeconds: 5,
  answerRevealMs: 4500,
  minOptions: 2,
  maxOptions: 6,
  mutedEnemyOptions: 3,
  maxCards: 600,
  maxPromptLength: 300,
  maxOptionLength: 160,
  maxTitleLength: 60,
} as const;

export const ENEMIES = [
  { id: "lodo", name: "Lodo de Repaso", hp: 3, trait: null },
  { id: "esqueleto", name: "Esqueleto Olvidado", hp: 4, trait: null },
  { id: "espectro", name: "Espectro de la Distracción", hp: 5, trait: "mudo" },
  { id: "golem", name: "Golem de Apuntes", hp: 7, trait: "blindado" },
] as const satisfies readonly { id: string; name: string; hp: number; trait: string | null }[];

export type Role = (typeof GAME_CONFIG.roles)[number];
export type RoomStatus = "lobby" | "playing" | "results";
export type Ability = "discard" | "evade" | "extend";
export type Outcome = "won" | "lost" | "abandoned";

export interface Card {
  id: string;
  prompt: string;
  options: string[];
  answer: number;
  explanation?: string;
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
}

export interface RoomSettings {
  questionTimeSeconds: number;
  /** 0 = usar el mazo entero. */
  cardCount: number;
}

export interface DeckInfo {
  title: string;
  size: number;
}

export interface GameState {
  pending: number;
  mastered: number;
  enemiesDefeated: number;
  enemy: Enemy | null;
  current: PublicCard | null;
  deadline: number;
  timeBonusMs: number;
  visibleOptions: number[] | null;
  usedAbilities: Record<string, Ability[]>;
  startedAt: number;
  finishedAt: number | null;
  outcome: Outcome | null;
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
  enemyDefeated: boolean;
}

export type ClientEvents = {
  "room:create": (payload: { playerId: string; nickname: string }) => void;
  "room:join": (payload: { code: string; playerId: string; nickname: string }) => void;
  "room:reconnect": (payload: { code: string; playerId: string }) => void;
  "player:role": (payload: { role: Role }) => void;
  /** Sin id: el servidor valida el mazo y le asigna los identificadores. */
  "deck:upload": (payload: { title: string; cards: Omit<Card, "id">[] }) => void;
  /** Sin playerId: el servidor lo toma de la sesión del socket, no del payload. */
  "game:start": () => void;
  "game:answer": (payload: { answer: number }) => void;
  "game:ability": (payload: { ability: Ability }) => void;
  /** Vuelve al lobby desde la pantalla de resultados, para rearmar otra ronda. */
  "game:lobby": () => void;
};

export type ServerEvents = {
  "room:state": (room: RoomState) => void;
  "room:error": (error: { code: string; message: string }) => void;
  "room:created": (payload: { code: string }) => void;
  "room:joined": (payload: { code: string }) => void;
  "room:closed": (payload: { code: string; message: string }) => void;
  "game:reveal": (reveal: Reveal) => void;
};
