# Dungeon de Estudio

MVP cooperativo para estudiar en salas temporales. El servidor es la fuente de verdad; en esta primera fase están implementados el lobby, las invitaciones, el QR, los roles, las reconexiones y la transferencia del creador.

## Requisitos

- Node.js 20 o superior y npm.
- Para probar entre varios dispositivos en la misma red, todos deben poder alcanzar la computadora que ejecuta el servidor.

## Desarrollo local

1. En la raíz: `npm install`.
2. Ejecutá `npm run dev`.
3. Abrí `http://localhost:5173`. El servidor escucha en `http://localhost:3001`.
4. Para otros dispositivos en la misma red, averiguá la IP local de la computadora que corre el servidor (por ejemplo `192.168.1.20`). En una terminal ejecutá `npm run build --workspace @dungeon/shared` y luego `npm run dev --workspace @dungeon/server`. En otra terminal ejecutá `VITE_SERVER_URL=http://192.168.1.20:3001 npm run dev --workspace @dungeon/web -- --host 0.0.0.0`. Abrí y compartí `http://192.168.1.20:5173`; así el QR también apunta a una dirección que tus amigos pueden abrir. Todos deben estar en la misma red y el cortafuegos debe permitir conexiones a los puertos 5173 y 3001.

La URL del backend sale de `VITE_SERVER_URL`, que en desarrollo ya viene definida en `apps/web/.env.development`. Como las variables del entorno tienen prioridad sobre ese archivo, el paso 4 sigue funcionando pasándola por shell.

La memoria del servidor contiene las salas: al reiniciarlo se pierden. Una sala se elimina tras 30 minutos sin actividad. Los datos de configuración común están en `packages/shared/src/index.ts`.

## Producción local

Después de `npm run build`, `npm start` levanta un único servicio en el puerto 3001 que sirve el frontend compilado y los WebSockets desde el mismo origen. Sirve para reproducir en local lo que pasa en producción; las variables disponibles están documentadas en `.env.example`.

## Despliegue en Render

El servicio es un **único proceso Node**: `apps/server` sirve los WebSockets y además el build de `apps/web` (con fallback a `index.html` para que los enlaces `/sala/CODIGO` funcionen). El frontend cae a `window.location.origin`, así que `VITE_SERVER_URL` no hace falta en producción. Vercel y otros hosts serverless no sirven: no soportan conexiones WebSockets persistentes.

1. En render.com, `+ New` → `Web Service` → conectá el repositorio de GitHub.
2. Completá el formulario:

| Campo | Valor |
| --- | --- |
| Name | `dungeon-de-estudio` |
| Region | la más cercana a tus jugadores |
| Branch | `main` |
| Language | `Node` |
| Root Directory | **vacío** (raíz del repo) |
| Build Command | `npm ci && npm run build` |
| Start Command | `npm start` |

El Root Directory tiene que quedar vacío porque es un monorepo: Render deja de ver `packages/shared/` si lo ponés en un subdirectorio.

3. Plan **Free** para probar. Configurá en `Settings` → `Health Checks` el path `/health`: además de confirmar que la instancia está sana, los chequeos cuentan como tráfico entrante y mantienen el servicio despierto.
4. Deploy. Cada `git push` a `main` redeploya solo; `Deploys` muestra los logs de cada build.

Sin variables de entorno: no hay secretos y `PORT` lo define el proveedor. Opcionalmente `WEB_ORIGIN` con tu dominio público para acotar el CORS de Socket.IO.

### Límites

Las salas viven en la memoria del proceso, así que **solo puede haber una instancia**: si Render reemplaza la instancia (deploy, mantenimiento, o el spin-down del plan Free) las salas activas se pierden. El frontend no se rompe: la reconexión recibe `ROOM_NOT_FOUND` y vuelve al inicio.

El plan Free duerme a los 15 minutos sin tráfico; desde febrero de 2026 el tráfico de WebSockets lo evita, y los health checks también. Si igual notás esperas largas al primer visitante, el plan Starter de USD 7/mes no hiberna.

El repo es público y la app no tiene autenticación: cualquiera que conozca un código de sala puede entrar. Alcanza para un grupo de estudio, no para desconocidos.

