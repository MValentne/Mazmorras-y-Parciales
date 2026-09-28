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

La memoria del servidor contiene las salas: al reiniciarlo se pierden. Una sala se elimina tras 30 minutos sin actividad. Los datos de configuración común están en `packages/shared/src/index.ts`.

## Despliegue

Publicá `apps/server` y `apps/web` como servicios Node separados en un proveedor que soporte WebSockets. En el servidor configurá `PORT` (lo suele establecer el proveedor) y `WEB_ORIGIN` con el dominio público del frontend. En el frontend configurá `VITE_SERVER_URL` con la URL pública del backend y construí desde la raíz con `npm run build`. El frontend genera el enlace `/sala/CODIGO` y su QR usando el dominio con el que se abrió; por eso el dominio público del frontend debe ser el que compartas. Habilitá WebSockets en el servicio del backend. En la fase de despliegue se documentará el flujo exacto para el proveedor elegido.
