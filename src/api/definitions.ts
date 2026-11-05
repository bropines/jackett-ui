import { uiCall } from "@/api/server";

/** One file in Jackett's custom definitions folder (`GET /_ui/api/definitions`). */
export interface Definition {
  id: string;
  name: string;
  file: string;
  size: number;
  modifiedAt: string;
  /** Set when the file doesn't look like a definition the panel can manage. */
  problem?: string;
}

export interface DefinitionsList {
  available: boolean;
  dir: string;
  reason?: string;
  items: Definition[];
}

export interface DefinitionFile {
  definition: Definition;
  content: string;
}

export interface ReloadResult {
  ok: boolean;
  /** Jackett log lines about definitions written during the reload. */
  messages: string[];
}

const enc = encodeURIComponent;

export const definitionsApi = {
  list: () => uiCall<DefinitionsList>("/definitions"),
  get: (id: string) => uiCall<DefinitionFile>(`/definitions/${enc(id)}`),
  save: (id: string, content: string) =>
    uiCall<Definition>(`/definitions/${enc(id)}`, { method: "PUT", body: JSON.stringify({ content }) }),
  remove: (id: string) => uiCall<void>(`/definitions/${enc(id)}`, { method: "DELETE" }),
  /** Makes Jackett restart its web host and read the definitions again (a few seconds). */
  reload: () => uiCall<ReloadResult>("/definitions/reload", { method: "POST" }),
};

export const definitionsKeys = {
  list: ["definitions"] as const,
  file: (id: string) => ["definitions", id] as const,
};
