/**
 * Tests del parser de mazos: es lo primero que toca el usuario al pegar un CSV
 * o elegir un archivo, y antes no tenía ninguna cobertura.
 *
 * El módulo es TypeScript de la app web, así que se compila con esbuild a un
 * temporal y se importa desde acá.
 *
 * Ojo con el reparto de responsabilidades: el parser sólo *lee* (saca texto,
 * columnas y números). Que una carta sea jugable —opciones repetidas, respuesta
 * fuera de rango, pregunta vacía— lo rechaza el server, y eso se prueba en
 * game.test.mjs. Acá se prueba que leerlo no rompa nada ni pierda datos.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL("../../..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "deck-"));
const out = join(dir, "deck.mjs");

execFileSync(join(root, "node_modules/.bin/esbuild"), [
  join(root, "apps/web/src/deck.ts"),
  "--bundle", "--format=esm", "--platform=node", `--outfile=${out}`,
], { stdio: "pipe" });

const mod = await import(out);
const { parseDeckText, parseDeckFile, parseCsvRows, CSV_EXAMPLE, JSON_EXAMPLE } = mod;

/** Atajo: parsea y falla el test si el parser devolvió un error. */
const parse = (text, fileName = "mazo.csv") => {
  const r = parseDeckText(text, fileName);
  assert.equal(r.error, null, `esperaba un mazo válido, llegó: ${r.error}`);
  return r;
};
/** Atajo inverso: exige un error de lectura y devuelve el mensaje. */
const err = (text, fileName = "mazo.csv") => {
  const r = parseDeckText(text, fileName);
  assert.notEqual(r.error, null, "esperaba un error de lectura");
  return r.error;
};

test("los ejemplos que se muestran en la UI son jugables de verdad", () => {
  for (const [text, name] of [[CSV_EXAMPLE, "ejemplo.csv"], [JSON_EXAMPLE, "ejemplo.json"]]) {
    const d = parse(text, name);
    assert.ok(d.cards.length > 0, `${name} no trae cartas`);
    for (const c of d.cards) {
      assert.ok(c.prompt.trim().length > 0, `${name}: pregunta vacía`);
      assert.ok(c.options.length >= 2, `${name}: menos de dos opciones`);
      assert.ok(c.options.every((o) => o.trim().length > 0), `${name}: opción vacía`);
      assert.ok(Number.isInteger(c.answer), `${name}: respuesta no entera`);
      assert.ok(c.answer >= 0 && c.answer < c.options.length, `${name}: respuesta fuera de rango`);
    }
  }
});

test("reconoce las cabeceras en cualquier orden y con sinónimos", () => {
  const a = parse("pregunta,opciones,respuesta,explicacion\n2+2,4|5,0,sumar");
  const b = parse("respuesta,explicacion,pregunta,opciones\n0,sumar,2+2,4|5");
  assert.deepEqual(a.cards, b.cards);
  assert.equal(a.cards[0].prompt, "2+2");
  assert.equal(a.cards[0].explanation, "sumar");
});

test("acepta las cabeceras con tildes, mayúsculas y nombres en inglés", () => {
  const d = parse("Pregunta,Opciones,Respuesta,Explicación\n2+2,4|5,1,sumar");
  assert.deepEqual(d.cards[0].options, ["4", "5"]);
  assert.equal(d.cards[0].answer, 1);
  const en = parse("question,options,correct\n2+2,4|5,1");
  assert.equal(en.cards[0].answer, 1);
});

test("sin cabecera reconocible asume el orden titulo,pregunta,opciones,respuesta,explicacion", () => {
  const d = parse("Matemática,2+2,4|5,0,sumar\nHistoria,¿y?,a|b,0,porque");
  assert.equal(d.title, "Matemática");
  assert.equal(d.cards[0].prompt, "2+2");
  assert.deepEqual(d.cards[0].options, ["4", "5"]);
  assert.equal(d.cards[0].answer, 0);
  assert.equal(d.cards[1].explanation, "porque");
});

test("saca el título de la columna titulo y, si no hay, del nombre del archivo", () => {
  assert.equal(parse("titulo,pregunta,opciones,respuesta\nHistoria,¿y?,a|b,0", "x.csv").title, "Historia");
  assert.equal(parse("pregunta,opciones,respuesta\n2+2,4|5,0", "historia-antigua.csv").title, "historia antigua");
  assert.equal(parse("pregunta,opciones,respuesta\n2+2,4|5,0", "sin_nombre__.csv").title, "sin nombre");
  assert.equal(parse("pregunta,opciones,respuesta\n2+2,4|5,0", "---.csv").title, "Mazo");
});

test("el CSV maneja comas internas, saltos de línea y comillas escapadas", () => {
  const d = parse('pregunta,opciones,respuesta\n"¿2+2, no?",4|5,0');
  assert.equal(d.cards[0].prompt, "¿2+2, no?");

  const multi = parse('pregunta,opciones,respuesta\n"primera\nsegunda",4|5,0');
  assert.equal(multi.cards[0].prompt, "primera\nsegunda");

  const quoted = parse('pregunta,opciones,respuesta\n"dice ""sí""",4|5,0');
  assert.equal(quoted.cards[0].prompt, 'dice "sí"');
});

