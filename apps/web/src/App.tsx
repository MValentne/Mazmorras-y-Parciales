import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { io, type Socket } from "socket.io-client";
import {
  GAME_CONFIG,
  getShopPrices,
  getContinuePhase,
  ABILITY_COOLDOWNS,
  type Ability,
  type ClientEvents,
  type DeckScene,
  type ShopItem,
  type Role,
  type RoomState,
  type ServerEvents,
} from "@dungeon/shared";
import { parseDeckFile } from "./deck";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || window.location.origin;
// getRandomValues también funciona al abrir la partida por HTTP en la red local.
const createPlayerId = () => {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const getPlayerId = () => {
  let id = localStorage.getItem("dungeon-player-id");
  if (!id) { id = createPlayerId(); localStorage.setItem("dungeon-player-id", id); }
  return id;
};
const roleInfo: Record<Role, string> = {
  Guerrero: "Golpe demoledor: +2 de daño en el próximo impacto.", Mago: "Ritual 50/50: descarta opciones hasta dejar dos.",
  "Clérigo": "Sanación mayor: cura hasta 2 vidas a un aliado.", Ladrón: "Paso espectral: evita tu próximo fallo.",
  Bardo: "Crescendo: suma 10 segundos a la pregunta actual.", "Paladín": "Muro sagrado: protege al grupo del próximo fallo.",
  Explorador: "Marca de presa: el próximo acierto del grupo hace +1 de daño.", Alquimista: "Tónico grupal: cura 1 vida a todo el equipo.",
};
const abilityInfo: Record<Role, { ability: Ability; name: string; icon: string }> = {
  Guerrero: { ability: "strike", name: "Golpe demoledor", icon: "⚔" },
  Mago: { ability: "discard", name: "Ritual 50/50", icon: "✧" },
  "Clérigo": { ability: "heal", name: "Sanación mayor", icon: "✚" },
  Ladrón: { ability: "evade", name: "Paso espectral", icon: "◈" },
  Bardo: { ability: "extend", name: "Crescendo", icon: "♫" },
  "Paladín": { ability: "ward", name: "Muro sagrado", icon: "⬟" },
  Explorador: { ability: "track", name: "Marca de presa", icon: "➶" },
  Alquimista: { ability: "potion", name: "Tónico grupal", icon: "⚗" },
};
const effectLabel: Partial<Record<Ability, string>> = {
  strike: "GOLPE CARGADO", discard: "50/50 ACTIVO", evade: "ESQUIVE LISTO", ward: "MURO SAGRADO",
  heal: "SANACIÓN USADA", track: "PRESA MARCADA", extend: "TIEMPO EXTRA", potion: "TÓNICO USADO",
};
const roleSpriteId = (role: Role | null) => role?.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase() ?? "unknown";
const roleSpriteAsset: Record<Role, string> = {
  Guerrero: "warrior", Mago: "mage", "Clérigo": "cleric", Ladrón: "thief",
  Bardo: "bard", "Paladín": "paladin", Explorador: "explorer", Alquimista: "alchemist",
};
const playerSpriteUrl = (role: Role | null) => `/sprites/characters/${role ? roleSpriteAsset[role] : "unknown"}.png`;
const TRAIT_INFO: Record<string, string> = {
  mudo: "Mudo · muestra menos opciones",
  blindado: "Blindado · reduce el golpe del Guerrero",
  furioso: "Furioso · hace el doble de daño al fallar",
  vampiro: "Vampiro · se cura 1 PV si alguien falla",
  escurridizo: "Escurridizo · esquiva 1 punto de daño recibido",
};

export default function App() {
  const [initialCode, setInitialCode] = useState(() => window.location.pathname.match(/^\/sala\/([^/]+)\/?$/i)?.[1]?.toUpperCase() ?? "");
  const [socket, setSocket] = useState<Socket<ServerEvents, ClientEvents> | null>(null);
  const [room, setRoom] = useState<RoomState | null>(null);
  const [pendingRole, setPendingRole] = useState<Role | null>(null);
  const [nickname, setNickname] = useState(localStorage.getItem("dungeon-nickname") ?? "");
  const [code, setCode] = useState(initialCode);
  const [error, setError] = useState("");
  const [joining, setJoining] = useState(false);
  const [qr, setQr] = useState("");
  const [vote, setVote] = useState<{ cardId: string; answer: number | null } | null>(null);
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [deckBusy, setDeckBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [leavingRoom, setLeavingRoom] = useState(false);
  const [abilityQueue, setAbilityQueue] = useState<Array<{ playerId: string; nickname: string; role: Role; ability: Ability }>>([]);
  const abilityNotice = abilityQueue[0] ?? null;
  const [itemNotice, setItemNotice] = useState<{ playerId: string; nickname: string; item: ShopItem } | null>(null);
  const playerId = useMemo(getPlayerId, []);

  useEffect(() => {
    const role = room?.players.find(player => player.id === playerId)?.role ?? null;
    setPendingRole(role);
  }, [room?.code, room?.players, playerId]);

  useEffect(() => {
    const client: Socket<ServerEvents, ClientEvents> = io(SERVER_URL, { autoConnect: false, reconnection: true });
    setSocket(client);
    client.on("room:state", state => { setRoom(state); setError(""); });
    client.on("room:error", e => { setError(e.message); setJoining(false); if (["ROOM_NOT_FOUND", "PLAYER_NOT_FOUND"].includes(e.code)) { setRoom(null); sessionStorage.removeItem("dungeon-room-code"); } });
    client.on("room:created", ({ code: newCode }: { code: string }) => {
      setCode(newCode); setJoining(false); history.pushState({}, "", `/sala/${newCode}`);
    });
    client.on("room:joined", ({ code: joinedCode }: { code: string }) => {
      setCode(joinedCode); setJoining(false); history.pushState({}, "", `/sala/${joinedCode}`);
    });
    client.on("room:closed", (e: { message: string }) => {
      setError(e.message); setRoom(null); setCode(""); setInitialCode(""); setMenuOpen(false); history.pushState({}, "", "/");
    });
    client.on("room:left", () => {
      setRoom(null); setCode(""); setInitialCode(""); setError(""); setMenuOpen(false); setLeavingRoom(false);
      sessionStorage.removeItem("dungeon-room-code"); history.pushState({}, "", "/");
    });
    client.on("game:vote", setVote);
    client.on("game:ability", notice => setAbilityQueue(queue => [...queue, notice]));
    client.on("game:item", setItemNotice);
    client.on("disconnect", () => setConnected(false));
    client.on("connect", () => {
      setConnected(true);
      const savedCode = sessionStorage.getItem("dungeon-room-code");
      const pathCode = window.location.pathname.match(/^\/sala\/([^/]+)\/?$/i)?.[1]?.toUpperCase();
      if (savedCode && pathCode === savedCode) client.emit("room:reconnect", { code: savedCode, playerId });
      else if (savedCode) sessionStorage.removeItem("dungeon-room-code");
    });
    client.connect();
    return () => { client.disconnect(); };
  }, [playerId]);

  useEffect(() => {
    if (!abilityNotice) return;
    const timeout = window.setTimeout(() => setAbilityQueue(queue => queue.slice(1)), 1800);
    return () => window.clearTimeout(timeout);
  }, [abilityNotice]);

  useEffect(() => {
    if (room?.status !== "playing") { setAbilityQueue([]); setItemNotice(null); }
  }, [room?.status]);

  useEffect(() => {
    if (!itemNotice) return;
    const timeout = window.setTimeout(() => setItemNotice(null), 2400);
    return () => window.clearTimeout(timeout);
  }, [itemNotice]);

  useEffect(() => {
    if (room?.code) sessionStorage.setItem("dungeon-room-code", room.code);
    else sessionStorage.removeItem("dungeon-room-code");
    if (room) QRCode.toDataURL(`${window.location.origin}/sala/${room.code}`, { width: 180, margin: 1, color: { dark: "#e8d6a8", light: "#211e18" } }).then(setQr).catch(() => setQr(""));
  }, [room?.code]);

  // Sólo hace falta el tick del reloj mientras hay una pregunta en el aire.
  useEffect(() => {
    if (room?.status !== "playing") return;
    const tick = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(tick);
  }, [room?.status]);

  const enter = (create: boolean) => {
    const name = nickname.trim();
    setError("");
    if (!name) { setError("Elegí un apodo para entrar a la mazmorra."); return; }
    localStorage.setItem("dungeon-nickname", name);
    if (!socket?.connected) { setError("Conectando con el servidor… probá de nuevo en un momento."); return; }
    setJoining(true);
    if (create) socket.emit("room:create", { playerId, nickname: name });
    else socket.emit("room:join", { code, playerId, nickname: name });
  };
  const chooseRole = (role: Role) => {
    setPendingRole(role);
    socket?.emit("player:role", { role });
  };
  const copyInvite = async () => {
    try { await navigator.clipboard.writeText(`${location.origin}/sala/${room?.code}`); setError("Enlace copiado."); }
    catch { setError("No se pudo copiar automáticamente. Copiá el enlace de la barra del navegador."); }
  };
  const backHome = () => { setRoom(null); setCode(""); setInitialCode(""); setError(""); sessionStorage.removeItem("dungeon-room-code"); history.pushState({}, "", "/"); };
  const leaveRoom = () => {
    if (leavingRoom) return;
    if (!socket?.connected) { backHome(); return; }
    setLeavingRoom(true);
    socket.emit("room:leave");
  };

  const uploadDeck = async (file: File) => {
    setError("");
    setDeckBusy(true);
    const result = await parseDeckFile(file);
    setDeckBusy(false);
    if (result.error !== null) { setError(result.error); return; }
    socket?.emit("deck:upload", { title: result.title, cards: result.cards, ...(result.scenes ? { scenes: result.scenes } : {}), ...(result.depth !== undefined ? { depth: result.depth } : {}) });
  };

  if (!room) return <main className="page home home-pixel"><div className="home-layout">
    <section className="home-pitch"><div className="home-wordmark"><span className="brand-mark">M&amp;P</span><span>AVENTURA COOPERATIVA DE ESTUDIO</span></div>
      <div className="dungeon-scene" aria-hidden="true"><div className="scene-wall"/><div className="scene-door"><span/><span/></div><span className="scene-torch torch-left"/><span className="scene-torch torch-right"/><span className="scene-floor"/><span className="scene-flyer"/><span className="scene-hero"/></div>
      <h1>Mazmorras<br/><span>y Parciales</span></h1><p className="intro">Una historia para estudiar en equipo. Elijan sus personajes, recorran escenas y enfrenten cada desafío juntos.</p>
      <div className="home-rules"><span>HISTORIA · PREGUNTAS · EQUIPO</span></div>
    </section>
    <section className="panel entry"><p className="eyebrow">PREPARÁ LA PARTIDA</p><label htmlFor="nickname">Nombre de aventurero</label><input id="nickname" maxLength={GAME_CONFIG.nicknameMaxLength} value={nickname} onChange={e => setNickname(e.target.value)} placeholder="Ej.: NubeArcana" onKeyDown={e => e.key === "Enter" && (initialCode ? enter(false) : enter(true))}/>
      {initialCode ? <><p className="invite-tag">INVITACIÓN A LA SALA <strong>{initialCode}</strong></p><button className="primary full" disabled={joining} onClick={() => enter(false)}>{joining ? "Entrando…" : "Entrar a la sala"}</button></> : <><button className="primary full" disabled={joining} onClick={() => enter(true)}>{joining ? "Creando…" : "Crear una sala"}</button><div className="divider"><span>o unirse a una sala</span></div><div className="join-row"><input aria-label="Código de sala" value={code} onChange={e => setCode(e.target.value.toUpperCase().slice(0, GAME_CONFIG.roomCodeLength))} placeholder="CÓDIGO" maxLength={GAME_CONFIG.roomCodeLength} onKeyDown={e => e.key === "Enter" && enter(false)}/><button className="secondary" disabled={joining || !code} onClick={() => enter(false)}>Unirse</button></div></>}
      {error && <p role="status" className="message">{error}</p>}{(initialCode || error) && <button className="back-home" onClick={backHome}>Volver al inicio</button>}{!socket?.connected && <p className="connection">Conectando al servidor…</p>}
    </section>
    <footer className="home-footer">Mazmorras y Parciales · estudio cooperativo</footer>
  </div></main>;

  const me = room.players.find(p => p.id === playerId);
  const inviteUrl = `${location.origin}/sala/${room.code}`;

  if (room.status === "playing" && room.game) return (
    <main className="page game">
      <header className="top battle-nav"><div className="brand"><span>Mazmorras y Parciales</span></div><div className="battle-nav-actions"><button className="secondary nav-toggle" onClick={() => setMenuOpen(v => !v)} aria-expanded={menuOpen}>☰ Menú</button></div>
        {menuOpen && <nav className="game-menu" aria-label="Menú de partida"><strong>¿Qué querés hacer?</strong><button disabled={me?.eliminated} onClick={() => { socket?.emit("game:forfeit"); setMenuOpen(false); }}>Abandonar el combate</button><small>Vas a quedar como espectador mientras el grupo sigue.</small><button className="leave-action" disabled={leavingRoom} onClick={leaveRoom}>{leavingRoom ? "Saliendo…" : "Salir de la sala"}</button></nav>}
      </header>
      {!connected && <p className="connection-banner" role="status">Reconectando… Tu partida se recupera al volver la conexión.</p>}
      <GameBoard room={room} meId={playerId} myPick={vote?.cardId === room.game.current?.id ? vote?.answer ?? null : null} now={now} abilityNotice={abilityNotice} itemNotice={itemNotice} onPick={i => { if (socket?.connected) socket.emit("game:answer", { answer: i, cardId: room.game!.current!.id }); }} onAbility={a => socket?.connected && socket.emit("game:ability", { ability: a })} onBuy={item => socket?.connected && socket.emit("game:shop:buy", { item })} onUse={(item, targetId) => socket?.connected && socket.emit("game:item:use", { item, targetId })} onContinue={() => socket?.connected && socket.emit("game:continue", { phase: getContinuePhase(room.game!) })} onClaim={choice => socket?.connected && socket.emit("game:event:claim", { choice })} onSceneContinue={() => socket?.connected && socket.emit("game:scene:continue")} error={error}/>
    </main>
  );

  if (room.status === "results") return (
    <main className="page game">
      <header className="top"><div className="brand"><span>Mazmorras y Parciales</span></div></header>
      <ResultsScreen room={room} meId={playerId} onAgain={() => socket?.emit("game:lobby")} canRestart={me?.isCreator ?? false} onHome={leaveRoom}/>
    </main>
  );

  const sinRol = room.players.filter(p => !p.role).length;
  const ready = Boolean(room.deck) && sinRol === 0;
  const selectedRole = pendingRole ?? me?.role ?? null;
  return <main className="page lobby"><header className="top"><div className="brand"><span>Mazmorras y Parciales</span></div><div className="battle-nav-actions"><button className="secondary nav-toggle" disabled={leavingRoom} onClick={leaveRoom}>{leavingRoom ? "Saliendo…" : "Salir de la sala"}</button></div></header>
    <div className="lobby-grid"><section className="panel invite-card"><p className="eyebrow">LOBBY · COMPARTÍ LA INVITACIÓN</p><h1>La mazmorra<br/>se prepara</h1><div className="code-label">CÓDIGO DE SALA</div><div className="code">{room.code.split("").join(" ")}</div><button className="primary full" onClick={copyInvite}>Copiar enlace de invitación</button><p className="url">{inviteUrl}</p>{qr && <div className="qr-frame"><img src={qr} alt={`Código QR para entrar a la sala ${room.code}`}/><span>Escaneá para entrar</span></div>}<p className="small-note">Cualquiera con el enlace puede unirse mientras la sala esté abierta.</p></section>
      <section className="panel party-card"><div className="section-heading"><div><p className="eyebrow">EL GRUPO</p><h2>Jugadores <span className="count">{room.players.length}/{GAME_CONFIG.maxPlayers}</span></h2></div><span className="creator-note">{me?.isCreator ? "Sos el creador" : "Lobby de la partida"}</span></div>
        <ul className="players">{room.players.map(p => {
          const shownRole = p.id === playerId ? pendingRole ?? p.role : p.role;
          return <li key={p.id} className={`${!p.online ? "offline" : ""} ${p.id === playerId ? "self" : ""}`}><div className={`avatar character-sprite role-${roleSpriteId(shownRole)}`} aria-label={shownRole ?? "Aventurero"}>
            <span className="hero-art-window"><img src={playerSpriteUrl(shownRole)} alt=""/></span>
          </div><div className="player-name">{p.nickname}{p.id === playerId && <span className="self-badge">VOS</span>}{p.isCreator && <span className="host-badge">CREADOR</span>}<small>{p.online ? "En la sala" : "Reconectando…"}</small></div><span className={`role-pill ${shownRole ? "selected" : ""}`}>{shownRole ?? "Eligiendo rol"}</span></li>;
        })}</ul>
        <div className="role-select"><p className="eyebrow">ELEGÍ TU PERSONAJE</p><div className="selected-role-preview"><span className="selected-role-face"><span className="hero-art-window"><img src={playerSpriteUrl(selectedRole)} alt=""/></span></span><span><strong>{selectedRole ?? "Aventurero"}</strong><small>{selectedRole ? roleInfo[selectedRole] : "El rostro de tu personaje aparece acá cuando elijas un rol."}</small></span></div><div className="roles">{GAME_CONFIG.roles.map(role => <button key={role} className={`role-card ${(pendingRole ?? me?.role) === role ? "active" : ""}`} onClick={() => chooseRole(role)} aria-pressed={(pendingRole ?? me?.role) === role}><span className={`role-icon role-${roleSpriteId(role)}`}><span className="hero-art-window"><img src={playerSpriteUrl(role)} alt=""/></span></span><strong>{role}</strong><small>{roleInfo[role]}<em>Enfriamiento: {ABILITY_COOLDOWNS[role]} preguntas</em></small></button>)}</div></div>
        <DeckLoader room={room} busy={deckBusy} disabled={!me?.isCreator} onFile={uploadDeck}/>
        {error && <p role="status" className="message">{error}</p>}
        {me?.isCreator
          ? <><button className="primary full start" disabled={!ready || deckBusy} onClick={() => socket?.emit("game:start")}>{room.deck ? "Comenzar la mazmorra" : "Cargá un mazo para empezar"}</button>{room.deck && sinRol > 0 && <p className="small-note center">Falta elegir rol: {room.players.filter(p => !p.role).map(p => p.nickname).join(", ")}.</p>}</>
          : <div className="waiting"><span className="spinner"/> Esperando a que el creador empiece…</div>}
      </section></div>
  </main>;
}

function DeckLoader({ room, busy, disabled, onFile }: { room: RoomState; busy: boolean; disabled: boolean; onFile: (f: File) => void }) {
  return <div className="deck-loader">
    <p className="eyebrow">EL MAZO</p>
    {room.deck
      ? <div className="deck-loaded"><strong>{room.deck.title}</strong><span>{room.deck.size} {room.deck.size === 1 ? "pregunta" : "preguntas"}{room.deck.scenes ? ` · ${room.deck.scenes} escenas` : ""}</span></div>
      : <p className="small-note">{disabled ? "El creador de la sala carga el mazo." : "Subí un JSON narrativo con escenas y preguntas, o un CSV anterior en orden lineal."}</p>}
    {disabled
      ? null
      : <label className={`file-button ${busy ? "busy" : ""}`}>
          <input type="file" accept=".json,.csv,.txt" disabled={busy} onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }}/>
          {busy ? "Leyendo…" : room.deck ? "Reemplazar mazo" : "Elegir archivo"}
        </label>}
    <a className="link-button" href="/FORMATO-MAZO.md" download="FORMATO-MAZO.md" aria-label="Descargar FORMATO-MAZO.md">¿Qué formato tiene que tener?</a>
  </div>;
}

