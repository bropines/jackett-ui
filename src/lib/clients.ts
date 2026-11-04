/** Ready-to-paste settings for external clients (qBittorrent's Jackett plugin, Torznab / *arr). */
import { torznabUrl } from "@/api";

/** Jackett plugin config for qBittorrent's search engine (nova3/engines/jackett.json). */
export function qbitPluginJson(url: string, apiKey: string): string {
  return JSON.stringify({ api_key: apiKey, thread_count: 20, tracker_first: false, url }, null, 4);
}

/** Torznab feed template: `{id}` = tracker id (or `all` for every tracker). */
export function torznabTemplate(origin = window.location.origin): string {
  return torznabUrl("{id}", origin).replace(encodeURIComponent("{id}"), "{id}");
}

/** Torznab feed URL with the token in the query (for clients that take one URL). */
export function torznabUrlWithKey(indexerId: string, token: string, origin = window.location.origin): string {
  return `${torznabUrl(indexerId, origin)}?apikey=${encodeURIComponent(token)}`;
}
