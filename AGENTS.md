# AGENTS.md

Monorepo npm (workspaces) de un solo proceso Node: `apps/server` maneja los
WebSockets **y** sirve el build de `apps/web`. Sin CI, sin linter, sin formateador.
El README tiene el detalle de despliegue; este archivo tiene lo que no se deduce
del README.

## La respuesta es un voto colectivo, no una respuesta

`handleAnswer` (`apps/server/src/game.ts:545`) **no cierra la ronda**: guarda el
índice en `room.votes` (un `Map<playerId, índice>`) y sólo llama a `resolveVotes`
(`game.ts:399`) cuando **todos** los jugadores vivos y online ya votaron
(`game.ts:561`). Recién ahí se calculan el daño, el Golpe demoledor y las cartas
dominadas, comparando cada voto contra `card.answer` (`game.ts:404-433`).
Después viaja el mismo `Reveal` de siempre.

Lo que se rompe al asumir lo contrario:

- **Un jugador solo no hace nada.** Si sólo vota `players[0]`, el enemigo no
  recibe daño y nadie pierde vida. Hay que hacer votar a todo el grupo, o dejar
  que corra el reloj.
- **El voto es de un solo uso por pregunta**: `room.votes.has(player.id)`
  descarta el segundo envío (`game.ts:558`). Un `for` que vota `playerMaxHp`
  veces sobre la misma carta cuenta una sola vez.
- `resolveVotes` es la única que dispara `settle()`, `closeQuestion()` y
  `scheduleAdvance()`. El `setTimeout` de `armDeadline` (`game.ts:252`) la llama
  igual con `timeUp = true` si falta el último voto: sin daño por acierto, pero
  el fallo grupal se aplica igual (quien no votó cuenta como fallo).
- Si alguien se desconecta con la pregunta abierta, `index.ts:305` dispara
  `reconcileVotes` (`game.ts:453`) para que la ronda no espere un voto imposible.

## La suite está en rojo en `main` — no la arregles sin que te lo pidan

Verificado sobre `main` limpio. **Antes de tocar nada, corré los tests y anotá la
línea base**: el conteo de abajo se desactualizó con `2eaa666` y `a77e6c3`.

| Comando | Estado en `main` |
| --- | --- |
| `npm test` | 39 tests, **11 fallan** (10 en `game.test.mjs`, 1 en `deck.test.mjs`) |
| `npm run test:e2e` | 20 checks, **1 falla** (y hay una segunda detrás) |
| `npm run build` | pasa limpio |

- Los **10 de `game.test.mjs` son el mismo bug**: responden sólo con
  `players[0]` y el engine ahora exige el voto de todos. "daño y mazo", "el
  Golem blindado", "fallar cuesta 1 de vida", "el Espectro mudo", "el escudo
  del Ladrón", "el timeout devuelve la carta", "cuando muere un enemigo",
  "quedarse sin vida", "perder cuando todo el equipo cae" y "si nadie responde".
  Arrancan a fallar apenas alguien nueva el voto colectivo, no antes.
- "si nadie responde…" y "perder cuando todo el equipo cae…" ** además fallan
  por la tienda de emergencia: cuando cae todo el equipo `settle()`
  (`game.ts:177`) no termina la partida, completa las monedas de todos, abre la
  tienda y deja `status === "playing"`. Con el equipo en 0 de vida queda
  `{ status: "playing", shopOpen: true }`.
- `deck.test.mjs` "avisa con un mensaje útil cuando el archivo no se puede leer":
  el regex espera `/lista de preguntas/i` y `deck.ts:78` hoy dice "El JSON tiene
  que incluir preguntas o una lista de escenas."
- `e2e.mjs` "Timeout esperando: aparecen las opciones": `until()` espera
  `100 × 50 ms = 5 s` y `GAME_CONFIG.promptPreviewSeconds` es `10` (`e2e.mjs:106`).
  **Arreglar ese timeout no alcanza**: la fase de derrota de abajo hace que
  vote un solo cliente y espera 400 ms a que baje su vida, así que en cuanto se
  pase el preview va a fallar en `e2e.mjs:121` por la misma razón que los tests
  unitarios. Hay que hacer votar a los dos.

## Comandos

| Comando | Qué hace | Ojo con |
| --- | --- | --- |
| `npm run dev` | Build de `@dungeon/shared` + `tsx watch` (`:3001`) + Vite (`:5173`) | Server y web van en procesos separados |
| `npm run build` | shared → server → web, en ese orden. **Es el único typecheck** | El build del web es `tsc --noEmit && vite build`; no hay script `typecheck` |
| `npm start` | Un solo proceso en `:3001` con API + frontend | Necesita `apps/web/dist`; si falta avisa y sirve sólo la API |
| `npm test` | 39 unitarios (~7 s). **Compila shared y server primero** | Corre contra `dist/`, no contra el fuente |
| `npm run test:e2e` | Chequeos por WebSocket contra el server real | **No compila nada.** Con `dist/` stale o falla |