function SceneBoard({ room, meId, onContinue, error }: { room: RoomState; meId: string; onContinue: () => void; error: string }) {
  const game = room.game!;
  const scene = game.currentScene as DeckScene;
  const ready = new Set(game.sceneReady);
  const connected = room.players.filter(player => player.online);
  const readyCount = connected.filter(player => ready.has(player.id)).length;
  const meReady = ready.has(meId);
  return <div className="scene-board">
    <section className="panel scene-card">
      <header className="scene-heading">
        <p className="eyebrow">ESCENA {game.scenesCompleted + 1} DE {game.sceneCount}</p>
        <p className="scene-setting">{scene.setting}</p>
        <h1>{scene.title}</h1>
      </header>
      <section className="scene-objective"><span>RUMBO</span><p>{scene.objective}</p></section>
      <div className="scene-beats">{scene.beats.map((beat, index) => <article key={`${scene.id}-${index}`}><span className="beat-number">{String(index + 1).padStart(2, "0")}</span><div><h2>{beat.heading}</h2><p>{beat.text}</p></div></article>)}</div>
      <footer className="scene-controls">
        <button className="primary" disabled={meReady} onClick={onContinue}>{meReady ? "Ya confirmaste" : "Seguir a las preguntas"}</button>
        <p>{readyCount} de {connected.length} aventureros listos</p>
      </footer>
      {error && <p role="status" className="message">{error}</p>}
    </section>
    <section className="scene-roster" aria-label="Confirmaciones del grupo">{room.players.map(player => <div key={player.id} className={`${ready.has(player.id) ? "ready" : ""} ${!player.online ? "offline" : ""}`}>
      <span className="scene-roster-face"><span className="hero-art-window"><img src={playerSpriteUrl(player.role)} alt=""/></span></span>
      <span>{player.nickname}<small>{!player.online ? "Desconectado" : ready.has(player.id) ? "Listo" : "Leyendo"}</small></span>
      <b aria-hidden="true">{ready.has(player.id) ? "✓" : "·"}</b>
    </div>)}</section>
  </div>;
}

