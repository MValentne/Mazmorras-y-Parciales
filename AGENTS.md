# AGENTS.md

Monorepo npm (workspaces): `apps/server` maneja WebSockets y sirve el build de
`apps/web` en un solo proceso Node. El README explica desarrollo y despliegue.
Sin CI, linter ni formateador. Comentarios, interfaz, errores y commits en español
rioplatense. Tipos, funciones y eventos en inglés. Dos espacios, comillas dobles,
punto y coma; JSDoc en lo exportado.

## Comandos y orden de compilación

- `npm ci`: instalar dependencias antes de correr pruebas.
- `npm test`: compila shared → server y ejecuta las pruebas de motor, parser y
  documentación. Importan `dist/`, nunca el TypeScript fuente.
- `npm run build`: shared → server → web. Es también el typecheck de los tres
  paquetes; no existe script `typecheck` separado.
- `npm run test:e2e`: requiere build reciente. Levanta un servidor en `3111`,
  conecta dos clientes reales y recorre derrota, rescate, reconexión, victoria,
  tiendas y eventos. `test/fast-config.mjs` acorta los tiempos sólo en ese proceso.
- `npx playwright install chromium` y `npm run test:ui`: requieren build reciente;
  prueban la web en escritorio/móvil y guardan capturas en `test-results/ui/`.
  Se puede pasar `CHROMIUM_PATH` para usar un navegador local. Puerto por defecto
  `3113`; la configuración visual elimina rasgos aleatorios sólo en ese servidor.
- Los runners cierran sus servidores por PID; no usar `pkill -f`.
- Un test suelto, después de compilar: `node --test
  --test-name-pattern="timeout" apps/server/test/game.test.mjs`.

`packages/shared/package.json` apunta a `dist/`: shared se compila antes de server
**y** web. Editar shared no basta con `npm run dev`: `tsx watch` observa server,
pero importa shared compilado; recompilá shared y reiniciá el servidor.

## Rondas, confirmación y estadísticas

- `handleAnswer` registra **un voto por jugador y pregunta**, sin resolver antes
  de tiempo aunque todos hayan votado. `resolveVotes` corre al vencer el reloj.
- El preview dura `promptPreviewSeconds`; no se admiten respuestas ni habilidades
  antes de `answerStartsAt`. Después del deadline tampoco se aceptan acciones de
  combate. Las habilidades sí se pueden usar después de haber votado.
- Una pregunta se resuelve una sola vez (`g.reveal` y `g.deadline` lo protegen).
  El estado conserva `reveal`, `revealedAt` y `visibleOptions` para reconexiones.
- El cliente muestra el voto propio azul, luego errores rojos y tras
  `feedbackCorrectDelayMs` la correcta verde. No borra el resultado con un timer.
- `continueGame` espera a **todos los conectados**, incluidos los caídos; recién
  después de `answerRevealMs` permite confirmar. `reconcileContinue` evita bloqueos
  por desconexiones. Las escenas usan `sceneReady` y su propia confirmación.
- `getContinuePhase` identifica pregunta/encuentro; `game:continue` debe enviar esa
  fase para que un click atrasado no confirme el encuentro siguiente.
  `game:answer` incluye `cardId` para ignorar respuestas de una carta anterior.
- `questionsCompleted` cuenta preguntas resueltas; `totalQuestions` es fijo;
  `pending` cuenta preguntas restantes (incluye la actual mientras está abierta),
  **nunca escenas**. `publish()` no recalcula ninguno de esos contadores.
- `mastered` cuenta una carta por pregunta con algún acierto. `correctAnswers` y
  `answersGiven` cuentan respuestas individuales, tanto en GameState como Player;
  un timeout de un jugador vivo conectado cuenta como fallo. Un voto enviado antes
  de desconectarse sigue contando. No sumar jugadores a un contador de cartas.
- El recorrido es lineal, no repite preguntas falladas. La victoria llega al
  completarlo con alguien en pie, después de la confirmación del último resultado.

## Objetos y encuentros

- Comprar sólo agrega unidades a `Player.inventory`; `useItem` aplica el efecto y
  consume una unidad únicamente si corresponde. Se usan durante preview, combate,
  resultados, escenas y encuentros. Un caído puede usar un vial para resucitarse.
