/** Same rule as the server: file name = id. */
export const DEFINITION_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function validDefinitionId(id: string): boolean {
  return DEFINITION_ID_RE.test(id);
}

/** Top-level `key: value` of a Cardigann YAML (no YAML parser needed for id/name). */
export function topLevel(content: string, key: string): string | null {
  for (const line of content.split(/\r?\n/)) {
    if (!line || line[0] === " " || line[0] === "\t" || line[0] === "#") continue;
    const i = line.indexOf(":");
    if (i <= 0 || line.slice(0, i) !== key) continue;
    let v = line.slice(i + 1).trim();
    const c = v.indexOf(" #");
    if (c >= 0) v = v.slice(0, c).trim();
    return v.replace(/^["']|["']$/g, "");
  }
  return null;
}

/** Problems the server would reject, checked before saving (Russian, short). */
export function definitionProblems(id: string, content: string): string[] {
  const out: string[] = [];
  const fileId = topLevel(content, "id");
  if (!fileId) out.push("Нет строки id: на верхнем уровне");
  else if (fileId !== id) out.push(`id в файле (${fileId}) должен совпадать с именем (${id})`);
  if (!topLevel(content, "name")) out.push("Нет строки name: на верхнем уровне");
  if (topLevel(content, "links") === null) out.push("Нет раздела links: (адреса трекера)");
  if (new Blob([content]).size > 256 * 1024) out.push("Файл больше 256 КБ");
  return out;
}

/** A small public-tracker definition to start from. */
export function definitionTemplate(id: string): string {
  return `---
id: ${id}
name: ${id}
description: "Мой трекер"
language: ru-RU
type: public
encoding: UTF-8
links:
  - https://example.org/

caps:
  categorymappings:
    - {id: 1, cat: Movies, desc: "Фильмы"}
    - {id: 2, cat: TV, desc: "Сериалы"}
  modes:
    search: [q]

settings: []

search:
  paths:
    - path: "search?q={{ .Keywords }}"
  rows:
    selector: table.results > tbody > tr
  fields:
    category:
      text: 1
    title:
      selector: td.title a
    details:
      selector: td.title a
      attribute: href
    download:
      selector: a.download
      attribute: href
    size:
      selector: td.size
    seeders:
      selector: td.seeders
    leechers:
      selector: td.leechers
    date:
      text: now
`;
}

export const DEFINITION_DOCS_URL = "https://github.com/Jackett/Jackett/wiki/Definition-format";
export const DEFINITION_EXAMPLES_URL = "https://github.com/Jackett/Jackett/tree/master/src/Jackett.Common/Definitions";
