# Formato del archivo de tarjetas — Dungeon de Estudio

Este documento es la **especificación completa y normativa** del archivo de mazo que
acepta el juego. Está pensado para pegárselo tal cual a una IA y pedirle que arme un
mazo nuevo.

Si algo de acá contradice lo que la IA "sabe", gana este documento.

---

## 1. Contexto del juego

- Un grupo de estudiantes (de 2 a 12 personas) se reúne en una sala y entra en
  combate contra una secuencia de enemigos de estudio.
- Cada enemigo saca una **tarjeta**: una pregunta de opción múltiple que todos ven.
- La pregunta aparece primero durante **10 segundos** para que el grupo la lea; luego
  tiene **25 segundos** para elegir una opción. Si acierta, el enemigo pierde vida y
  la tarjeta se descarta. Si alguien falla, pierde un punto de vida y la pregunta
  sigue abierta. Si se agota el tiempo, cada aventurero pierde un punto de vida y la
  tarjeta vuelve al mazo.
- Cuando se acaba el mazo, el grupo gana la mazmorra.
- Después de cada respuesta se muestra una **explicación**: es el momento donde el
  grupo aprende. No es opcional en la práctica; un mazo sin explicaciones sirve
  mucho menos para estudiar.

**Implicación para las tarjetas:** el contenido es lo que el grupo ve en pantalla
grande durante 10 segundos antes de mostrar las opciones, y luego tiene 25 segundos
para responder. La explicación es lo que se llevan puesto. Escribí
para ese uso, no para un examen escrito.

---

## 2. Estructura del archivo

Se aceptan dos formatos. **Usá JSON salvo que te pidan CSV**: es el que menos
interpretación ambigua tiene.

### 2.1 JSON (recomendado)

El archivo es un objeto con dos campos:

```json
{
  "title": "string con el nombre del mazo",
  "cards": [
    {
      "prompt": "string con la pregunta",
      "options": ["primera opción", "segunda opción", "tercera opción", "cuarta opción"],
      "answer": 0,
      "explanation": "string con el por qué"
    }
  ]
}
```

También se acepta una **lista suelta** sin el envoltorio, cuando sólo importa el
contenido de `cards`:

```json
[
  { "prompt": "¿...?", "options": ["a", "b", "c", "d"], "answer": 2, "explanation": "..." }
]
```

### 2.2 CSV

Cuatro columnas separadas por comas, con una fila de encabezado:

```csv
pregunta,opciones,respuesta,explicacion
"¿Cuál es la capital de Francia?",París|Londres|Berlín|Roma,0,"París es la capital desde el siglo IX."
```

Reglas del CSV:

- Las **opciones van separadas por `|`** (barra vertical), no por comas.
- `respuesta` es el **índice de la opción correcta, empezando en 0**.
- Para poner comas, comillas o saltos de línea dentro de una celda, encerrala en
  comillas dobles: `"dice ""hola"""` produce `dice "hola"`.
- Las cabeceras se reconocen con o sin tilde y en mayúsculas o minúsculas, y en
  cualquier orden. Sinónimos aceptados: `pregunta`/`prompt`/`question`,
  `opciones`/`options`, `respuesta`/`answer`/`correcta`/`correct`,
  `explicacion`/`explanation`, `titulo`/`title`.
- Se puede agregar una columna `titulo` con el nombre del mazo en la primera carta.
- Si no hay fila de encabezado, se asume el orden
  `titulo,pregunta,opciones,respuesta,explicacion`.

---

## 3. Campos: límites exactos

| Campo | Obligatorio | Tipo | Límite | Notas |
|---|---|---|---|---|
| `title` | no | texto | 60 caracteres | Si falta, se usa el nombre del archivo; si tampoco, "Mazo sin título". |
| `prompt` | **sí** | texto | 300 caracteres | La pregunta. Sin salto de línea. |
| `options` | **sí** | lista de texto | 2 a 6 opciones, 160 caracteres cada una | Sin opciones repetidas ni vacías. |
| `answer` | **sí** | entero | de `0` a `options.length - 1` | Índice, **no** el texto de la respuesta. |
| `explanation` | no | texto | 400 caracteres | Sin salto de línea. |
| `id` | — | — | — | **No lo escribas.** Lo asigna el servidor. |

Límite del mazo completo: **máximo 600 tarjetas**.

Dos detalles que muerden si se ignoran:

- **Los saltos de línea se aplanan.** El servidor convierte cualquier secuencia de
  espacios, tabs o saltos de línea en un solo espacio. Escribí todo en una línea.
- **El recorte es silencioso.** Si una opción pasa los 160 caracteres, se corta a
  mitad de palabra y no avisa. No escribas párrafos largos dentro de una opción.

---