Un solo test, sin recompilar (sólo si ya corriste `npm test` o `npm run build`):

```
node --test --test-name-pattern="timeout" apps/server/test/game.test.mjs
```

## El orden de build es obligatorio

`packages/shared/package.json` apunta `main` y `types` a `./dist/`. Por eso:

- Hay que compilar `shared` **antes** de server o web, siempre.
- **Los tests importan del build, no del fuente**: `game.test.mjs` importa
  `../dist/game.js`, `spec.test.mjs` importa `apps/server/dist/game.js` y
  `packages/shared/dist/index.js`. Si editás el fuente y no recompilás, el test
  pasa probando el código viejo.
- Editar `packages/shared/src` **no** reinicia nada en `npm run dev`: `tsx watch`
  sólo mira el fuente del server, y el server importa el `dist` compilado de
  shared. Hay que recompilar shared y reiniciar a mano.
- `apps/web/src/*.ts` no se puede importar directo desde los tests de Node (es TS
  sin emitir). `deck.test.mjs` y `spec.test.mjs` lo compilan con
  `node_modules/.bin/esbuild` a un temporal y lo importan desde ahí.

## Invariantes que no hay que romper

- **La respuesta correcta nunca viaja por el cable antes de que se vote.**
  `g.current` se arma eligiendo campos uno por uno en `dealCard`
  (`game.ts:388-389`); `room.drawn` es la carta real y `publicView`
  (`game.ts:146`) descarta `drawn`, `cards`, `timeline`, `remaining`, `timers`,
  `sockets` y `discardedFor`. Un `{ ...card }` en `current` filtra el `answer` a
  todos los clientes. Después de votar, `answer` y `explanation` viajan en
  `game:reveal`. Ojo: **`votes` y `wrongPlayers` NO están en la lista de
  descartados**; hoy no filtran nada porque son un `Map` y un `Set` (JSON los
  serializa como `{}`), pero si alguna vez guardás un objeto plano ahí, se
  publica. `g.votesReceived` sí es público a propósito y lo usa `App.tsx:350`.
- **El índice que se manda no es el índice que se ve.** `visibleOptions` es una
  lista *barajada de índices* sobre `options` (`visibleFor`, `game.ts:241`), y el
  cliente hace `shown.map(i => …)`, pinta `current.options[i]` y emite ese `i`
  (`App.tsx:294`, `App.tsx:339-345`, `App.tsx:299`). Mandar la posición en
  `shown` responde por la carta equivocada.
- `visibleOptions` puede ser **más corto** que `options`: el enemigo con rasgo
  `mudo` lo recorta a `mutedEnemyOptions` y el Mago lo deja en 2. `narrow()`
  (`game.ts:236`) garantiza que la correcta quede siempre entre las visibles.
- `handleAnswer` valida que el índice esté **en rango** (`game.ts:558`) pero **no
  que esté entre las opciones visibles**; el `e2e.mjs:108` depende de que el 7 se
  ignore. No asumas que el servidor ya filtró lo que el cliente no veía.
- **Hay una ventana de preview**: `armDeadline` arma `answerStartsAt` =
  `promptPreviewSeconds` antes del deadline y `handleAnswer` rechaza lo que llega
  antes con `QUESTION_PREVIEW`. El cliente ya bloquea el click en ese rango
  (`canAct`, `App.tsx:295`); el server es el que manda.
- **Un evento de socket vive en tres archivos**: los tipos en
  `packages/shared/src/index.ts` (`ClientEvents` / `ServerEvents`), el handler y
  los `emit` en `apps/server/src/index.ts`, y los `on`/`emit` del cliente en
  `apps/web/src/App.tsx`. Si tocás uno, tocás los tres.
- **El `playerId` se toma del payload sólo en los tres eventos de entrada**
  (`room:create`, `room:join`, `room:reconnect`) — es un UUID que el cliente
  genera y guarda en `localStorage`. Todo lo demás pasa por `roomOf(socket)`
  (`index.ts:176`), que lo lee de `socket.data` y además exige
  `room.sockets.get(id) === socket.id` para que un socket viejo no actúe sobre un
  jugador que ya se reconectó en otro lado.
- **El servidor es la autoridad.** El cliente valida el mazo sólo para feedback
  rápido; `validateDeck` (`game.ts:50`) es lo que decide. El parser
  `apps/web/src/deck.ts` traduce y no juzga: deja pasar cartas incompletas a
  propósito.
- **Las salas viven en un `Map` en memoria** (`index.ts:44`): una sola instancia.
  Reiniciar, o que Render reemplace la instancia, pierde las partidas activas (el
  cliente recibe `ROOM_NOT_FOUND` y vuelve al inicio). No se puede "arreglar" sin
  persistencia.
