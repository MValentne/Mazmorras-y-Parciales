import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { io, type Socket } from "socket.io-client";
import {
  GAME_CONFIG,
  type Ability,
  type ClientEvents,
  type Reveal,
  type Role,
  type RoomState,
  type ServerEvents,
} from "@dungeon/shared";
import { CSV_EXAMPLE, JSON_EXAMPLE, parseDeckFile } from "./deck";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || window.location.origin;
const getPlayerId = () => {
  let id = localStorage.getItem("dungeon-player-id");
  if (!id) { id = crypto.randomUUID(); localStorage.setItem("dungeon-player-id", id); }
  return id;
};
const roleInfo: Record<Role, string> = {
  Guerrero: "Más vida y daño extra al acertar.", Mago: "Puede descartar opciones incorrectas.",
  "Clérigo": "Cura al compañero más herido al acertar.", Ladrón: "Puede evitar el daño de un fallo.", Bardo: "Al acertar, da más tiempo al grupo.",
};
const roleIcon: Record<Role, string> = { Guerrero: "⚔", Mago: "✧", "Clérigo": "✚", Ladrón: "◈", Bardo: "♫" };
const ENEMY_ART: Record<string, string> = { lodo: "≈", esqueleto: "☠", espectro: "◉", golem: "▣" };
const TRAIT_INFO: Record<string, string> = {
  mudo: "Mudo · muestra menos opciones",
  blindado: "Blindado · ignora el daño doble",
};

