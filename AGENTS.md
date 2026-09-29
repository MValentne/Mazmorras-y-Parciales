# AGENTS.md

Monorepo npm (workspaces) de un solo proceso Node: `apps/server` maneja los
WebSockets **y** sirve el build de `apps/web`. Sin CI, sin linter, sin formateador.
El README tiene el detalle de despliegue; este archivo tiene lo que no se deduce
del README.

## La suite está en rojo en `main` — no la arregles sin que te lo pidan

Verificado sobre `main` limpio (`git status` sin cambios). **Antes de tocar nada,
corré los tests y anotá la línea base.**

| Comando | Estado en `main` | Causa de los fallos |
| --- | --- | --- |
| `npm test` | 39 tests, **3 fallan** | tests viejos, no el código |
| `npm run test:e2e` | 20 checks, **1 falla** | idem |

Los cuatro fallos son tests que quedaron atrás cuando entraron funciones nuevas.
Si los arreglás como parte de otro trabajo, decilo en el mensaje del commit.

- `deck.test.mjs` "avisa con un mensaje útil cuando el archivo no se puede leer":
  el regex espera `/lista de preguntas/i` y el parser hoy dice
  "El JSON tiene que incluir preguntas o una lista de escenas."
- `game.test.mjs` "perder cuando todo el equipo cae termina la partida" y
  "si nadie responde, cada timeout daña al grupo hasta perder": desde la tienda de
  emergencia, cuando cae todo el equipo `settle()` **no** termina la partida, abre
  la tienda con las monedas-topadas y deja `status === "playing"`. Reproducible:
  con el equipo en 0 de vida, `{ status: "playing", shopOpen: true }`.
- `e2e.mjs` "Timeout esperando: aparecen las opciones": `until()` espera
  `100 × 50 ms = 5 s`, pero `GAME_CONFIG.promptPreviewSeconds` es `10`. El test
  nunca puede pasar contra el server real.

`npm run build` sí pasa limpio.

## Comandos

| Comando | Qué hace | Ojo con |
| --- | --- | --- |
| `npm run dev` | Build de `@dungeon/shared` + `tsx watch` (`:3001`) + Vite (`:5173`) | Server y web van en procesos separados |
| `npm run build` | shared → server → web, en ese orden. **Es el único typecheck** | El build del web es `tsc --noEmit && vite build`; no hay script `typecheck` |
| `npm start` | Un solo proceso en `:3001` con API + frontend | Necesita `apps/web/dist`; si falta, avisa y sirve sólo la API |
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

- **La respuesta correcta nunca viaja por el cable antes de que se conteste.**
  `g.current` se arma eligiendo campos uno por uno en `dealCard`
  (`apps/server/src/game.ts:388`); `room.drawn` es la carta real y `publicView`
  (`game.ts:145`) descarta `drawn`, `cards`, `timeline`, `remaining`, `timers`,
  `sockets` y `discardedFor`. Un `{ ...card }` en `current` filtra el `answer` a
  todos los clientes. Después de contestar, `answer` y `explanation` viajan en
  `game:reveal`.
- **El índice que se manda no es el índice que se ve.** `visibleOptions` es una
  lista *barajada de índices* sobre `options` (`visibleFor`, `game.ts:240`), y el
  cliente hace `shown.map(i => ...)` y emite `i` (`App.tsx:294`, `App.tsx:339-343`).
  Mandar la posición en `shown` responde por la carta equivocada. Ojo: la letra
  del botón también sale del índice original (`String.fromCharCode(65 + i)`), así
  que se ven desordenadas a propósito.
- `visibleOptions` puede ser **más corto** que `options`: el enemigo con rasgo
  `mudo` lo recorta a `mutedEnemyOptions` y descartar una opción lo deja en 2.
- **Hay una ventana de preview**: `armDeadline` arma `answerStartsAt` =
  `promptPreviewSeconds` antes del deadline y `handleAnswer` rechaza lo que llega
  antes con `QUESTION_PREVIEW`. El cliente ya bloquea el click en ese rango
  (`canAct`); el server es el que manda.
