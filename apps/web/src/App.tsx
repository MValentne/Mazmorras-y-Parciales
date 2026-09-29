import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { io, type Socket } from "socket.io-client";
import {
  GAME_CONFIG,
  getShopPrices,
  ABILITY_COOLDOWNS,
  type Ability,
  type ClientEvents,
  type DeckScene,
  type Reveal,
  type Role,
  type RoomState,
  type ServerEvents,
} from "@dungeon/shared";
import { parseDeckFile } from "./deck";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || window.location.origin;
const getPlayerId = () => {
  let id = localStorage.getItem("dungeon-player-id");
  if (!id) { id = crypto.randomUUID(); localStorage.setItem("dungeon-player-id", id); }
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
  blindado: "Blindado · ignora el daño doble",
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
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [myPick, setMyPick] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [deckBusy, setDeckBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [leavingRoom, setLeavingRoom] = useState(false);
  const [abilityNotice, setAbilityNotice] = useState<{ playerId: string; nickname: string; role: Role; ability: Ability } | null>(null);
  const [shopNotice, setShopNotice] = useState<{ coinsAwarded: number; enemiesDefeated: number } | null>(null);
  const playerId = useMemo(getPlayerId, []);

  useEffect(() => {
    const role = room?.players.find(player => player.id === playerId)?.role ?? null;
    setPendingRole(role);
  }, [room?.code, room?.players, playerId]);

  useEffect(() => {
    const client: Socket<ServerEvents, ClientEvents> = io(SERVER_URL, { autoConnect: false, reconnection: true });
    setSocket(client);
    client.on("room:state", setRoom);
    client.on("room:error", (e: { message: string }) => { setError(e.message); setJoining(false); });
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
    client.on("game:reveal", (r: Reveal) => {
      setReveal(r);
      window.setTimeout(() => {
        setReveal(null);
        setMyPick(null);
      }, GAME_CONFIG.answerRevealMs);
    });
    client.on("game:ability", setAbilityNotice);
    client.on("game:shop", setShopNotice);
    client.on("connect", () => {
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
    const timeout = window.setTimeout(() => setAbilityNotice(null), 3200);
    return () => window.clearTimeout(timeout);
  }, [abilityNotice]);

  useEffect(() => {
    if (room?.code) sessionStorage.setItem("dungeon-room-code", room.code);
    else sessionStorage.removeItem("dungeon-room-code");
    if (room) QRCode.toDataURL(`${window.location.origin}/sala/${room.code}`, { width: 180, margin: 1, color: { dark: "#e8d6a8", light: "#211e18" } }).then(setQr).catch(() => setQr(""));
  }, [room]);

  // Sólo hace falta el tick del reloj mientras hay una pregunta en el aire.
  useEffect(() => {
    if (room?.status !== "playing") return;
    const tick = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(tick);
  }, [room?.status]);

  // La carta en juego cambia recién cuando se reparte la siguiente: es el momento
  // limpio de forgets de la ronda anterior.
  useEffect(() => {
    setMyPick(null);
    setReveal(null);
  }, [room?.game?.current?.id]);

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
      <GameBoard room={room} meId={playerId} reveal={reveal} myPick={myPick} now={now} abilityNotice={abilityNotice} shopNotice={shopNotice} onPick={i => { setMyPick(i); socket?.emit("game:answer", { answer: i }); }} onAbility={a => socket?.emit("game:ability", { ability: a })} onBuy={(item, targetId) => socket?.emit("game:shop:buy", { item, targetId })} onShopContinue={() => socket?.emit("game:shop:continue")} onSceneContinue={() => socket?.emit("game:scene:continue")} error={error}/>
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

function GameBoard({ room, meId, reveal, myPick, now, abilityNotice, shopNotice, onPick, onAbility, onBuy, onShopContinue, onSceneContinue, error }: {
  room: RoomState; meId: string; reveal: Reveal | null; myPick: number | null; now: number;
  abilityNotice: { playerId: string; nickname: string; role: Role; ability: Ability } | null;
  shopNotice: { coinsAwarded: number; enemiesDefeated: number } | null;
  onPick: (i: number) => void; onAbility: (a: Ability) => void; onSceneContinue: () => void; error: string;
  onBuy: (item: Parameters<ClientEvents["game:shop:buy"]>[0]["item"], targetId?: string) => void; onShopContinue: () => void;
}) {
  const game = room.game!;
  const me = room.players.find(p => p.id === meId);
  if (game.currentScene) return <SceneBoard room={room} meId={meId} onContinue={onSceneContinue} error={error}/>;
  const creator = Boolean(me?.isCreator);
  const enemy = game.enemy;
  const closed = game.deadline === 0;
  const preview = !closed && now < game.answerStartsAt;
  const total = preview ? GAME_CONFIG.promptPreviewSeconds * 1000 : Math.max(1, game.deadline - game.answerStartsAt);
  const left = Math.max(0, preview ? game.answerStartsAt - now : game.deadline - now);
  const shown = game.visibleOptions ?? game.current?.options.map((_, i) => i) ?? [];
  const canAct = !me?.eliminated && !closed && !preview && myPick === null;
  const myAbility = me?.role ? abilityInfo[me.role] : null;
  const myActiveEffects = game.usedAbilities[meId] ?? [];
  const abilityCooldown = me ? Math.max(0, (game.abilityReadyAt[me.id] ?? 0) - game.turnNumber - 1) : 0;
  const abilityNeedsMoreOptions = myAbility?.ability === "discard";
  const abilityReady = canAct && abilityCooldown === 0 && (!abilityNeedsMoreOptions || shown.length > 2);
  const shopPrices = getShopPrices(room.players.length);

  return <div className="board">
    {abilityNotice && <div key={`${abilityNotice.playerId}-${abilityNotice.ability}-${game.turnNumber}`} className="ability-announcement" role="status"><span>{abilityInfo[abilityNotice.role].icon}</span><div><strong>{abilityNotice.nickname}</strong> activó <b>{abilityInfo[abilityNotice.role].name}</b></div></div>}
    {game.shopOpen && <section className="panel shop-panel" aria-label="Tienda de la mazmorra">
      <header><div><p className="eyebrow">{game.enemiesDefeated ? `DESCANSO · ${game.enemiesDefeated} ENEMIGOS` : "ÚLTIMA OPORTUNIDAD"}</p><h2>{!room.players.some(p => !p.eliminated) ? "Reúnan al equipo" : "Tienda del camino"}</h2><p>{shopNotice?.coinsAwarded === 0 ? "El grupo cayó. Comprá una poción para seguir." : shopNotice ? `A cada aventurero le tocaron ${shopNotice.coinsAwarded} monedas por el último enemigo.` : "Cada enemigo deja entre 1 y 3 monedas para cada aventurero."}</p></div><span className="shop-wallet"><img src="/sprites/items/coin.png" alt=""/> {me?.coins ?? 0}</span></header>
      <div className="shop-items">
        <article><img src="/sprites/items/life-potion.png" alt=""/><div><strong>Poción de vida</strong><small>Recuperás hasta 2 corazones · {shopPrices.healing} monedas</small></div><button disabled={!me || me.eliminated || me.hp >= me.maxHp || (me.coins ?? 0) < shopPrices.healing} onClick={() => onBuy("healing")}>Comprar</button></article>
        <article><img src="/sprites/items/resurrection.png" alt=""/><div><strong>Vial de resurrección</strong><small>Devuelve a alguien con 1 corazón · {shopPrices.revive} monedas</small></div><div className="shop-actions">{room.players.filter(p => p.eliminated).length ? room.players.filter(p => p.eliminated).map(p => <button key={p.id} disabled={(me?.coins ?? 0) < shopPrices.revive} onClick={() => onBuy("revive", p.id)}>Revivir a {p.nickname}</button>) : <button disabled>Sin caídos</button>}</div></article>
        <article><img src="/sprites/items/medipack.png" alt=""/><div><strong>Botiquín grupal</strong><small>Cura 1 corazón al equipo · {shopPrices.partyHeal} monedas</small></div><button disabled={!me || !room.players.some(p => !p.eliminated && p.hp < p.maxHp) || (me.coins ?? 0) < shopPrices.partyHeal} onClick={() => onBuy("partyHeal")}>Comprar</button></article>
        <article><img src="/sprites/items/ward.png" alt=""/><div><strong>Sello protector</strong><small>Bloquea el próximo fallo · {shopPrices.ward} monedas</small></div><button disabled={!me || game.teamWard || (me.coins ?? 0) < shopPrices.ward} onClick={() => onBuy("ward")}>Comprar</button></article>
        <article><img src="/sprites/items/bomb.png" alt=""/><div><strong>Bomba de humo</strong><small>El próximo acierto hace +2 de daño · {shopPrices.bomb} monedas</small></div><button disabled={!me || game.bonusDamage > 0 || (me.coins ?? 0) < shopPrices.bomb} onClick={() => onBuy("bomb")}>Comprar</button></article>
        <article><img src="/sprites/items/focus.png" alt=""/><div><strong>Pergamino de enfoque</strong><small>Recarga las habilidades del grupo · {shopPrices.focus} monedas</small></div><button disabled={!me || (me.coins ?? 0) < shopPrices.focus} onClick={() => onBuy("focus")}>Comprar</button></article>
        <article><img src="/sprites/items/resurrection.png" alt=""/><div><strong>Alma fénix</strong><small>Resucita a todo el equipo caído · {shopPrices.phoenix} monedas</small></div><button disabled={!me || !room.players.some(p => p.eliminated) || (me.coins ?? 0) < shopPrices.phoenix} onClick={() => onBuy("phoenix")}>Comprar</button></article>
      </div>
      <button className="shop-continue" disabled={!creator || !room.players.some(p => !p.eliminated)} onClick={onShopContinue}>{!room.players.some(p => !p.eliminated) ? "Resucitá a alguien para continuar" : creator ? "Seguir la aventura" : "Esperando al creador"}</button>
    </section>}
    <section className="panel enemy-card">
      {enemy && <>
        <div className={`enemy-art ${reveal?.correct ? "struck" : reveal && !reveal.timeUp ? "attacking" : ""}`} data-enemy={enemy.id} role="img" aria-label={enemy.name}>
          <span className="enemy-sprite" style={{ backgroundImage: `url("/sprites/enemies/${enemy.id}.png")` }} aria-hidden="true" />
          {reveal?.correct && <span className="impact effect-hit" aria-hidden="true">✦</span>}
          {reveal && !reveal.correct && !reveal.timeUp && <span className="impact effect-miss" aria-hidden="true">✧</span>}
        </div>
        <div className="enemy-info"><p className="eyebrow">ENEMIGO {game.enemiesDefeated + 1}</p><h2>{enemy.name}</h2>
          {enemy.trait && <span className="trait">{TRAIT_INFO[enemy.trait] ?? enemy.trait}</span>}
          <div className="hp-bar"><div className="hp-fill enemy" style={{ width: `${(enemy.hp / enemy.maxHp) * 100}%` }}/><span>{enemy.hp} / {enemy.maxHp}</span></div>
        </div>
      </>}
      <div className="deck-progress"><span className="mastered">{game.mastered}</span><small>de {game.pending} dominadas</small></div>
    </section>

    <section className="panel question-card">
      <div className={`timer ${preview ? "preview" : left < 5000 && !closed ? "urgent" : ""}`}><div className="timer-fill" style={{ width: `${closed ? 0 : Math.min(100, (left / total) * 100)}%` }}/><span>{closed ? "—" : preview ? `Opciones en ${Math.ceil(left / 1000)}s` : `${Math.ceil(left / 1000)}s`}</span></div>
      {game.current ? <>
        <p className="prompt">{game.current.prompt}</p>
        {preview
          ? <div className="preview-hint"><span aria-hidden="true">◷</span> Leé la pregunta. Las opciones aparecen en {Math.ceil(left / 1000)} segundos.</div>
        : <ul className="options">{shown.map(i => {
          const isCorrect = reveal?.answer === i;
          const isMyWrong = reveal && myPick === i && !reveal.correct;
          const isSelected = myPick === i && !reveal;
          return <li key={i}>
            <button className={`option ${isSelected ? "selected" : ""} ${isCorrect ? "correct" : ""} ${isMyWrong ? "wrong" : ""} ${myPick === i && reveal?.correct ? "hit" : ""}`} aria-pressed={isSelected} disabled={closed || !canAct} onClick={() => onPick(i)}>
              {game.current!.options[i]}
              {isSelected && <span className="option-selected-mark" aria-hidden="true">✓ <span>SELECCIONADA</span></span>}
            </button>
          </li>;
        })}</ul>}
        {!closed && !preview && myPick !== null && <p className="vote-status" role="status"><span aria-hidden="true">✓</span><span><strong>Respuesta seleccionada</strong><small>Tu elección quedó registrada · {game.votesReceived} de {room.players.filter(player => player.online && !player.eliminated).length} votaron.</small></span></p>}
      </> : <p className="prompt waiting-prompt">Preparando la siguiente pregunta…</p>}
      {reveal && <div className={`reveal ${reveal.correct ? "good" : reveal.timeUp ? "timeup" : "bad"}`}>
        <strong>{reveal.timeUp ? "Se acabó el tiempo" : reveal.correct ? "Ronda resuelta" : "Fallaron"}</strong>
        {reveal.answer !== null && <span>Correcta: {game.current?.options[reveal.answer]}</span>}
        {reveal.correct && reveal.damage > 0 && <span>−{reveal.damage} de vida al enemigo</span>}
        {reveal.timeUp && <span>{reveal.wardBlocked ? "El Muro Sagrado bloqueó el daño para todo el grupo." : reveal.damage === 0 ? "Ya habías recibido daño por esta pregunta." : "Se agotó el tiempo: quienes aún no habían fallado perdieron 1 vida."}</span>}
        {reveal.healedPlayer && <span>{reveal.healedPlayer} recuperó {reveal.healedAmount} de vida</span>}
        {!reveal.correct && !reveal.timeUp && reveal.damage === 0 && <span>Una protección anuló el daño.</span>}
        {reveal.explanation && <p>{reveal.explanation}</p>}
      </div>}
      {error && <p role="status" className="message">{error}</p>}
    </section>

    <section className="panel crew-card">
      <p className="eyebrow">EL GRUPO</p>
      <ul className="crew">{room.players.map(p => <li key={p.id} className={`${!p.online ? "offline" : ""} ${p.eliminated ? "down" : ""}`}>
        <div className={`avatar character-sprite role-${roleSpriteId(p.role)}`} aria-label={p.role ?? "Aventurero"}>
          <span className="hero-art-window"><img src={playerSpriteUrl(p.role)} alt=""/></span>
          {reveal?.healedPlayer === p.nickname && <i className="effect-heal" aria-hidden="true">＋</i>}
          {reveal && !reveal.correct && <i className="effect-damage" aria-hidden="true">✦</i>}
          {p.eliminated && <img className="death-marker" src="/sprites/tombstone.svg" alt="Caído"/>}
        </div>
        <div className="crew-name"><strong>{p.nickname}</strong><small>{p.role ?? "sin rol"}</small><small className="crew-coins"><img src="/sprites/items/coin.png" alt=""/>{p.coins ?? 0}</small></div>
        <div className="vitality" role="img" aria-label={`Vida de ${p.nickname}: ${p.hp} de ${p.maxHp}`}>
          <span className="hearts">{Array.from({ length: p.maxHp }, (_, i) => <i key={i} className={i < p.hp ? "heart full" : "heart empty"} aria-hidden="true">{i < p.hp ? "♥" : "♡"}</i>)}</span>
        </div>
        {(game.usedAbilities[p.id] ?? []).filter(ability => effectLabel[ability]).map(ability => <span key={ability} className="crew-effect">{effectLabel[ability]}</span>)}
      </li>)}</ul>
      <div className="abilities">
        {myAbility && <button className={`ability ${myActiveEffects.includes(myAbility.ability) || (myAbility.ability === "ward" && game.teamWard) ? "armed" : ""}`} disabled={!abilityReady} onClick={() => onAbility(myAbility.ability)}>
          {myAbility.icon} {myAbility.name}{abilityCooldown > 0 ? ` · ${abilityCooldown} preguntas` : abilityNeedsMoreOptions && shown.length <= 2 ? " · necesita 3 opciones" : " · LISTO"}
        </button>}
        {game.teamWard && <span className="team-effect">⬟ Muro Sagrado protege al grupo</span>}
        {me?.eliminated && <span className="ability-note down">Pueden resucitarte en la tienda</span>}
      </div>
    </section>
  </div>;
}

function ResultsScreen({ room, meId, onAgain, canRestart, onHome }: { room: RoomState; meId: string; onAgain: () => void; canRestart: boolean; onHome: () => void }) {
  const game = room.game;
  const me = room.players.find(p => p.id === meId);
  const won = game?.outcome === "won";
  const minutes = game?.finishedAt && game.startedAt ? Math.max(1, Math.round((game.finishedAt - game.startedAt) / 60000)) : 0;
  return <div className="board">
    <section className={`panel results ${won ? "won" : "lost"}`}>
      <div className="result-sigil">{won ? "✦" : "☠"}</div>
      <h1>{won ? "¡Mazmorra conquistada!" : game?.outcome === "abandoned" ? "Partida abandonada" : "El grupo cayó"}</h1>
      <p className="intro">{won ? "Dominaron todas las cartas del mazo." : "Se quedaron sin vida. La misma mazmorra los espera."}</p>
      <ul className="stats">
        <li><strong>{game?.mastered ?? 0}</strong><span>cartas dominadas</span></li>
        <li><strong>{game?.enemiesDefeated ?? 0}</strong><span>enemigos derrotados</span></li>
        <li><strong>{minutes}′</strong><span>de duración</span></li>
        <li><strong>{room.players.filter(p => !p.eliminated).length}/{room.players.length}</strong><span>en pie</span></li>
      </ul>
      <div className="result-actions">
        {canRestart
          ? <button className="primary full" onClick={onAgain}>Volver al lobby</button>
          : <p className="small-note center">{me?.isCreator ? "" : "Esperando a que el creador rearme la sala…"}</p>}
        <button className="secondary full" onClick={onHome}>Salir de la sala</button>
      </div>
    </section>
  </div>;
}