- Golpe, esquive, marca, escudo y bomba persisten hasta activarse. Enfoque recarga
  habilidades; no se consume si ya están listas. No acumular efectos preparados.
- Cada `encounterEveryQuestions` preguntas se alternan tienda, fogata, tienda,
  tesoro, tienda, santuario. No se abre un encuentro después de la última pregunta.
- `claimEncounter` valida la opción según el evento y permite una recompensa por
  jugador (`encounterClaimed`). Los encuentros no tienen reloj; todos confirman
  para salir. `shopOpen` y `encounter === "shop"` deben mantenerse sincronizados.
- La primera caída grupal abre una tienda de rescate y garantiza monedas para un
  vial. La siguiente caída termina en derrota. El resultado se lee y confirma
  **antes** del rescate o del final. Abandonar voluntariamente no debe borrar un
  resultado que todavía se está leyendo.

## Invariantes de red

- La respuesta correcta **nunca** viaja antes del fin del reloj. `g.current` se
  construye eligiendo `id`, `prompt`, `options`; nunca hacer `{ ...card }`.
- `publicView` excluye sockets, cards, timeline, remaining, drawn, discardedFor,
  timers, votes y wrongPlayers. No confiar en que JSON ocultará Map/Set por sí solo.
- `game:vote` se envía a cada socket individual, tanto después de votar como al
  reconectarse. Nunca difundir los índices elegidos por otros antes del resultado.
- `visibleOptions` contiene índices reales **barajados**. Emitir el índice original,
  nunca la posición visual. Mudo y Mago pueden acortar esa lista, conservando la
  correcta. El servidor rechaza opciones ocultas. Si el Mago oculta una elección
  previa, el cliente conserva esa elección visible para su dueño.
- Los eventos tocan tres archivos: tipos en shared, handlers/emits en server y
  listeners/emits en App.tsx. La sesión de `roomOf(socket)` valida que el socket
  siga siendo el actual del jugador; un socket viejo no debe poder actuar.
- Los eventos de ingreso reciben el UUID de jugador de localStorage. Los demás
  toman la identidad de socket.data. Las salas están en memoria: una sola instancia,
  reiniciar el proceso pierde las partidas. No prometer persistencia.
- `validateDeck` es autoridad; el parser web sólo traduce para dar feedback.
  El servidor asigna IDs `c0`, `c1` y `s0`, `s1` a preguntas y escenas.

## Pruebas y documentación

Antes de editar, corré pruebas y registrá la línea base. La revisión anterior a
este rework tenía 39 pruebas, 11 fallos, un e2e cortado por el preview y build verde.
Eran supuestos obsoletos de respuesta individual, repetición de cartas y derrota
sin rescate. La suite actual cubre el flujo colectivo con reloj y confirmación.

- `game.test.mjs` modifica GAME_CONFIG en `before()` para tiempos breves; no
  contaminar otras pruebas. Limpia cada sala con `clearTimers` en `afterEach`.
- `started()` reintenta hasta obtener un enemigo sin rasgo para medir daño sin azar.
  Para casos de rasgos concretos se configura el enemigo explícitamente.
- `deck.test.mjs` y `spec.test.mjs` compilan `apps/web/src/deck.ts` con esbuild a un
  temporal; Node no puede importar directamente ese TS del frontend.
- Los ejemplos CSV/JSON del parser son fixtures. Las reglas de formato se prueban
  con `spec.test.mjs`. Al cambiar GAME_CONFIG o validación, actualizá documentación.
- `FORMATO-MAZO.md` y `apps/web/public/FORMATO-MAZO.md` deben ser **idénticos**: la
  segunda copia es la descarga del usuario. Hay una prueba que exige esa igualdad.

## Entorno y assets

Producción lee `PORT` y `WEB_ORIGIN`; frontend usa el origen actual. En desarrollo
`apps/web/.env.development` define `VITE_SERVER_URL`, que puede sobrescribir el shell.
`/health` responde `{ ok: true }`. Sin build web, el server avisa y sirve sólo API.

Sprites y fuente pixel en `apps/web/public/` son copias del pack Ninja Adventure;
la aplicación no carga assets desde el pack raíz. App.tsx usa ventanas recortadas de
sprites, CSS respeta `prefers-reduced-motion` y los eventos usan `<dialog>` nativo
para atrapar el foco. La mochila debe seguir accesible dentro de cada ventana.
