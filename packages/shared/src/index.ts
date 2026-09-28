export const GAME_CONFIG = {
  roomCodeLength: 5,
  maxPlayers: 12,
  nicknameMinLength: 2,
  nicknameMaxLength: 18,
  roomInactiveMs: 30 * 60 * 1000,
  roles: ["Guerrero", "Mago", "Clérigo", "Ladrón", "Bardo"] as const,
} as const;

export type Role = (typeof GAME_CONFIG.roles)[number];
export type RoomStatus = "lobby" | "playing" | "results";
export interface Player {
  id: string;
  nickname: string;
  role: Role | null;
  online: boolean;
  isCreator: boolean;
}
export interface RoomSettings { questionTimeSeconds: number; cardCount: number }
export interface RoomState {
  code: string;
  status: RoomStatus;
  creatorId: string;
  players: Player[];
  settings: RoomSettings;
  updatedAt: number;
}
export type ClientEvents = {
  "room:create": (payload: { playerId: string; nickname: string }) => void;
  "room:join": (payload: { code: string; playerId: string; nickname: string }) => void;
  "room:reconnect": (payload: { code: string; playerId: string }) => void;
  "player:role": (payload: { role: Role }) => void;
};
export type ServerEvents = {
  "room:state": (room: RoomState) => void;
  "room:error": (error: { code: string; message: string }) => void;
  "room:created": (payload: { code: string }) => void;
  "room:joined": (payload: { code: string }) => void;
  "room:closed": (payload: { code: string; message: string }) => void;
};