export default function App() {
  const initialCode = useMemo(() => window.location.pathname.match(/^\/sala\/([^/]+)\/?$/i)?.[1]?.toUpperCase() ?? "", []);
  const [socket, setSocket] = useState<Socket<ServerEvents, ClientEvents> | null>(null);
  const [room, setRoom] = useState<RoomState | null>(null);
  const [nickname, setNickname] = useState(localStorage.getItem("dungeon-nickname") ?? "");
  const [code, setCode] = useState(initialCode);
  const [error, setError] = useState("");
  const [joining, setJoining] = useState(false);
  const [qr, setQr] = useState("");
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [myPick, setMyPick] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [deckBusy, setDeckBusy] = useState(false);
  const playerId = useMemo(getPlayerId, []);

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
    client.on("room:closed", (e: { message: string }) => { setError(e.message); setRoom(null); });
    client.on("game:reveal", (r: Reveal) => {
      setReveal(r);
      window.setTimeout(() => {
        setReveal(null);
        setMyPick(null);
      }, GAME_CONFIG.answerRevealMs);
    });
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
  const chooseRole = (role: Role) => socket?.emit("player:role", { role });
  const copyInvite = async () => {
    try { await navigator.clipboard.writeText(`${location.origin}/sala/${room?.code}`); setError("Enlace copiado."); }
    catch { setError("No se pudo copiar automáticamente. Copiá el enlace de la barra del navegador."); }
  };
  const backHome = () => { setRoom(null); setCode(""); setError(""); sessionStorage.removeItem("dungeon-room-code"); history.pushState({}, "", "/"); };

  const uploadDeck = async (file: File) => {
    setError("");
    setDeckBusy(true);
    const result = await parseDeckFile(file);
    setDeckBusy(false);
    if (result.error) { setError(result.error); return; }
    socket?.emit("deck:upload", { title: result.title, cards: result.cards });
  };

  if (!room) return <main className="page home"><div className="sigil">✦</div><p className="eyebrow">UNA AVENTURA COOPERATIVA</p><h1>Dungeon <span>de Estudio</span></h1><p className="intro">Reúnan al grupo, afilen la memoria y conquisten la mazmorra.</p>
    <section className="panel entry"><label htmlFor="nickname">Tu apodo</label><input id="nickname" maxLength={GAME_CONFIG.nicknameMaxLength} value={nickname} onChange={e => setNickname(e.target.value)} placeholder="Ej.: NubeArcana" onKeyDown={e => e.key === "Enter" && (initialCode ? enter(false) : enter(true))}/>
      {initialCode ? <><p className="invite-tag">INVITACIÓN A LA SALA <strong>{initialCode}</strong></p><button className="primary full" disabled={joining} onClick={() => enter(false)}>{joining ? "Entrando…" : "Entrar a la sala"}</button></> : <><button className="primary full" disabled={joining} onClick={() => enter(true)}>{joining ? "Creando…" : "Crear una sala"}</button><div className="divider"><span>o unirse a una sala</span></div><div className="join-row"><input aria-label="Código de sala" value={code} onChange={e => setCode(e.target.value.toUpperCase().slice(0, GAME_CONFIG.roomCodeLength))} placeholder="CÓDIGO" maxLength={GAME_CONFIG.roomCodeLength} onKeyDown={e => e.key === "Enter" && enter(false)}/><button className="secondary" disabled={joining || !code} onClick={() => enter(false)}>Unirse</button></div></>}
      {error && <p role="status" className="message">{error}</p>}{(initialCode || error) && <button className="back-home" onClick={backHome}>Volver al inicio</button>}{!socket?.connected && <p className="connection">Conectando al servidor…</p>}
    </section>
  </main>;

  const me = room.players.find(p => p.id === playerId);
  const inviteUrl = `${location.origin}/sala/${room.code}`;

  if (room.status === "playing" && room.game) return (
    <main className="page game">
      <header className="top"><div className="brand">✦ <span>Dungeon de Estudio</span></div><span className="live"><i/> Sala {room.code}</span></header>
      <GameBoard room={room} meId={playerId} reveal={reveal} myPick={myPick} now={now} onPick={i => { setMyPick(i); socket?.emit("game:answer", { answer: i }); }} onAbility={a => socket?.emit("game:ability", { ability: a })} error={error}/>
    </main>
  );

  if (room.status === "results") return (
    <main className="page game">
      <header className="top"><div className="brand">✦ <span>Dungeon de Estudio</span></div><span className="live"><i/> Sala {room.code}</span></header>
      <ResultsScreen room={room} meId={playerId} onAgain={() => socket?.emit("game:lobby")} canRestart={me?.isCreator ?? false} onHome={backHome}/>
    </main>
  );

  const sinRol = room.players.filter(p => !p.role).length;
  const ready = Boolean(room.deck) && sinRol === 0;
  return <main className="page lobby"><header className="top"><div className="brand">✦ <span>Dungeon de Estudio</span></div><span className="live"><i/> Sala activa</span></header>
    <div className="lobby-grid"><section className="panel invite-card"><p className="eyebrow">LOBBY · COMPARTÍ LA INVITACIÓN</p><h1>La mazmorra<br/>se prepara</h1><div className="code-label">CÓDIGO DE SALA</div><div className="code">{room.code.split("").join(" ")}</div><button className="primary full" onClick={copyInvite}>Copiar enlace de invitación</button><p className="url">{inviteUrl}</p>{qr && <div className="qr-frame"><img src={qr} alt={`Código QR para entrar a la sala ${room.code}`}/><span>Escaneá para entrar</span></div>}<p className="small-note">Cualquiera con el enlace puede unirse mientras la sala esté abierta.</p></section>
      <section className="panel party-card"><div className="section-heading"><div><p className="eyebrow">EL GRUPO</p><h2>Jugadores <span className="count">{room.players.length}/{GAME_CONFIG.maxPlayers}</span></h2></div><span className="creator-note">{me?.isCreator ? "Sos el creador" : "Lobby de la partida"}</span></div>
        <ul className="players">{room.players.map(p => <li key={p.id} className={!p.online ? "offline" : ""}><div className="avatar">{p.nickname.slice(0, 1).toUpperCase()}</div><div className="player-name">{p.nickname}{p.isCreator && <span className="host-badge">CREADOR</span>}<small>{p.online ? "En la sala" : "Reconectando…"}</small></div><span className={`role-pill ${p.role ? "selected" : ""}`}>{p.role ?? "Eligiendo rol"}</span></li>)}</ul>
        <div className="role-select"><p className="eyebrow">ELEGÍ TU ROL</p><div className="roles">{GAME_CONFIG.roles.map(role => <button key={role} className={`role-card ${me?.role === role ? "active" : ""}`} onClick={() => chooseRole(role)} aria-pressed={me?.role === role}><span className="role-icon">{roleIcon[role]}</span><strong>{role}</strong><small>{roleInfo[role]}</small></button>)}</div></div>
        <DeckLoader room={room} busy={deckBusy} disabled={!me?.isCreator} onFile={uploadDeck}/>
        {error && <p role="status" className="message">{error}</p>}
        {me?.isCreator
          ? <><button className="primary full start" disabled={!ready || deckBusy} onClick={() => socket?.emit("game:start")}>{room.deck ? "Comenzar la mazmorra" : "Cargá un mazo para empezar"}</button>{room.deck && sinRol > 0 && <p className="small-note center">Falta elegir rol: {room.players.filter(p => !p.role).map(p => p.nickname).join(", ")}.</p>}</>
          : <div className="waiting"><span className="spinner"/> Esperando a que el creador empiece…</div>}
      </section></div>
  </main>;
}

