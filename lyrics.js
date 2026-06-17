// Lyrics corpus and artist registry. Source of truth lives in db.json so
// scripts/ingest.rb can extend it without touching code.
//
// ARTISTS shape:
//   id          — stable kebab-case slug, never changes
//   displayName — what the UI shows (preferred alias / common name)
//   aliases     — every form the band is also known by; used by the
//                 Ruby ingest script to resolve band headers in the
//                 input txt to a canonical id
//
// SONGS shape:
//   id           — stable kebab-case slug
//   artistId     — references ARTISTS.id
//   song         — canonical song title (clean, no "(feat.)" suffix)
//   album        — canonical album title (empty if unknown)
//   year         — release year (null if unknown)
//   songAliases  — alternative spellings/forms; alias matcher is
//                  diacritic-tolerant and accepts substrings already
//   albumAliases — same, for the album
//   fragments    — list of multi-line excerpts the game samples from

const ARTIST_CHOICE_LIMIT = 4;

const db = await fetch('./db.json', { cache: 'no-cache' }).then((r) => r.json());

export const ARTISTS = db.artists;
export const SONGS   = db.songs;


// ── Lookups ──────────────────────────────────────────────────────
export const findArtist = (id) => ARTISTS.find((a) => a.id === id);
export const findSong   = (id) => SONGS.find((s) => s.id === id);
export const artistOf   = (songId) => findArtist(findSong(songId).artistId);

// Artists that have at least one song with at least one fragment. The
// ARTISTS registry can contain entries we don't have material for yet (the
// ingest pipeline references all of them); the playable subset is what the
// game offers as suspects.
const PLAYABLE_IDS = new Set(
  SONGS
    .filter((s) => s.fragments && s.fragments.length > 0)
    .map((s) => s.artistId),
);
export const playableArtists = () => ARTISTS.filter((a) => PLAYABLE_IDS.has(a.id));

// ── Normalization + matching ─────────────────────────────────────
//
// Normalization (case-insensitive + diacritic-coalesced) is the floor
// every comparison rests on: `é`/`E`/`e` all collapse to `e`, punctuation
// becomes whitespace, multiple spaces collapse. Built on top of that,
// `matches()` is intentionally lenient — five-second timer, no autocomplete,
// no hint — so it accepts four flavors of "close enough":
//
//   1. Exact (after norm).
//   2. Substring either way, with length floors so two-letter slivers
//      like "el" don't sneak through against a 20-char album title.
//   3. Token-set: every guess word is a whole-word match somewhere in
//      the canonical. Handles word reorder ("Mí Para Eres") and dropped
//      stop-words ("Limon Sal" vs "Limón y Sal"). Requires at least one
//      substantial (≥4 chars) token so "el del" can't pass.
//   4. Edit distance for typos: "Money" → "Monei", "Trinkeras" → "Trincheras".
//      Allowance scales with the shorter string's length.

const norm = (s) =>
  (s ?? '')
    .toString()
    .toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[.,;:!?¡¿"'’‘“”\-_/\\()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const tokens = (s) => s.split(' ').filter(Boolean);

// Two-row Levenshtein. O(m*n) time, O(n) space — fine for titles.
const levenshtein = (a, b) => {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    const tmp = prev; prev = curr; curr = tmp;
  }
  return prev[n];
};