test("descarta filas vacías y sobrevive a los CRLF de Excel", () => {
  const d = parse("pregunta,opciones,respuesta\r\n\r\n2+2,4|5,0\r\n\r\n3+3,5|6,0\r\n");
  assert.equal(d.cards.length, 2);
  assert.equal(d.cards[1].prompt, "3+3");
});

test("recorta las opciones y descarta las que quedaron en blanco", () => {
  const d = parse("pregunta,opciones,respuesta\n2+2, 4 | | 5 |,0");
  assert.deepEqual(d.cards[0].options, ["4", "5"]);
});

test("parseCsvRows devuelve celdas, sin filtrar, y separa por comas y por comillados", () => {
  assert.deepEqual(parseCsvRows("a,b\nc,d"), [["a", "b"], ["c", "d"]]);
  assert.deepEqual(parseCsvRows('"a,b",c'), [["a,b", "c"]]);
  assert.deepEqual(parseCsvRows('"a""b"'), [['a"b']]);
  assert.deepEqual(parseCsvRows("\n\n  \n"), []);
  assert.deepEqual(parseCsvRows("a,,b"), [["a", "", "b"]], "una celda vacía en el medio se conserva");
});

test("lee JSON como lista suelta o envuelto en cards/questions/preguntas", () => {
  const card = { prompt: "2+2", options: ["4", "5"], answer: 0 };
  assert.equal(parse(JSON.stringify([card]), "m.json").cards.length, 1);
  for (const key of ["cards", "questions", "preguntas"]) {
    const d = parse(JSON.stringify({ title: " mates ", [key]: [card] }), "m.json");
    assert.equal(d.cards.length, 1, `no leyó la clave ${key}`);
    assert.equal(d.title, "mates");
  }
});

test("avisa con un mensaje útil cuando el archivo no se puede leer", () => {
  assert.match(err("{roto", "m.json"), /no se pudo leer/i);
  assert.match(err('{"otra":"cosa"}', "m.json"), /lista de preguntas/i);
  assert.match(err("[]", "m.json"), /ninguna pregunta/i);
  assert.match(err("pregunta,opciones,respuesta", "m.csv"), /encabezado y al menos una/i);
  assert.match(err("", "m.csv"), /encabezado y al menos una/i);
  assert.match(err("pregunta,opciones,respuesta\n", "m.csv"), /encabezado y al menos una/i);
});

test("una carta incompleta la deja pasar: el server es el que la rechaza", () => {
  // El parser traduce, no juzga: si el filtro de fondo está en el server, una carta
  // a medio hacer tiene que llegarle entera para que él la vea y la rechace.
  assert.deepEqual(parse('{"cards":[{"prompt":"p"}]}', "m.json").cards, [{ prompt: "p" }]);
  // El CSV en cambio arma siempre el mismo objeto, con los huecos ya vacíos.
  assert.deepEqual(parse("pregunta,opciones,respuesta\np,,0", "m.csv").cards,
    [{ prompt: "p", options: [], answer: 0, explanation: "" }]);
});

test("la extensión del archivo decide el formato, y .txt se lee como CSV", () => {
  const comoJson = parse('{"cards":[{"prompt":"2+2","options":["4","5"],"answer":0}]}', "mazo.json");
  assert.equal(comoJson.cards[0].prompt, "2+2");
  const comoCsv = parse("pregunta,opciones,respuesta\n2+2,4|5,0", "mazo.txt");
  assert.equal(comoCsv.cards[0].prompt, "2+2");
  // Un .txt con texto de JSON se lee como CSV y se rechaza por falta de cabecera:
  // el parser no adivina el formato, se guía por la extensión.
  assert.match(parseDeckText('{"cards":[]}', "mazo.txt").error, /encabezado y al menos una/i);
});

test("parseDeckFile acepta .csv/.json/.txt, frena los archivos gigantic y rechaza otras extensiones", async () => {
  const archivo = (name, body) => new File([body], name);

  assert.equal((await parseDeckFile(archivo("m.csv", "pregunta,opciones,respuesta\n2+2,4|5,0"))).cards.length, 1);
  assert.equal((await parseDeckFile(archivo("m.json", JSON_EXAMPLE))).cards.length, 1);
  assert.equal((await parseDeckFile(archivo("m.txt", "pregunta,opciones,respuesta\n3+3,5|6,0"))).cards.length, 1);

  const grande = "a,b|".repeat(2_000_000);
  assert.match((await parseDeckFile(archivo("grande.csv", grande))).error, /2 MB|más chico/i);
  assert.match((await parseDeckFile(archivo("mazo.pdf", "lo que sea"))).error, /\.json o \.csv/i);
});

test("el parser devuelve la estructura que espera el server, sin ids", async () => {
  const d = await parseDeckFile(new File([JSON_EXAMPLE], "biologia.json"));
  assert.equal(d.title, "Biología 1°");
  assert.equal(d.error, null);
  for (const c of d.cards) {
    assert.equal(c.id, undefined, "el id lo asigna el server, no el cliente");
    assert.equal(typeof c.prompt, "string");
    assert.ok(Array.isArray(c.options));
    assert.equal(typeof c.answer, "number");
  }
});
