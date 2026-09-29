/**
 * El documento de formato del mazo (FORMATO-MAZO.md) se le va a pegar a una IA para
 * que arme mazos, así que tiene que seguir diciendo la verdad. Este test ata el
 * documento al código: si cambia un límite, una regla o un ejemplo, la documentación
 * queda desactualizada y esto falla.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const RAIZ = new URL("../../..", import.meta.url).pathname;
const md = readFileSync(join(RAIZ, "FORMATO-MAZO.md"), "utf8");

const dir = mkdtempSync(join(tmpdir(), "deck-spec-"));
execFileSync(join(RAIZ, "node_modules/.bin/esbuild"), [
  join(RAIZ, "apps/web/src/deck.ts"),
  "--bundle", "--format=esm", "--platform=node", `--outfile=${join(dir, "deck.mjs")}`,
], { stdio: "pipe" });

const { validateDeck, validateDeckTitle } = await import(join(RAIZ, "apps/server/dist/game.js"));
const { parseDeckText } = await import(join(dir, "deck.mjs"));
const { GAME_CONFIG } = await import(join(RAIZ, "packages/shared/dist/index.js"));

// El prompt listo para pegar va citado con "> " en cada línea, así que hay que
// sacarle el marcador antes de poder parsear el JSON que lleva adentro.
const sinCita = (texto) => texto.replace(/^>\s?/gm, "");
const bloques = (lenguaje) => [...md.matchAll(new RegExp("```" + lenguaje + "\\n([\\s\\S]*?)```", "g"))]
  .map((m) => sinCita(m[1]));

const carta = (extra = {}) => ({ prompt: "p", options: ["a", "b"], answer: 0, ...extra });

test("el ejemplo JSON del documento lo acepta el servidor", () => {
  const ejemplos = bloques("json");
  assert.ok(ejemplos.length >= 1, "el documento debería traer el ejemplo JSON narrativo");
  for (const [i, texto] of ejemplos.entries()) {
    const datos = JSON.parse(texto);
    const { error } = validateDeck(datos);
    assert.equal(error, null, `el ejemplo ${i + 1} del documento no pasa el validador: ${error}`);
  }
});

test("el ejemplo CSV del documento lo acepta el parser y el servidor", () => {
  const ejemplos = bloques("csv");
  assert.ok(ejemplos.length >= 1, "al documento le falta el ejemplo CSV");
  for (const [i, texto] of ejemplos.entries()) {
    const leido = parseDeckText(texto, "ejemplo.csv");
    assert.equal(leido.error, null, `el CSV ${i + 1} no parsea: ${leido.error}`);
    const { error } = validateDeck(leido.cards);
    assert.equal(error, null, `el CSV ${i + 1} lo rechaza el servidor: ${error}`);
  }
});

test("las reglas duras que promete el documento rechazan de verdad", () => {
  const reglas = [
    [{ cards: [] }, /vacío/i],
    [[], /vacío/i],
    [[{ options: ["a", "b"], answer: 0 }], /sin pregunta/i],
    [[carta({ options: ["a"] })], /entre 2 y 6/i],
    [[carta({ options: "abcdefg".split("") })], /entre 2 y 6/i],
    [[carta({ options: ["a", " "] })], /opción vacía/i],
    [[carta({ options: ["a", "a"] })], /repite opciones/i],
    [[carta({ options: ["a", " a "] })], /repite opciones/i],
    [[carta({ answer: 1.5 })], /fuera de rango/i],
    [[carta({ answer: -1 })], /fuera de rango/i],
    [[carta({ answer: 2 })], /fuera de rango/i],
    [[carta({ answer: "uno" })], /fuera de rango/i],
    [Array.from({ length: 101 }, () => carta()), /máximo es 100/i],
  ];
  for (const [mazo, patron] of reglas) {
    const { error } = validateDeck(mazo);
    assert.match(error ?? "", patron, `el documento promete un rechazo que no ocurre: ${error}`);
  }
});

test("la tabla de límites menciona los valores que están en el código", () => {
  for (const valor of [
    GAME_CONFIG.maxTitleLength, GAME_CONFIG.maxPromptLength, GAME_CONFIG.maxOptionLength,
    GAME_CONFIG.maxCards, GAME_CONFIG.minOptions, GAME_CONFIG.maxOptions, 400,
  ]) {
    assert.ok(md.includes(String(valor)), `el documento no menciona el límite ${valor}`);
  }
});

test("los comportamientos raros que promete el documento son los del servidor", () => {
  // Recorte silencioso de una opción larga.
  const recorte = validateDeck([carta({ options: ["x".repeat(300), "y"], answer: 0 })]);
  assert.equal(recorte.error, null);
  assert.equal(recorte.cards[0].options[0].length, GAME_CONFIG.maxOptionLength);

  // Aplanado de espacios, tabs y saltos de línea.
  const aplanado = validateDeck([carta({ prompt: "primera\nsegunda\ttercera" })]);
  assert.equal(aplanado.cards[0].prompt, "primera segunda tercera");

  // Título ausente y título largo.
  assert.equal(validateDeckTitle(""), "Mazo sin título");
  assert.equal(validateDeckTitle("x".repeat(100)).length, GAME_CONFIG.maxTitleLength);
});