- El `id` de cada carta lo asigna el servidor en `validateDeck` (`c0`, `c1`…,
  `s0`, `s1`…); los mazos que manda el cliente no lo traen.
- Restos del diseño anterior a los votos, no los tomes como si sirvieran:
  `room.wrongPlayers` es un `Set` que sólo se limpia y nunca se lee
  (`game.ts:29`), y `onTimeout` (`game.ts:461`) no lo llama nadie.

## Tests

- `game.test.mjs` — el motor de juego. Su `before()` **muta el `GAME_CONFIG`
  compartido en runtime** (`answerRevealMs = 5`, `promptPreviewSeconds = 0`,
  `questionTimeSeconds = 0.08`): por eso la suite tarda segundos y no minutos.
  `as const` es sólo de compilación, el objeto exportado es mutable y el engine
  lo lee en vivo. Si agregás un test que mida tiempos reales, no contamines esos
  valores.
- El enemigo se sortea al azar **con rasgo incluido** y su HP escala con la
  cantidad de jugadores. Para medir una habilidad puntual, `started()` reintenta
  hasta 40 veces hasta que salga un enemigo `trait === null`; si tu aserción
  depende del daño, usá ese helper en vez de `startGame` pelado.
- Cada test registra su room en `openRooms` y `afterEach` corre `clearTimers`: sin
  eso los timeouts de tests anteriores siguen emitiendo y contaminan.
- `deck.test.mjs` — el parser de mazos del cliente. Usa los `CSV_EXAMPLE` /
  `JSON_EXAMPLE` de `deck.ts` como fixtures, así que editarlos rompe el test.
- `spec.test.mjs` — ata `FORMATO-MAZO.md` al código. **Si tocás `GAME_CONFIG` o
  las reglas de `validateDeck`, actualizá el documento o este test falla.** ojo:
  la red no cubre todo — no mira `maxScenes`, `mazeDepths` ni los campos de
  escena (`maxSceneBeatTextLength`, `sceneBeatCount`), así que esos cambios pasan
  el test igual.
- `e2e.mjs` + `run-e2e.sh` — sube el server, juega dos partidas y lo baja. Usa el
  puerto `3111` para no chocar con el de desarrollo, y **no compila nada**:
  corré `npm run build` antes. Los mazos se arman con la respuesta siempre en el
  mismo índice porque el cliente no puede saber cuál es la correcta: así es
  determinista. La partida 1 tiene la correcta en el índice 1 y la 2 en el 0: si
  los mezclás, la prueba de derrota deja de eliminar a nadie. `run-e2e.sh` mata el
  server por PID, no con `pkill -f`.

### `FORMATO-MAZO.md` está duplicado y ya divergió

Hay dos copias y **no son iguales**:

- `FORMATO-MAZO.md` (raíz) — la que lee y valida `spec.test.mjs`.
- `apps/web/public/FORMATO-MAZO.md` — la que el usuario descarga desde la app
  (`App.tsx:244`, el botón "¿Qué formato tiene que tener?").

La del `public/` quedó atrás y ya miente: promete `beats[].text` de **280
caracteres** cuando el código (`maxSceneBeatTextLength`) y el documento de la raíz
dicen **600**. Al tocar reglas del formato hay que editar **las dos**, o el test
pasa mientras lo que descarga la gente quedó viejo.

## Convenciones

- Comentarios, textos de interfaz y mensajes de error en español rioplatense
  ("Subí", "Elegí", "Contestá"). Los tipos, nombres de función y los eventos en
  inglés. JSDoc `/** */` en lo exportado.
- 2 espacios, comillas dobles, punto y coma.
- Commits en español, imperativo, con cuerpo que explique el porqué.
- Agregar funcionalidad de juego casi siempre toca `packages/shared/src/index.ts`
  (tipos, `GAME_CONFIG`, `ENEMIES`, `ClientEvents`/`ServerEvents`) primero: los
  otros dos paquetes no compilan sin eso.

## Entorno

- Sólo se lee `PORT` y `WEB_ORIGIN` (CORS de Socket.IO, separado por comas);
  ambos documentados en `.env.example`. En producción el frontend cae a
  `window.location.origin`, así que `VITE_SERVER_URL` no hace falta: en desarrollo
  ya viene en `apps/web/.env.development` y la variable de shell le gana.
- Sprites y fuente pixel en `apps/web/public/` son copias a mano del pack
  `Ninja Adventure - Asset Pack/` de la raíz (renombradas). La app no lee el pack.
- `/health` responde `{ ok: true }` (`index.ts:30`); lo usan `run-e2e.sh` para
  esperar al server y los health checks de Render.
