# Formato de mazo narrativo — Mazmorras y Parciales

Esta especificación define cómo crear mazos para **Mazmorras y Parciales**. Está
pensada para entregársela a una IA junto con el tema y el nivel deseados.

Los mazos nuevos se escriben en JSON y cuentan una historia en orden. Las escenas
presentan el lugar, el objetivo y los conceptos que aparecerán en las preguntas
siguientes. El juego nunca mezcla ni sortea las escenas o las preguntas.

## 1. Cómo se juega un mazo

- La partida recorre el archivo de arriba abajo.
- Cada escena aparece como una pausa narrativa: el grupo ve el lugar, el rumbo y
  entre 2 y 4 momentos breves. No hay opciones ni cuenta regresiva en esta pantalla.
- Cada jugador conectado confirma **Seguir a las preguntas**. La escena avanza
  cuando confirmó todo el grupo conectado. Los jugadores caídos también pueden leer
  y confirmar. Si alguien se desconecta, deja de bloquear el avance.
- Al terminar la escena, aparecen en orden las preguntas que contiene. Cada pregunta
  se muestra 10 segundos antes de habilitar sus opciones. El grupo tiene 25 segundos
  para responder. Cada jugador vota una sola vez: su elección queda azul.
- Al terminar el reloj se resuelven todos los votos: cada acierto daña al enemigo;
  cada error o falta de voto cuesta una vida (dos contra enemigos furiosos), salvo
  que haya una protección. Las opciones incorrectas se marcan rojas y, 800 ms
  después, la correcta aparece verde junto con la explicación.
- El resultado queda visible hasta que **todos los jugadores conectados**, incluidos
  los caídos, pulsen **Continuar**. El botón se habilita a los 1500 ms. No hay avance
  automático ni repetición de preguntas; se respeta el orden narrativo del archivo.
- Cada dos preguntas hay un encuentro, salvo al terminar el mazo: tienda, fogata,
  tienda, tesoro, tienda, santuario; luego se repite el ciclo. Aparece como ventana
  superpuesta, sin reloj, y todos confirman para seguir.
- Las compras se guardan en la mochila. Los objetos se pueden usar en cualquier
  fase de la partida. Cada jugador empieza con una poción y tres monedas; recibe
  una moneda por acierto y dos por enemigo derrotado. La primera caída de todo el
  equipo ofrece una tienda de rescate; una segunda caída termina la expedición.
- Completar el recorrido con alguien en pie da la victoria. El resumen separa
  preguntas resueltas, aciertos personales y aciertos del equipo. Una pregunta con
  al menos un acierto suma una sola carta dominada, independientemente del grupo.
- Las escenas ordenan y preparan los temas; las preguntas comprueban lo aprendido.

Una escena debe poder leerse con comodidad, y a la vez enseñar lo necesario para
resolver sus preguntas. Dividí la ambientación o explicación en momentos con título
propio. Cada momento debe desarrollar una idea con contexto, detalles y relaciones
entre conceptos; evitá los textos telegráficos o de una sola oración. Usá los 2 a 4
momentos para presentar, explicar y conectar el contenido que se evaluará después.

## 2. Profundidad de la mazmorra

`depth` indica el total exacto de preguntas del mazo. Elegí una de estas
profundidades:

| Profundidad | Preguntas | Duración narrativa sugerida |
|---|---:|---|
| Breve | 40 | 4 a 6 escenas |
| Normal | 60 | 6 a 8 escenas |
| Profunda | 80 | 8 a 10 escenas |
| Épica | 100 | 10 a 14 escenas |

El mazo debe tener exactamente la cantidad declarada en `depth`. Las escenas no
cuentan como preguntas. Repartí las preguntas entre las escenas y mantené cada
grupo junto a la escena que lo prepara.

## 3. JSON recomendado

La estructura de cada escena es:

- `title`: nombre breve de la escena.
- `setting`: lugar o momento de la historia.
- `objective`: qué debe comprender o lograr el grupo en esta parte.
- `beats`: entre 2 y 4 momentos, cada uno con título y un párrafo desarrollado que
  explique conceptos relevantes para las preguntas siguientes.
- `cards`: preguntas de opción múltiple que siguen a esta escena, en orden.

```json
{
  "title": "El archivo de la vida",
  "scenes": [
    {
      "title": "La puerta de las células",
      "setting": "Vestíbulo del archivo biológico",
      "objective": "Distinguir las estructuras celulares y la función que cumple cada una.",
      "beats": [
        {
          "heading": "La guardiana del umbral",
          "text": "La célula es la unidad estructural y funcional básica de los seres vivos: los organismos pueden estar formados por una célula o por muchas, pero sus funciones vitales dependen de la actividad celular. Sus componentes intercambian materia e información y cooperan para mantener condiciones internas estables."
        },
        {
          "heading": "Dos planos del archivo",
          "text": "La diferencia central está en cómo se organiza el material genético. En las células procariotas, el ADN se encuentra en una región del citoplasma y no está rodeado por una membrana nuclear. Las eucariotas, en cambio, tienen un núcleo delimitado que protege y organiza el ADN; además poseen compartimentos internos especializados."
        }
      ],
      "cards": [
        {
          "prompt": "¿Qué tipo de célula guarda su ADN dentro de un núcleo?",
          "options": ["Procariota", "Eucariota", "Viral", "Ninguna"],
          "answer": 1,
          "explanation": "En las células eucariotas, una membrana rodea el núcleo y separa el ADN del citoplasma."
        },
        {
          "prompt": "¿Cuál es la unidad básica de los seres vivos?",
          "options": ["El órgano", "El tejido", "La célula", "El átomo"],
          "answer": 2,
          "explanation": "La célula es la unidad mínima capaz de realizar las funciones de la vida."
        }
      ]
    }
  ]
}
```