- **Un evento de socket vive en tres archivos**: los tipos en
  `packages/shared/src/index.ts` (`ClientEvents` / `ServerEvents`), el handler y
  los `emit` en `apps/server/src/index.ts`, y el `on`/`emit` del cliente en
  `apps/web/src/App.tsx`. Si tocás uno, tocás los tres.
- **El servidor es la autoridad.** El cliente valida el mazo sólo para feedback
  rápido; `validateDeck` (`game.ts:49`) es lo que decide. El parser
  `apps/web/src/deck.ts` traduce y no juzga: deja pasar cartas incompletas a
  propósito.
- **El `playerId` sale de `socket.data`, nunca del payload** del evento.
- **Las salas viven en un `Map` en memoria**: una sola instancia. Reiniciar, o que
  Render reemplace la instancia, pierde las partidas activas (el cliente recibe
  `ROOM_NOT_FOUND` y vuelve al inicio). No se puede "arreglar" sin persistencia.
- El `id` de cada carta lo asigna el servidor en `validateDeck` (`c0`, `c1`…,
  `s0`, `s1`…); los mazos que manda el cliente no lo traen.

## Tests

- `game.test.mjs` — el motor de juego. Su `before()` **muta el
  `GAME_CONFIG` compartido en runtime** (`answerRevealMs = 5`,
  `promptPreviewSeconds = 0`, `questionTimeSeconds = 0.08`): por eso la suite
  tarda segundos y no minutos. `as const` es sólo de compilación, el objeto
  exportado es mutable y el engine lo lee en vivo. Si agregás un test que mida
  tiempos reales, no contamines esos valores.
- El enemigo se sortea al azar **con rasgo incluido** y su HP escala con la
  cantidad de jugadores. Para medir una habilidad puntual, `started()` reintenta
  hasta 40 veces hasta que salga un enemigo `trait === null`; si tu aserción
  depende del daño, usá ese helper en vez de `startGame` pelado.
- Cada test registra su room en `openRooms` y `afterEach` corre `clearTimers`: sin
  eso los timeouts de tests anteriores siguen emitiendo y contaminan.
- `deck.test.mjs` — el parser de mazos del cliente.
- `spec.test.mjs` — ata `FORMATO-MAZO.md` al código: pasa sus ejemplos por el
  validador real y comprueba que cada límite de la tabla siga siendo el de
  `GAME_CONFIG`. **Si tocás `GAME_CONFIG` o las reglas de `validateDeck`,
  actualizá el documento o este test falla.**
- `e2e.mjs` + `run-e2e.sh` — sube el server, juega dos partidas y lo baja. Usa el
  puerto `3111` para no chocar con el de desarrollo. Los mazos se arman con la
  respuesta siempre en el mismo índice porque el cliente no puede saber cuál es
  la correcta: así es determinista. La partida 1 tiene la correcta en el índice 1
  y la 2 en el 0: si los mezclás, la prueba de derrota deja de eliminar a nadie.
  `run-e2e.sh` mata el server por PID, no con `pkill -f`.

### `FORMATO-MAZO.md` está duplicado y ya divergió

Hay dos copias y **no son iguales**:

- `FORMATO-MAZO.md` (raíz) — la que lee y valida `spec.test.mjs`.
- `apps/web/public/FORMATO-MAZO.md` — la que el usuario descarga desde la app
  (`App.tsx:244`, el botón "¿Qué formato tiene que tener?").

Al tocar reglas del formato hay que editar **las dos**, o el test pasa mientras lo
que descarga la gente quedó viejo.

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

## Despliegue

Render, un solo servicio. Root Directory **vacío** (monorepo), build
`npm ci && npm run build`, start `npm start`, health check path `/health`. Sin
secretos; `PORT` lo define el proveedor. Vercel y serverless no sirven: no
sostienen WebSockets persistentes. Detalle en el README.