function DeckLoader({ room, busy, disabled, onFile }: { room: RoomState; busy: boolean; disabled: boolean; onFile: (f: File) => void }) {
  const [showHelp, setShowHelp] = useState(false);
  return <div className="deck-loader">
    <p className="eyebrow">EL MAZO</p>
    {room.deck
      ? <div className="deck-loaded"><strong>{room.deck.title}</strong><span>{room.deck.size} {room.deck.size === 1 ? "pregunta" : "preguntas"} listas</span></div>
      : <p className="small-note">{disabled ? "El creador de la sala carga el mazo." : "Subí un archivo .json o .csv con las preguntas del grupo."}</p>}
    {disabled
      ? null
      : <label className={`file-button ${busy ? "busy" : ""}`}>
          <input type="file" accept=".json,.csv,.txt" disabled={busy} onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }}/>
          {busy ? "Leyendo…" : room.deck ? "Reemplazar mazo" : "Elegir archivo"}
        </label>}
    <button className="link-button" onClick={() => setShowHelp(v => !v)} aria-expanded={showHelp}>{showHelp ? "Ocultar formato" : "¿Qué formato tiene que tener?"}</button>
    {showHelp && <div className="format-help">
      <p><strong>CSV</strong> · columnas <code>pregunta,opciones,respuesta,explicacion</code>, con las opciones separadas por <code>|</code> y la respuesta como número de opción (0 es la primera).</p>
      <pre>{CSV_EXAMPLE}</pre>
      <p><strong>JSON</strong> · un objeto con <code>title</code> y <code>cards</code>.</p>
      <pre>{JSON_EXAMPLE}</pre>
    </div>}
  </div>;
}