const matches = (guess, canonical, aliases) => {
  const g = norm(guess);
  if (g.length < 2) return false;
  const gTokens = tokens(g);
  const gCharBudget = gTokens.reduce((sum, t) => sum + t.length, 0);
  const hasSubstantialToken = gTokens.some((t) => t.length >= 4);

  const candidates = [canonical, ...aliases].map(norm).filter(Boolean);
  for (const c of candidates) {
    // 1. Exact (post-norm).
    if (c === g) return true;

    // 2. Substring either way. The guess→canonical floor is the looser
    //    of "3 chars" or "a third of the canonical" so that long titles
    //    can be matched by a meaningful chunk ("vals del obrero") but
    //    stop-word substrings don't pass.
    if (c.includes(g) && g.length >= Math.max(3, Math.ceil(c.length / 3))) return true;
    if (g.includes(c) && c.length >= 4) return true;

    // 3. Token-set: every guess word must appear as a whole word in the
    //    canonical, and the guess must carry at least one ≥4-char token
    //    so single stop-words can't drag a match in.
    const cTokens = new Set(tokens(c));
    if (gTokens.length >= 1
        && gCharBudget >= 4
        && hasSubstantialToken
        && gTokens.every((t) => t.length >= 2 && cTokens.has(t))) return true;

    // 4. Edit distance for typo tolerance, only when the two strings are
    //    a similar length to begin with (otherwise it's no longer a typo).
    const minLen = Math.min(c.length, g.length);
    if (minLen >= 4 && Math.abs(c.length - g.length) <= Math.ceil(minLen / 3)) {
      const allowance = Math.max(1, Math.floor(minLen / 4));
      if (levenshtein(g, c) <= allowance) return true;
    }
  }
  return false;
};

// Returns 'song' | 'album' | null. The user types one thing; either match
// earns the bonus, with the matched kind reported for the reveal panel.
export const checkBonus = (guess, song) => {
  if (matches(guess, song.song,  song.songAliases))  return 'song';
  if (matches(guess, song.album, song.albumAliases)) return 'album';
  return null;
};

// ── Seeded RNG ───────────────────────────────────────────────────
// Mulberry32 — small 32-bit PRNG. Used by the daily challenge so the
// piece sequence is deterministic per-date and reproducible across
// reloads. fnvHash gives us a 32-bit seed from an arbitrary string.

export const fnvHash = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
};

export const mulberry32 = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// ── Sampling ─────────────────────────────────────────────────────
const shuffle = (a, rng = Math.random) => {
  const r = a.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
};

// Build {songId, fragmentId} pairs from SONGS — optionally restricted to a
// subset of artist ids. Passing `null` or omitting returns every pair.
const allPairs = (allowedArtistIds = null) => {
  const ok = allowedArtistIds ? new Set(allowedArtistIds) : null;
  const out = [];
  for (const s of SONGS) {
    if (ok && !ok.has(s.artistId)) continue;
    for (let i = 0; i < s.fragments.length; i++) {
      out.push({ songId: s.id, fragmentId: i });
    }
  }
  return out;
};

export const pickFragment = (seenKeys = [], allowedArtistIds = null, rng = Math.random) => {
  const all = allPairs(allowedArtistIds);
  if (all.length === 0) return null;
  let available = all.filter((p) => !seenKeys.includes(`${p.songId}:${p.fragmentId}`));
  if (available.length === 0) available = all;
  const pick = available[Math.floor(rng() * available.length)];
  const song = SONGS.find((s) => s.id === pick.songId);
  return {
    songId: song.id,
    fragmentId: pick.fragmentId,
    fragment: song.fragments[pick.fragmentId],
  };
};

// For a piece, decide which artist chips to show. Below the threshold,
// every selected artist appears in shuffled order; above it, the correct
// artist plus a random sample of selected decoys, also shuffled.
// `allowedArtistIds` should always contain `correctArtistId`.
export const pickArtistChoices = (correctArtistId, allowedArtistIds = null, rng = Math.random) => {
  const pool = allowedArtistIds
    ? ARTISTS.filter((a) => allowedArtistIds.includes(a.id))
    : ARTISTS;
  if (pool.length <= ARTIST_CHOICE_LIMIT) {
    return shuffle(pool, rng).map((a) => a.id);
  }
  const correct = findArtist(correctArtistId);
  const others  = pool.filter((a) => a.id !== correctArtistId);
  const picks   = [correct, ...shuffle(others, rng).slice(0, ARTIST_CHOICE_LIMIT - 1)];
  return shuffle(picks, rng).map((a) => a.id);
};
