import { spotifyGet } from './client.js';

/** Normalized playlist metadata captured in meta.json. */
export interface PlaylistMeta {
  id: string;
  name: string;
  description: string;
  owner: string;
}

/**
 * A single track row as captured in playlist.jsonl.
 * Raw Spotify fields, order-preserved. Locally-added tracks / episodes may
 * carry null id/uri/name — captured faithfully (D002 defers the stable track
 * key to S02, so no synthetic identifier is invented here).
 */
export interface TrackRecord {
  id: string | null;
  uri: string | null;
  name: string | null;
  artists: string[];
  album: string | null;
  duration_ms: number | null;
}

interface RawPlaylist {
  id: string;
  name: string;
  description: string | null;
  owner: { display_name?: string | null; id: string } | null;
}

interface RawTrack {
  id: string | null;
  uri: string | null;
  name: string | null;
  artists: Array<{ name: string }> | null;
  album: { name: string } | null;
  duration_ms: number | null;
}

interface RawTracksPage {
  // Spotify's Feb 2026 Web API migration renamed the playlist track resource
  // /tracks → /items and the per-row wrapper key `track` → `item`. Dev-mode
  // apps get 403 on the old /tracks path, so both must use the new names.
  items: Array<{ item: RawTrack | null } | null>;
  next: string | null;
}

// `fields` mask pinned to exactly what serialize.ts persists — trims payload
// and prevents unrelated API additions from leaking into the snapshot.
// Post-migration wrapper key is `item` (was `track`).
const TRACK_FIELDS = 'items(item(id,uri,name,artists(name),album(name),duration_ms)),next';

/** Fetch playlist-level metadata (name, id, description, owner). */
export async function getPlaylist(id: string): Promise<PlaylistMeta> {
  const raw = await spotifyGet<RawPlaylist>(
    `/playlists/${encodeURIComponent(id)}?fields=id,name,description,owner(display_name,id)`,
  );
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description ?? '',
    owner: raw.owner?.display_name ?? raw.owner?.id ?? '',
  };
}

/**
 * Fetch every track in a playlist, following pagination to exhaustion.
 * Starts at limit=100 and follows the `next` URL until it is null, so
 * playlists larger than one page are never silently truncated (Q5).
 * Returns rows in playlist order.
 */
export async function getPlaylistTracks(id: string): Promise<TrackRecord[]> {
  const records: TrackRecord[] = [];
  let url: string | null =
    `/playlists/${encodeURIComponent(id)}/items?limit=100&fields=${encodeURIComponent(TRACK_FIELDS)}`;
  let page = 0;
  while (url) {
    const data: RawTracksPage = await spotifyGet<RawTracksPage>(url);
    for (const entry of data.items ?? []) {
      const track = entry?.item;
      if (!track) continue; // fully-unavailable/removed rows collapse to null
      records.push(normalizeTrack(track));
    }
    page += 1;
    console.log(`  fetched page ${page} (${records.length} tracks so far)…`);
    url = data.next;
  }
  return records;
}

function normalizeTrack(track: RawTrack): TrackRecord {
  return {
    id: track.id ?? null,
    uri: track.uri ?? null,
    name: track.name ?? null,
    artists: (track.artists ?? []).map((a) => a.name),
    album: track.album?.name ?? null,
    duration_ms: track.duration_ms ?? null,
  };
}
