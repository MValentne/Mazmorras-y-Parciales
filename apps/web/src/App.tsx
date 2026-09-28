import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { io, type Socket } from "socket.io-client";
import { GAME_CONFIG, type RoomState, type Role } from "@dungeon/shared";

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

export default function App() {
  const initialCode = useMemo(() => window.location.pathname.match(/^\/sala\/([^/]+)\/?$/i)?.[1]?.toUpperCase() ?? "", []);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [room, setRoom] = useState<RoomState | null>(null);
  const [nickname, setNickname] = useState(localStorage.getItem("dungeon-nickname") ?? "");
  const [code, setCode] = useState(initialCode);
  const [error, setError] = useState("");
  const [joining, setJoining] = useState(false);
  const [qr, setQr] = useState("");
  const playerId = useMemo(getPlayerId, []);

  useEffect(() => {
    const client = io(SERVER_URL, { autoConnect: false, reconnection: true });
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

  if (!room) return <main className="page home"><div className="sigil">✦</div><p className="eyebrow">UNA AVENTURA COOPERATIVA</p><h1>Dungeon <span>de Estudio</span></h1><p className="intro">Reúnan al grupo, afilen la memoria y conquisten la mazmorra.</p>
    <section className="panel entry"><label htmlFor="nickname">Tu apodo</label><input id="nickname" maxLength={GAME_CONFIG.nicknameMaxLength} value={nickname} onChange={e => setNickname(e.target.value)} placeholder="Ej.: NubeArcana" onKeyDown={e => e.key === "Enter" && (initialCode ? enter(false) : enter(true))}/>
      {initialCode ? <><p className="invite-tag">INVITACIÓN A LA SALA <strong>{initialCode}</strong></p><button className="primary full" disabled={joining} onClick={() => enter(false)}>{joining ? "Entrando…" : "Entrar a la sala"}</button></> : <><button className="primary full" disabled={joining} onClick={() => enter(true)}>{joining ? "Creando…" : "Crear una sala"}</button><div className="divider"><span>o unirse a una sala</span></div><div className="join-row"><input aria-label="Código de sala" value={code} onChange={e => setCode(e.target.value.toUpperCase().slice(0, GAME_CONFIG.roomCodeLength))} placeholder="CÓDIGO" maxLength={GAME_CONFIG.roomCodeLength} onKeyDown={e => e.key === "Enter" && enter(false)}/><button className="secondary" disabled={joining || !code} onClick={() => enter(false)}>Unirse</button></div></>}
      {error && <p role="status" className="message">{error}</p>}{(initialCode || error) && <button className="back-home" onClick={backHome}>Volver al inicio</button>}{!socket?.connected && <p className="connection">Conectando al servidor…</p>}
    </section>
  </main>;

  const me = room.players.find(p => p.id === playerId);
  const inviteUrl = `${location.origin}/sala/${room.code}`;
  return <main className="page lobby"><header className="top"><div className="brand">✦ <span>Dungeon de Estudio</span></div><span className="live"><i/> Sala activa</span></header>
    <div className="lobby-grid"><section className="panel invite-card"><p className="eyebrow">LOBBY · COMPARTÍ LA INVITACIÓN</p><h1>La mazmorra<br/>se prepara</h1><div className="code-label">CÓDIGO DE SALA</div><div className="code">{room.code.split("").join(" ")}</div><button className="primary full" onClick={copyInvite}>Copiar enlace de invitación</button><p className="url">{inviteUrl}</p>{qr && <div className="qr-frame"><img src={qr} alt={`Código QR para entrar a la sala ${room.code}`}/><span>Escaneá para entrar</span></div>}<p className="small-note">Cualquiera con el enlace puede unirse mientras la sala esté abierta.</p></section>
      <section className="panel party-card"><div className="section-heading"><div><p className="eyebrow">EL GRUPO</p><h2>Jugadores <span className="count">{room.players.length}/{GAME_CONFIG.maxPlayers}</span></h2></div><span className="creator-note">{me?.isCreator ? "Sos el creador" : "Lobby de la partida"}</span></div>
        <ul className="players">{room.players.map((p, i) => <li key={p.id} className={!p.online ? "offline" : ""}><div className="avatar">{p.nickname.slice(0, 1).toUpperCase()}</div><div className="player-name">{p.nickname}{p.isCreator && <span className="host-badge">CREADOR</span>}<small>{p.online ? "En la sala" : "Reconectando…"}</small></div><span className={`role-pill ${p.role ? "selected" : ""}`}>{p.role ?? "Eligiendo rol"}</span></li>)}</ul>
        <div className="role-select"><p className="eyebrow">ELEGÍ TU ROL</p><div className="roles">{GAME_CONFIG.roles.map(role => <button key={role} className={`role-card ${me?.role === role ? "active" : ""}`} onClick={() => chooseRole(role)} aria-pressed={me?.role === role}><span className="role-icon">{{Guerrero:"⚔",Mago:"✧","Clérigo":"✚",Ladrón:"◈",Bardo:"♫"}[role]}</span><strong>{role}</strong><small>{roleInfo[role]}</small></button>)}</div></div>
        <div className="waiting"><span className="spinner"/> Esperando al grupo…</div>{error && <p role="status" className="message">{error}</p>}</section></div>
  </main>;
}
