import type { Card } from "@dungeon/shared";

/** Lo que produce el parser: el id lo asigna el servidor al validar. */
export type DeckCard = Omit<Card, "id">;
type DeckError = { title: string; cards: []; error: string };
type Draft = { title: string; cards: DeckCard[] } | DeckError;
export type DeckResult = { title: string; cards: DeckCard[]; error: null } | DeckError;

const fail = (error: string): DeckError => ({ title: "", cards: [], error });

/** CSV estilo RFC 4180: las comillas dobles encierran comas y saltos de línea, y "" escapa una comilla. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\r") continue;
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const COLUMN_ALIASES: Record<string, string> = {
  pregunta: "prompt", prompt: "prompt", question: "prompt",
  opciones: "options", options: "options",
  respuesta: "answer", answer: "answer", correcta: "answer", correct: "answer",
  explicacion: "explanation", explanation: "explanation",
  titulo: "title", title: "title",
};

const splitOptions = (cell: string) => cell.split("|").map((o) => o.trim()).filter(Boolean);

function cardsFromCsv(text: string, fallbackTitle: string): Draft {
  const rows = parseCsvRows(text);
  if (rows.length < 2) return fail("El CSV necesita una fila de encabezado y al menos una pregunta.");

  const header = rows[0].map((c) => COLUMN_ALIASES[c.trim().toLowerCase()] ?? "");
  const hasHeader = header.includes("prompt") && header.includes("options") && header.includes("answer");
  const col = hasHeader
    ? Object.fromEntries(header.map((name, i) => [name, i]).filter(([name]) => name))
    : { title: 0, prompt: 1, options: 2, answer: 3, explanation: 4 };
  const body = hasHeader ? rows.slice(1) : rows;
  const get = (row: string[], name: string) => row[col[name] ?? -1] ?? "";

  const cards = body.map((row) => ({
    prompt: get(row, "prompt"),
    options: splitOptions(get(row, "options")),
    answer: Number(get(row, "answer")),
    explanation: get(row, "explanation"),
  }));

  // El título va en la columna `titulo`/`title` de la *primera carta*: leerlo de
  // la fila de encabezado devolvería literalmente la palabra "titulo".
  const title = get(body[0], "title") || fallbackTitle;
  return { title: title.trim(), cards };
}

function cardsFromJson(text: string, fallbackTitle: string): Draft {
  let data: unknown;
  try { data = JSON.parse(text); }
  catch { return fail("El JSON no se pudo leer. Revisá que sea un JSON válido."); }

  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  const list = Array.isArray(data) ? data : record?.cards ?? record?.questions ?? record?.preguntas;
  if (!Array.isArray(list)) return fail("El JSON tiene que ser una lista de preguntas o un objeto con una lista en \"cards\".");
  if (!list.length) return fail("El JSON no tiene ninguna pregunta.");

  const title = record?.title ? String(record.title) : fallbackTitle;
  return { title: title.trim(), cards: list as DeckCard[] };
}

export function parseDeckText(text: string, fileName: string): DeckResult {
  const fallbackTitle = fileName.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim() || "Mazo";
  const draft = /\.json$/i.test(fileName) ? cardsFromJson(text, fallbackTitle) : cardsFromCsv(text, fallbackTitle);
  if ("error" in draft) return draft;
  if (!draft.cards.length) return fail("El archivo no tiene preguntas.");
  return { title: draft.title, cards: draft.cards, error: null };
}

export async function parseDeckFile(file: File): Promise<DeckResult> {
  if (file.size > 2 * 1024 * 1024) return fail("El archivo pesa más de 2 MB. Subí un mazo más chico.");
  if (!/\.(json|csv|txt)$/i.test(file.name)) return fail("Solo se admiten archivos .json o .csv.");
  return parseDeckText(await file.text(), file.name);
}

export const CSV_EXAMPLE = `pregunta,opciones,respuesta,explicacion
"¿Cuál es la capital de Francia?",París|Londres|Berlín|Roma,0,"París es la capital desde el siglo IX."
"¿Qué gas respiran las plantas?",Oxígeno|Dióxido de carbono|Nitrógeno|Helio,1,"Las plantas liberan oxígeno al fotosintetizar."`;

export const JSON_EXAMPLE = `{
  "title": "Biología 1°",
  "cards": [
    { "prompt": "¿Cuál es la capital de Francia?", "options": ["París", "Londres", "Berlín", "Roma"], "answer": 0, "explanation": "París es la capital desde el siglo IX." }
  ]
}`;