El ejemplo muestra una escena y dos preguntas para explicar la estructura; **es un
fragmento didáctico**, no un mazo listo para jugar. Para una partida real, agregá
`depth` y las preguntas y escenas necesarias hasta alcanzar exactamente esa cantidad.

## 4. Campos y límites

| Campo | Obligatorio | Tipo | Límite / regla |
|---|---|---|---|
| `title` | sí | texto | Hasta 60 caracteres. |
| `depth` | sí en mazos nuevos | entero | 40, 60, 80 o 100; debe coincidir con la cantidad de preguntas. |
| `scenes` | sí en mazos nuevos | lista | De 1 a 20 escenas, en el orden que se jugarán. |
| `scenes[].title` | sí | texto | Hasta 70 caracteres. |
| `scenes[].setting` | sí | texto | Hasta 100 caracteres. |
| `scenes[].objective` | sí | texto | Hasta 180 caracteres. |
| `scenes[].beats` | sí | lista | De 2 a 4 momentos desarrollados por escena; entre todos deben preparar las preguntas del grupo. |
| `beats[].heading` | sí | texto | Hasta 70 caracteres. |
| `beats[].text` | sí | texto | Hasta 600 caracteres. Un párrafo explicativo por momento, con una idea principal desarrollada y datos suficientes para comprender el tema sin consultar otra fuente. |
| `scenes[].cards` | sí | lista | Al menos una pregunta por escena; el mazo completo no puede superar 100. |
| `cards[].prompt` | sí | texto | Hasta 300 caracteres. |
| `cards[].options` | sí | lista de textos | De 2 a 6 opciones, hasta 160 caracteres cada una. |
| `cards[].answer` | sí | entero | Índice de la opción correcta, desde 0. |
| `cards[].explanation` | no, recomendado | texto | Hasta 400 caracteres; explica el concepto. |
| `id` | no | — | No lo escribas: lo asigna el servidor. |

El servidor rechaza preguntas incompletas, opciones vacías o repetidas, respuestas
fuera de rango, profundidades que no coinciden y mazos con más de 100 preguntas.
Los saltos de línea y espacios repetidos dentro de un texto se reducen a un espacio.

## 5. Orden y continuidad

- Escribí las escenas y preguntas en el orden exacto de la aventura.
- Cada escena prepara las preguntas que aparecen inmediatamente después de ella.
- No repitas una escena ni pongas preguntas sueltas entre grupos narrativos.
- Organizá los conceptos de forma progresiva: primero fundamentos, luego relaciones,
  aplicaciones y desafíos integradores.
- La respuesta correcta es el índice de la opción, no su texto: `0` significa la
  primera opción.
- Las opciones deben ser distintas y plausibles. No uses “todas las anteriores” ni
  “ninguna de las anteriores”.
- Incluí explicaciones breves que enseñen por qué la respuesta es correcta.
- Verificá datos, fechas, fórmulas y nombres propios antes de entregar el archivo.

## 6. CSV y mazos anteriores

Se siguen aceptando listas JSON antiguas con `cards`, y CSV con las columnas
`pregunta,opciones,respuesta,explicacion`, por compatibilidad. Se juegan en el orden
en que aparecen y no pueden incluir escenas. Para crear mazos nuevos, usá el JSON
narrativo de esta guía.

Ejemplo de CSV compatible:

```csv
pregunta,opciones,respuesta,explicacion
"¿Cuál es la capital de Francia?",París|Londres|Berlín|Roma,0,"París es la capital de Francia."
```

## 7. Instrucciones para generar un mazo con IA

Copiá este prompt y completá el tema y el nivel. Si no se indica profundidad, la IA
debe preguntar primero cuál se desea y esperar la respuesta antes de generar el mazo.

> Sos docente y guionista de **Mazmorras y Parciales**, un juego cooperativo de
> estudio. Diseñá una aventura de escenas narrativas y preguntas de opción múltiple.
>
> Tema: **[TEMA]**. Nivel: **[NIVEL / DIFICULTAD]**.
> Profundidad elegida: **[40, 60, 80 o 100 preguntas]**.
>
> Si falta la profundidad, preguntá si la mazmorra será Breve (40), Normal (60),
> Profunda (80) o Épica (100). No generes el archivo hasta que el usuario elija.
>
> Devolvé un único JSON válido con `title`, `depth` y `scenes`. Cada escena debe
> incluir `title`, `setting`, `objective`, entre 2 y 4 `beats` con `heading` y
> `text`, y una lista `cards` con las preguntas de esa parte. Seguí el orden
> narrativo: el contenido no se baraja.
>
> Generá exactamente tantas preguntas como indique `depth`, repartidas entre las
> escenas. Cada pregunta lleva `prompt`, entre 2 y 6 `options`, `answer` como índice
> desde 0 y una `explanation`. Respetá todos los límites y reglas de este documento.
> Las escenas deben anticipar y explicar los conceptos que se preguntarán después.
> Dividí la narración en 2 a 4 momentos con títulos por escena. Cada momento debe
> tener un párrafo explicativo sustancial (sin superar 600 caracteres): desarrolla
> el concepto, aporta contexto o un ejemplo y explica cómo se relaciona con las
> preguntas que siguen. No uses frases telegráficas ni texto de relleno.
>
> Verificá que el JSON parsee, que la profundidad coincida con el total de preguntas,
> que no haya opciones repetidas y que cada respuesta sea defendible. Devolvé sólo el
> JSON, sin introducción ni cierre.