function GameBoard({ room, meId, reveal, myPick, now, onPick, onAbility, error }: {
  room: RoomState; meId: string; reveal: Reveal | null; myPick: number | null; now: number;
  onPick: (i: number) => void; onAbility: (a: Ability) => void; error: string;
}) {
  const game = room.game!;
  const me = room.players.find(p => p.id === meId);
  const enemy = game.enemy;
  const total = room.settings.questionTimeSeconds * 1000;
  const left = Math.max(0, game.deadline - now);
  const closed = game.deadline === 0;
  const shown = game.visibleOptions ?? game.current?.options.map((_, i) => i) ?? [];
  const shield = game.usedAbilities[meId]?.includes("evade") ?? false;
  const canAct = !me?.eliminated && !closed;

  return <div className="board">
    <section className="panel enemy-card">
      {enemy && <>
        <div className="enemy-art" data-enemy={enemy.id}>{ENEMY_ART[enemy.id] ?? "◆"}</div>
        <div className="enemy-info"><p className="eyebrow">ENEMIGO {game.enemiesDefeated + 1}</p><h2>{enemy.name}</h2>
          {enemy.trait && <span className="trait">{TRAIT_INFO[enemy.trait] ?? enemy.trait}</span>}
          <div className="hp-bar"><div className="hp-fill enemy" style={{ width: `${(enemy.hp / enemy.maxHp) * 100}%` }}/><span>{enemy.hp} / {enemy.maxHp}</span></div>
        </div>
      </>}
      <div className="deck-progress"><span className="mastered">{game.mastered}</span><small>de {game.mastered + game.pending} dominadas</small></div>
    </section>

    <section className="panel question-card">
      <div className={`timer ${left < 5000 && !closed ? "urgent" : ""}`}><div className="timer-fill" style={{ width: `${closed ? 0 : Math.min(100, (left / total) * 100)}%` }}/><span>{closed ? "—" : `${Math.ceil(left / 1000)}s`}</span></div>
      {game.current ? <>
        <p className="prompt">{game.current.prompt}</p>
        <ul className="options">{shown.map(i => {
          const isCorrect = reveal?.answer === i;
          const isMyWrong = reveal && myPick === i && !reveal.correct;
          return <li key={i}>
            <button className={`option ${isCorrect ? "correct" : ""} ${isMyWrong ? "wrong" : ""} ${myPick === i && reveal?.correct ? "hit" : ""}`} disabled={closed || !canAct} onClick={() => onPick(i)}>
              <span className="opt-index">{String.fromCharCode(65 + i)}</span>{game.current!.options[i]}
            </button>
          </li>;
        })}</ul>
      </> : <p className="prompt waiting-prompt">Preparando la siguiente pregunta…</p>}
      {reveal && <div className={`reveal ${reveal.correct ? "good" : reveal.timeUp ? "timeup" : "bad"}`}>
        <strong>{reveal.correct ? "¡Dominada!" : reveal.timeUp ? "Se acabó el tiempo" : "Fallaste"}</strong>
        {reveal.answer !== null && <span>Correcta: {game.current?.options[reveal.answer]}</span>}
        {reveal.correct && reveal.damage > 0 && <span>−{reveal.damage} de vida al enemigo</span>}
        {reveal.healedPlayer && <span>{reveal.healedPlayer} recuperó {reveal.healedAmount} de vida</span>}
        {!reveal.correct && !reveal.timeUp && reveal.damage === 0 && <span>Tu escudo absorbió el golpe</span>}
        {reveal.explanation && <p>{reveal.explanation}</p>}
      </div>}
      {error && <p role="status" className="message">{error}</p>}
    </section>

    <section className="panel crew-card">
      <p className="eyebrow">EL GRUPO</p>
      <ul className="crew">{room.players.map(p => <li key={p.id} className={`${!p.online ? "offline" : ""} ${p.eliminated ? "down" : ""}`}>
        <div className="avatar">{p.nickname.slice(0, 1).toUpperCase()}</div>
        <div className="crew-name"><strong>{p.nickname}</strong><small>{p.role ?? "sin rol"}</small></div>
        <div className="pips">{Array.from({ length: p.maxHp }, (_, i) => <i key={i} className={i < p.hp ? "on" : ""}/>)}</div>
        {p.eliminated && <span className="down-tag">CAÍDO</span>}
      </li>)}</ul>
      <div className="abilities">
        {me?.role === "Mago" && <button className="ability" disabled={!canAct} onClick={() => onAbility("discard")}>✧ Recortar a 50/50</button>}
        {me?.role === "Ladrón" && <button className={`ability ${shield ? "armed" : ""}`} disabled={!canAct || shield} onClick={() => onAbility("evade")}>◈ {shield ? "Escudo listo" : "Escudo anti-fallo"}</button>}
        {me?.role === "Guerrero" && <span className="ability-note">⚔ Doble daño al acertar</span>}
        {me?.role === "Clérigo" && <span className="ability-note">✚ Cura al más herido al acertar</span>}
        {me?.role === "Bardo" && <span className="ability-note">♫ +{GAME_CONFIG.extraTimeSeconds}s al acertar</span>}
        {me?.eliminated && <span className="ability-note down">Caíste: quedás de espectadora</span>}
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