const itemInfo: Record<ShopItem, { name: string; sprite: string; description: string }> = {
  healing: { name: "Poción de vida", sprite: "life-potion", description: "Recuperá hasta 2 corazones." },
  revive: { name: "Vial de resurrección", sprite: "resurrection", description: "Reviví a un aventurero con 1 corazón." },
  partyHeal: { name: "Botiquín grupal", sprite: "medipack", description: "Curá 1 corazón a cada aliado en pie." },
  ward: { name: "Sello protector", sprite: "ward", description: "Protegé al grupo del próximo fallo." },
  bomb: { name: "Bomba arcana", sprite: "bomb", description: "Sumá 2 de daño al próximo acierto grupal." },
  focus: { name: "Pergamino de enfoque", sprite: "focus", description: "Recargá las habilidades del equipo." },
  phoenix: { name: "Alma fénix", sprite: "resurrection", description: "Reviví a todos los aliados caídos." },
};

function Popup({ title, children }: { title: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className="event-popup" aria-label={title} onCancel={e => e.preventDefault()}>{children}</dialog>;
}

function ReadyButton({ room, meId, onContinue, disabled = false }: { room: RoomState; meId: string; onContinue: () => void; disabled?: boolean }) {
  const ready = room.game!.continueReady;
  const connected = room.players.filter(p => p.online);
  const waiting = connected.filter(p => !ready.includes(p.id));
  return <div className="ready-controls">
    <button className="primary" disabled={disabled || ready.includes(meId)} onClick={onContinue}>{ready.includes(meId) ? "✓ Listo · esperando al grupo" : "Continuar →"}</button>
    <p role="status">{connected.length - waiting.length}/{connected.length} listos<span>{waiting.length ? `Falta: ${waiting.map(p => p.nickname).join(", ")}` : "¡Adelante!"}</span></p>
  </div>;
}

function Inventory({ room, meId, onUse }: { room: RoomState; meId: string; onUse: (item: ShopItem, targetId?: string) => void }) {
  const me = room.players.find(p => p.id === meId)!;
  const [target, setTarget] = useState("");
  const downed = room.players.filter(p => p.eliminated);
  const selectedTarget = downed.some(p => p.id === target) ? target : downed[0]?.id;
  const stocked = (Object.keys(itemInfo) as ShopItem[]).filter(item => (me.inventory[item] ?? 0) > 0);
  const canUse = (item: ShopItem) => {
    if (item === "healing") return !me.eliminated && me.hp < me.maxHp;
    if (item === "revive" || item === "phoenix") return downed.length > 0;
    if (item === "partyHeal") return room.players.some(p => !p.eliminated && p.hp < p.maxHp);
    if (item === "ward") return !room.game!.teamWard;
    if (item === "bomb") return room.game!.bonusDamage === 0;
    if (item === "focus") return room.players.some(p => (room.game!.abilityReadyAt[p.id] ?? 0) > room.game!.turnNumber + (room.game!.deadline ? 0 : 1));
    return true;
  };
  return <section className="inventory" aria-label="Tu mochila"><div className="inventory-heading"><h3>Mochila</h3><span><img src="/sprites/items/coin.png" alt="Monedas"/>{me.coins}</span></div>
    <div className="inventory-slots">{stocked.map(item => <button key={item} className="item-slot" disabled={!canUse(item)} onClick={() => onUse(item, item === "revive" ? selectedTarget : undefined)} title={`${itemInfo[item].name}: ${itemInfo[item].description}`} aria-label={`Usar ${itemInfo[item].name} (${me.inventory[item]})`}><img src={`/sprites/items/${itemInfo[item].sprite}.png`} alt=""/><span>{itemInfo[item].name}</span><b>×{me.inventory[item]}</b></button>)}{!stocked.length && <p className="empty-bag">La mochila está vacía. Reabastecete en la próxima tienda.</p>}</div>
    {downed.length > 0 && (me.inventory.revive ?? 0) > 0 && <label className="revive-target">Revivir a <select value={selectedTarget} onChange={e => setTarget(e.target.value)}>{downed.map(p => <option key={p.id} value={p.id}>{p.nickname}</option>)}</select></label>}
    <small>Elegí un objeto para usarlo. Los efectos preparados duran hasta activarse.</small>
  </section>;
}

function GameBoard({ room, meId, myPick, now, abilityNotice, itemNotice, onPick, onAbility, onBuy, onUse, onContinue, onClaim, onSceneContinue, error }: {
  room: RoomState; meId: string; myPick: number | null; now: number;
  abilityNotice: { playerId: string; nickname: string; role: Role; ability: Ability } | null;
  itemNotice: { playerId: string; nickname: string; item: ShopItem } | null;
  onPick: (i: number) => void; onAbility: (a: Ability) => void; onSceneContinue: () => void; error: string;
  onBuy: (item: ShopItem) => void; onUse: (item: ShopItem, targetId?: string) => void; onContinue: () => void;
  onClaim: (choice: "heal" | "focus" | "coins" | "item") => void;
}) {
  const game = room.game!;
  const me = room.players.find(p => p.id === meId)!;
  const enemy = game.enemy;
  const reveal = game.reveal;
  const closed = game.deadline === 0;
  const preview = !closed && now < game.answerStartsAt;
  const total = preview ? GAME_CONFIG.promptPreviewSeconds * 1000 : Math.max(1, game.deadline - game.answerStartsAt);
  const left = Math.max(0, preview ? game.answerStartsAt - now : game.deadline - now);
  const visible = game.visibleOptions ?? game.current?.options.map((_, i) => i) ?? [];
  const shown = myPick !== null && !visible.includes(myPick) ? [...visible, myPick] : visible;
  const canAct = !me.eliminated && !closed && !preview && left > 0 && myPick === null;
  const myAbility = me.role ? abilityInfo[me.role] : null;
  const myActiveEffects = game.usedAbilities[meId] ?? [];
  const abilityCooldown = Math.max(0, (game.abilityReadyAt[meId] ?? 0) - game.turnNumber);
  const abilityReady = !me.eliminated && !closed && !preview && left > 0 && abilityCooldown === 0;
  const correctVisible = Boolean(reveal && now >= game.revealedAt + GAME_CONFIG.feedbackCorrectDelayMs);
  const prices = getShopPrices(room.players.length);
  const event = game.encounter;
  const claimed = game.encounterClaimed.includes(meId);
  const inventory = <Inventory room={room} meId={meId} onUse={onUse}/>;
  const cast = abilityNotice ? <div key={`${abilityNotice.playerId}-${abilityNotice.ability}-${game.turnNumber}`} className={`spell-cast spell-${abilityNotice.ability}`} role="status"><div className="spell-runes"/><span className="spell-hero"><span className="hero-art-window"><img src={playerSpriteUrl(abilityNotice.role)} alt=""/></span></span><div><small>{abilityNotice.nickname} invoca</small><strong>{abilityInfo[abilityNotice.role].name}</strong><span>{roleInfo[abilityNotice.role].split(": ")[1]}</span></div><b className="spell-symbol">{abilityInfo[abilityNotice.role].icon}</b></div> : null;
  const itemEffect = itemNotice && <div className="item-effect" role="status"><img src={`/sprites/items/${itemInfo[itemNotice.item].sprite}.png`} alt=""/><span>{itemNotice.nickname} usó <b>{itemInfo[itemNotice.item].name}</b></span></div>;

  return <div className={`board adventure-board ${game.teamWard ? "ward-active" : ""}`}>
    {cast}{!event && !game.currentScene && itemEffect}
    <section className="panel enemy-card">
      {enemy ? <><div className={`enemy-art ${reveal?.damage ? "struck" : reveal ? "attacking" : ""} ${abilityNotice?.ability === "track" ? "marked" : ""}`} data-enemy={enemy.id} role="img" aria-label={enemy.name}><span className="enemy-sprite" style={{ backgroundImage: `url("/sprites/enemies/${enemy.id}.png")` }}/>{reveal && reveal.damage > 0 && <span className="damage-number">−{reveal.damage}</span>}</div><div className="enemy-info"><p className="eyebrow">ENEMIGO {game.enemiesDefeated + 1}</p><h2>{enemy.name}</h2>{enemy.trait && <span className="trait">{TRAIT_INFO[enemy.trait] ?? enemy.trait}</span>}<div className="hp-bar"><div className="hp-fill enemy" style={{ width: `${enemy.hp / enemy.maxHp * 100}%` }}/><span>{enemy.hp} / {enemy.maxHp} PV</span></div></div></> : <div className="enemy-info"><p className="eyebrow">UN RESPIRO EN EL CAMINO</p><h2>La aventura continúa</h2></div>}
      <div className="deck-progress"><strong>{game.questionsCompleted}<span>/{game.totalQuestions}</span></strong><small>preguntas resueltas</small><span className="accuracy">{me.correctAnswers}/{me.answersGiven} aciertos tuyos</span></div>
    </section>

    <section className="panel question-card">
      <div className="question-heading"><p className="eyebrow">DESAFÍO {Math.min(game.turnNumber, game.totalQuestions).toString().padStart(2, "0")}</p><span>{closed ? "Resultado del grupo" : preview ? "Lectura" : "Elegí tu respuesta"}</span></div>
      <div className={`timer ${preview ? "preview" : left < 5000 && !closed ? "urgent" : ""}`}><div className="timer-fill" style={{ width: `${closed ? 0 : Math.min(100, left / total * 100)}%` }}/><span>{closed ? "Ronda terminada" : preview ? `Opciones en ${Math.ceil(left / 1000)}s` : `${Math.ceil(left / 1000)}s`}</span></div>
      {game.current ? <><h1 className="prompt">{game.current.prompt}</h1>
        {preview ? <div className="preview-hint">◷ Leé con calma. Enseguida aparecen las opciones.</div> : <ul className="options">{shown.map((i, position) => {
          const isCorrect = Boolean(reveal && correctVisible && reveal.answer === i);
          const isWrong = Boolean(reveal && reveal.answer !== i);
          const selected = myPick === i;
          return <li key={i}><button className={`option ${selected && !reveal ? "selected" : ""} ${isCorrect ? "correct" : ""} ${isWrong ? "wrong" : ""}`} aria-pressed={selected} disabled={!canAct} onClick={() => onPick(i)}><span className="option-letter">{String.fromCharCode(65 + position)}</span><span>{game.current!.options[i]}</span><span className="option-state">{isCorrect ? "✓ Correcta" : isWrong ? selected ? "✕ Tu elección" : "✕" : selected ? "✓ Elegida" : ""}</span></button></li>;
        })}</ul>}
        {!closed && !preview && <p className="vote-status" role="status">{myPick !== null ? "Tu respuesta quedó guardada en azul." : me.eliminated ? "Estás caído. Podés usar la mochila y continuar con el grupo." : "Una elección por pregunta."} <span>{game.votesReceived}/{room.players.filter(p => p.online && !p.eliminated).length} votos · resolvemos al terminar el reloj</span></p>}
      </> : <div className="between-questions"><span>✦</span><h1>Un alto en la aventura</h1><p>Prepará tu equipo para el próximo desafío.</p></div>}
      {reveal && <div className="round-review" aria-live="polite">{correctVisible ? <><div className="review-summary"><strong>{myPick === reveal.answer ? "¡Acertaste!" : myPick === null ? "No llegaste a responder" : "Esta vez no salió"}</strong><span>{reveal.correctVotes} aciertos · {reveal.wrongVotes} fallos · {reveal.damage} de daño al enemigo</span></div>{reveal.explanation && <p className="explanation">{reveal.explanation}</p>}{reveal.wardBlocked && <p>El escudo protegió al equipo.</p>}<ReadyButton room={room} meId={meId} onContinue={onContinue} disabled={now < game.revealedAt + GAME_CONFIG.answerRevealMs}/></> : <p>Revisando las respuestas…</p>}</div>}
      {error && !event && !game.currentScene && <p role="status" className="message">{error}</p>}
    </section>

    <aside className="panel crew-card"><p className="eyebrow">TU COMPAÑÍA · {room.players.length}</p><ul className="crew">{room.players.map(p => <li key={p.id} className={`${!p.online ? "offline" : ""} ${p.eliminated ? "down" : ""} ${p.id === meId ? "self" : ""} ${abilityNotice?.playerId === p.id ? "casting" : ""}`}><div className="avatar character-sprite"><span className="hero-art-window"><img src={playerSpriteUrl(p.role)} alt={p.role ?? "Aventurero"}/></span>{p.eliminated && <img className="death-marker" src="/sprites/tombstone.svg" alt="Caído"/>}</div><div className="crew-name"><strong>{p.nickname}{p.id === meId ? " · vos" : ""}</strong><small>{p.online ? p.role : "Sin conexión"}</small><span className="hearts" aria-label={`${p.hp} de ${p.maxHp} vidas`}>{"♥".repeat(p.hp)}<span>{"♡".repeat(p.maxHp - p.hp)}</span></span></div><span className="crew-ready">{game.continueReady.includes(p.id) ? "✓" : ""}</span>{(game.usedAbilities[p.id] ?? []).filter(a => ["strike", "evade", "track"].includes(a)).map(a => <span key={a} className="crew-effect">{effectLabel[a]}</span>)}</li>)}</ul><p className="party-stat">Equipo: {game.correctAnswers}/{game.answersGiven} respuestas acertadas</p></aside>

    <section className="panel action-dock"><div className="ability-panel"><div><p className="eyebrow">{me.role ?? "AVENTURERO"}</p><h3>Tu habilidad</h3></div>{myAbility && <button className={`ability ${myActiveEffects.includes(myAbility.ability) ? "armed" : ""}`} disabled={!abilityReady || (myAbility.ability === "discard" && shown.length <= 2) || (["strike", "evade", "track"].includes(myAbility.ability) && myActiveEffects.includes(myAbility.ability))} onClick={() => onAbility(myAbility.ability)} title={me.role ? roleInfo[me.role] : ""}><span className="ability-icon">{myAbility.icon}</span><span><strong>{myAbility.name}</strong><small>{abilityCooldown > 0 ? `Recarga: ${abilityCooldown} preguntas` : myActiveEffects.includes(myAbility.ability) ? "Efecto preparado" : "Activar poder"}</small></span></button>}<p className="ability-description">{me.role && roleInfo[me.role].split(": ")[1]}</p>{game.teamWard && <span className="team-effect">⬟ Escudo grupal activo</span>}{game.bonusDamage > 0 && <span className="team-effect">✦ Próximo impacto +{game.bonusDamage}</span>}</div>{!event && !game.currentScene && inventory}</section>

    {game.currentScene && <Popup title={game.currentScene.title}><SceneBoard room={room} meId={meId} onContinue={onSceneContinue} error={error}/>{inventory}{itemEffect}</Popup>}
    {event && <Popup title={event === "shop" ? "Tienda del camino" : "Encuentro de la mazmorra"}><div className={`encounter-banner encounter-${event}`} aria-hidden="true">{event === "shop" ? "⚒" : event === "campfire" ? "♨" : event === "treasure" ? "◆" : "✧"}</div><p className="eyebrow">ENCUENTRO · EL RELOJ ESTÁ PAUSADO</p><h2>{event === "shop" ? !room.players.some(p => !p.eliminated) ? "Una última oportunidad" : "El mercader del camino" : event === "campfire" ? "La fogata de los viajeros" : event === "treasure" ? "El cofre olvidado" : "El santuario de las runas"}</h2><p className="event-description">{event === "shop" ? !room.players.some(p => !p.eliminated) ? "El equipo cayó. Comprá un vial y usalo desde la mochila para revivir a alguien. Este rescate se ofrece una sola vez." : "Comprá provisiones y guardalas para cuando las necesites. Cada acierto personal entrega una moneda." : event === "campfire" ? "Sentate junto al fuego. Elegí recuperar un corazón o preparar tu habilidad." : event === "treasure" ? "Cada aventurero puede elegir: cuatro monedas o una bomba arcana." : "Las runas despiertan. Elegí un sello protector o recargá tu habilidad."}</p>
      {event === "shop" ? <div className="shop-items">{(Object.keys(itemInfo) as ShopItem[]).map(item => <article key={item}><img src={`/sprites/items/${itemInfo[item].sprite}.png`} alt=""/><div><strong>{itemInfo[item].name}</strong><small>{itemInfo[item].description}</small></div><button disabled={me.coins < prices[item]} onClick={() => onBuy(item)} aria-label={`Comprar ${itemInfo[item].name} por ${prices[item]} monedas`}>{prices[item]} ◈</button></article>)}</div> : <div className="event-choices"><button className="secondary" disabled={claimed} onClick={() => onClaim(event === "campfire" ? "heal" : event === "treasure" ? "coins" : "item")}>{event === "campfire" ? "♥ Recuperar 1 corazón" : event === "treasure" ? "◈ Tomar 4 monedas" : "⬟ Guardar sello protector"}</button><button className="secondary" disabled={claimed} onClick={() => onClaim(event === "treasure" ? "item" : "focus")}>{event === "treasure" ? "✦ Guardar bomba arcana" : "✧ Recargar habilidad"}</button>{claimed && <p role="status">✓ Recompensa recibida</p>}</div>}
      {inventory}{error && <p role="status" className="message">{error}</p>}<ReadyButton room={room} meId={meId} onContinue={onContinue} disabled={!room.players.some(p => !p.eliminated)}/>{itemEffect}
    </Popup>}
  </div>;
}

function ResultsScreen({ room, meId, onAgain, canRestart, onHome }: { room: RoomState; meId: string; onAgain: () => void; canRestart: boolean; onHome: () => void }) {
  const game = room.game!;
  const me = room.players.find(p => p.id === meId)!;
  const won = game.outcome === "won";
  const seconds = Math.max(0, Math.round(((game.finishedAt ?? game.startedAt) - game.startedAt) / 1000));
  const accuracy = game.answersGiven ? Math.round(game.correctAnswers / game.answersGiven * 100) : 0;
  return <section className={`results-screen ${won ? "won" : "lost"}`}>
    <p className="eyebrow">CRÓNICA DE LA EXPEDICIÓN · {room.deck?.title}</p><div className="victory-stage"><div className="pixel-gate"/>{room.players.map(p => <div key={p.id} className={`victory-hero ${p.eliminated ? "down" : ""}`}><span className="hero-art-window"><img src={playerSpriteUrl(p.role)} alt={p.role ?? "Aventurero"}/></span><span>{p.nickname}</span></div>)}</div>
    <p className="result-ribbon">{won ? "MAZMORRA COMPLETADA" : game.outcome === "abandoned" ? "EXPEDICIÓN INTERRUMPIDA" : "FIN DE LA EXPEDICIÓN"}</p><h1>{won ? "¡La compañía hizo historia!" : "Todavía quedan aventuras"}</h1><p className="result-description">{won ? "Llegaron al final del recorrido. Cada respuesta deja algo para la próxima aventura." : "Reagrúpense, repasen lo aprendido y vuelvan a intentarlo."}</p>
    <ul className="result-stats"><li><strong>{game.questionsCompleted}/{game.totalQuestions}</strong><span>preguntas resueltas</span></li><li><strong>{accuracy}%</strong><span>aciertos del equipo</span></li><li><strong>{game.enemiesDefeated}</strong><span>enemigos vencidos</span></li><li><strong>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</strong><span>tiempo de aventura</span></li></ul><div className="personal-result">Tu registro, {me.nickname}: <strong>{me.correctAnswers}/{me.answersGiven} aciertos</strong></div><div className="result-actions">{canRestart ? <button className="primary" onClick={onAgain}>Preparar otra aventura</button> : <p>Esperando a que el creador prepare otra aventura…</p>}<button className="secondary" onClick={onHome}>Volver al inicio</button></div>
  </section>;
}