## 4. Reglas duras

El servidor **rechaza el mazo entero** si algo de esto se cumple. No es una
advertencia, es un error que deja la partida sin arrancar.

1. El mazo tiene que ser una lista no vacía.
2. Cada carta necesita `prompt` con texto.
3. Cada carta necesita entre 2 y 6 opciones.
4. Ninguna opción puede estar vacía.
5. Ninguna opción puede repetirse (comparadas ya recortadas: `"4"` y `" 4 "` **son** la misma y se rechaza).
6. `answer` tiene que ser un entero dentro del rango de las opciones.
7. No puede haber más de 600 cartas.

---

## 5. Cómo escribir buenas tarjetas (guía, no validación)

Esto no lo comprueba el servidor, pero es la diferencia entre un mazo que sirve
para estudiar y uno que no.

- **Una sola idea por tarjeta.** Si hace falta "y" para unir dos conceptos, son dos
  tarjetas.
- **Distractores del mismo tipo que la respuesta.** Si la respuesta es un año, las
  opciones falsas son años, no países. Un distractor obviamente descartable hace que
  la tarjeta se resuelva sin saber nada.
- **Nada de "todas las anteriores" ni "ninguna de las anteriores".** Rompen la
  aleatoriedad de los índices y la validación no las prohibe, pero arruinan el mazo.
- **La explicación justifica, no repite.** Decí *por qué* es correcta, no la
  respuesta de nuevo. Si alguien que ya sabía la respuesta no aprende nada, la
  explicación está mal.
- **Verificá los hechos.** La IA se equivoca con datos, fechas, fórmulas y
  nomenclaturas. Si dudás de un dato, marcá la carta para revisarla antes de jugar.
- **Sin opiniones ni subjetividad.** Una pregunta de opinión no tiene una respuesta
  correcta defendible, y discutirlas en grupo rompe el ritmo de la partida.
- **Cantidad recomendada:** entre 20 y 80 tarjetas. Con menos de 20 la mazmorra
  dura poco; con más de 100 el grupo se cansa antes de terminar.

---

## 6. Prompt listo para pegar

Copiar desde acá hasta el final, completar los lugares entre corchetes y enviar.

---

> Sos profesor y armás mazos para **Dungeon de Estudio**, un juego de preguntas
> donde un grupo de estudiantes lee cada pregunta durante 10 segundos y luego tiene
> 25 segundos para responder. Después de contestar, el grupo ve una explicación.
>
> Escribí un mazo sobre: **[TEMA]**, para: **[NIVEL / DIFICULTAD]**.
> Cantidad de tarjetas: **[N]**.
>
> Usá este formato, sin desviarte:
>
> ```json
> {
>   "title": "nombre del mazo, máximo 60 caracteres",
>   "cards": [
>     {
>       "prompt": "la pregunta, máximo 300 caracteres, en una línea",
>       "options": ["opción 0", "opción 1", "opción 2", "opción 3"],
>       "answer": 0,
>       "explanation": "por qué esa es la respuesta, máximo 400 caracteres, en una línea"
>     }
>   ]
> }
> ```
>
> Reglas obligatorias:
> 1. `answer` es el **índice** de la opción correcta, contando desde 0.
> 2. Entre **2 y 6** opciones por tarjeta. Si no usás las 4, está bien.
> 3. Las opciones **no** pueden repetirse ni quedar vacías.
> 4. Sin saltos de línea ni comillas dobles dentro de los textos.
> 5. Máximo 600 tarjetas. Sin campo `id`: lo pone el servidor.
>
> Reglas de calidad:
> 6. Una sola idea por tarjeta.
> 7. Los distractores son del mismo tipo que la respuesta y son plausibles para
>    alguien que no estudió. Nada de "todas las anteriores".
> 8. La explicación justifica por qué la respuesta es correcta; no la repite.
> 9. Verificá que los datos, fechas, fórmulas y nombres sean correctos. Si no estás
>    seguro de un dato, incluí la tarjeta pero marcá al final cuáles conviene
>    revisar a mano.
>
> Devolvé **sólo el JSON**, sin texto antes ni después.

---

## 7. Checklist antes de devolver el mazo

- [ ] El JSON (o CSV) parsea sin error.
- [ ] Todas las tarjetas tienen `prompt` con texto.
- [ ] Todas tienen entre 2 y 6 opciones, ninguna vacía ni repetida.
- [ ] Todos los `answer` caen dentro del rango de sus opciones.
- [ ] Ninguna opción es obviamente incorrecta comparada con las otras.
- [ ] La explicación de cada tarjeta enseña algo, no sólo confirma.
- [ ] Los datos dudosos están marcados para revisión.
- [ ] No hay saltos de línea dentro de los textos.
