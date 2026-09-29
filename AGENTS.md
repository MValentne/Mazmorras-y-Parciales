# AGENTS.md

Monorepo npm de un solo proceso Node: `apps/server` maneja los WebSockets **y**
sirve el build de `apps/web`. No hay CI, ni linter, ni formateador. El README tiene
el detalle de despliegue; este archivo tiene lo que no se deduce del README.

## Comandos

| Comando | Qué hace | Ojo con |
| --- | --- | --- |
| `npm run dev` | Build de `@dungeon/shared` + `tsx watch` (`:3001`) + Vite (`:5173`) | El server y el web van en procesos separados |
| `npm run build` | shared → server → web, en ese orden | El orden importa, ver abajo |
| `npm start` | Un solo proceso en `:3001` que sirve API + frontend | Necesita `apps/web/dist` |
| `npm test` | 39 unitarios (~9 s). **Compila shared y server primero** | Corre contra `dist/`, no contra el fuente |
| `npm run test:e2e` | 20 chequeos por WebSocket contra el server real (~70 s) | **No compila nada.** Sin `dist/` stale o falla |

Un solo test: `node --test --test-name-pattern="timeout" apps/server/test/game.test.mjs`.

`npm run build` es el único typecheck del proyecto (el build del web es
`tsc --noEmit && vite build`). No hay script aparte de `typecheck`.

## El orden de build es obligatorio

`packages/shared/package.json` apunta `main` y `types` a `./dist/`. Por eso:

- Hay que compilar `shared` **antes** de compilar server o web, siempre.
- **Los tests importan del build, no del fuente**: `game.test.mjs` importa
  `../dist/game.js`, `spec.test.mjs` importa `apps/server/dist/game.js` y
  `packages/shared/dist/index.js`. Si editás el fuente y no recompilás, el test
  pasa probando el código viejo.
- Editar `packages/shared/src` **no** reinicia nada en `npm run dev`: `tsx watch`
  sólo mira el fuente del server, y el server importa el `dist` compilado de
  shared. Hay que recompilar shared y reiniciar a mano.
- `apps/web/src/*.ts` no se puede importar directo desde los tests de Node: es
  TypeScript sin emitir. `deck.test.mjs` y `spec.test.mjs` lo compilan con
  `node_modules/.bin/esbuild` a un temporal y lo importan desde ahí.

## Invariantes que no hay que romper

- **La respuesta correcta nunca viaja por el cable antes de que se conteste.**
  `g.current` se arma eligiendo campos uno por uno en `dealCard`
  (`apps/server/src/game.ts`); `room.drawn` es la carta real y `publicView` lo
  descarta. Un `{ ...card }` en `current` filtra el `answer` a todos los clientes.
  Después de contestar, el `answer` y la `explanation` viajan en `game:reveal`.
- **Un evento de socket vive en tres archivos**: los tipos en
  `packages/shared/src/index.ts`, el handler y los `emit` en
  `apps/server/src/index.ts`, y el `on`/`emit` del cliente en `apps/web/src/App.tsx`.
  Si tocás uno, tocás los tres.
- **El servidor es la autoridad.** El cliente valida el mazo sólo para dar feedback
  rápido; `validateDeck` en `apps/server/src/game.ts` es lo que decide. El parser
  `apps/web/src/deck.ts` traduce y no juzga: deja pasar cartas incompletas a
  propósito.
- **El `playerId` sale de `socket.data`, nunca del payload** del evento.
- **Las salas viven en un `Map` en memoria**: una sola instancia. Reiniciar, o que
  Render reemplace la instancia, pierde las partidas activas (el cliente recibe
  `ROOM_NOT_FOUND` y vuelve al inicio). No se puede "arreglar" sin persistencia.
- El `id` de cada carta lo asigna el servidor en `validateDeck`; los mazos no lo
  traen.

## Tests

- `apps/server/test/game.test.mjs` — el motor, con timers reales. Usa `sleep`, así
  que es lento a propósito.
- `apps/server/test/deck.test.mjs` — el parser de mazos del cliente.
- `apps/server/test/spec.test.mjs` — ata `FORMATO-MAZO.md` al código: pasa sus
  ejemplos por el validador real y comprueba que cada límite de la tabla siga
  siendo el de `GAME_CONFIG`. **Si tocás `GAME_CONFIG` o las reglas de
  `validateDeck`, actualizá el documento o este test falla.**
- `apps/server/test/e2e.mjs` + `run-e2e.sh` — sube el server, juega dos partidas
  completas y lo baja. Usa el puerto `3111` para no chocar con el de desarrollo.
  Los mazos están armados con la respuesta siempre en el mismo índice, porque el
  cliente no puede saber cuál es la correcta: así la prueba es determinista.
  Demora ~70 s por la espera de pregunta y la pausa de reveal de 4,5 s entre cartas; no está colgada.
  Los mazos de la partida 1 tienen la correcta en el índice 1 y los de la 2 en el 0:
  si los mezclás, la prueba de derrota deja de eliminar a nadie.

## Convenciones

- Comentarios, textos de interfaz y mensajes de error en español rioplatense
  ("Subí", "Elegí", "Contestá"). Los tipos, nombres de función y los eventos en
  inglés. JSDoc `/** */` en lo exportado.
- 2 espacios, comillas dobles, punto y coma.
- Commits en español, imperativo, con cuerpo que explique el porqué.
- Agregar funcionalidad de juego casi siempre toca `packages/shared/src/index.ts`
  (tipos, `GAME_CONFIG`, `ENEMIES` y los dos mapas de eventos) primero: los otros
  dos paquetes no compilan sin eso.

## Despliegue

Render, un solo servicio. Root Directory **vacío** (monorepo), build
`npm ci && npm run build`, start `npm start`, health check path `/health`. Sin
secretos; `PORT` lo define el proveedor. Vercel y serverless no sirven: no
sostienen WebSockets persistentes. Detalle en el README.
