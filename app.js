import { store } from './store.js';
import {
  ARTISTS, SONGS, pickFragment, pickArtistChoices,
  findArtist, findSong, artistOf, playableArtists,
  mulberry32, fnvHash,
} from './lyrics.js';

const root = document.getElementById('view');

// ── SW cache version ─────────────────────────────────────────────
let cacheVersion = '';
const readCacheVersion = async () => {
  if (!('caches' in self)) return '';
  try {
    const keys = await caches.keys();
    const match = keys.find((k) => k.startsWith('lyrics-'));
    return match ? match.slice('lyrics-'.length) : '';
  } catch {
    return '';
  }
};

// ── Animation-once gate ──────────────────────────────────────────
// CSS entry animations are declared with `.is-animate` so a re-render
// alone does not replay them. Cleared on game start so a fresh round
// can animate again. See: pwa-gotchas/reference/render-restarts-animation.md
const animated = new Set();
const onceClass = (key, cls) => {
  if (animated.has(key)) return '';
  animated.add(key);
  return ' ' + cls;
};

// ── UI panel toggles (module-level, not store) ───────────────────
// Mirrors the `animated` Set pattern. Reset on any lifecycle change
// that leaves the screen owning the panel.
let compositeOpen = false;
let sheetOpen = false;

const toggleComposite = () => {
  compositeOpen = !compositeOpen;
  render(store.state);
};
const resetCompositeUI = () => {
  compositeOpen = false;
  animated.delete('composite:open');
};

const openSheet = () => { sheetOpen = true; animated.delete('sheet:open'); render(store.state); };
const closeSheet = () => { sheetOpen = false; render(store.state); };
const resetSheetUI = () => { sheetOpen = false; animated.delete('sheet:open'); };

// ── DOM helper ───────────────────────────────────────────────────
// Tiny createElement wrapper. Children appended as text nodes or Nodes —
// never as HTML strings — so user-supplied strings can't inject markup.
const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k in el && typeof v !== 'string') {
      el[k] = v;
    } else {
      el.setAttribute(k, v);
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
};

// ── Formatting ───────────────────────────────────────────────────
const fmtN = (n) => String(n).padStart(2, '0');

const fmtTime = (ms) => {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

const dateKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const WEEKDAYS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

const sameDay = (a, b) =>
  a.getFullYear() === b.getFullYear()
  && a.getMonth() === b.getMonth()
  && a.getDate() === b.getDate();

const fmtRelative = (ms) => {
  const now = Date.now();
  const diffSec = (now - ms) / 1000;
  if (diffSec < 60) return 'ahora';
  if (diffSec < 3600) return `hace ${Math.max(1, Math.round(diffSec / 60))} min`;
  const a = new Date(ms);
  const b = new Date(now);
  if (sameDay(a, b)) {
    return `hoy · ${String(a.getHours()).padStart(2, '0')}:${String(a.getMinutes()).padStart(2, '0')}`;
  }
  const yesterday = new Date(b); yesterday.setDate(b.getDate() - 1);
  if (sameDay(a, yesterday)) return 'ayer';
  if (now - ms < 7 * 24 * 3600 * 1000) return WEEKDAYS_ES[a.getDay()];
  return `${String(a.getDate()).padStart(2, '0')}/${String(a.getMonth() + 1).padStart(2, '0')}`;
};

// ── Stage timer ──────────────────────────────────────────────────
let activeTimeoutId = null;
const cancelTimer = () => {
  if (activeTimeoutId !== null) {
    clearTimeout(activeTimeoutId);
    activeTimeoutId = null;
  }
};
const armTimer = (onExpire, ms) => {
  cancelTimer();
  activeTimeoutId = setTimeout(() => {
    activeTimeoutId = null;
    onExpire();
  }, ms);
  return Date.now() + ms;
};
const remainingSec = (deadlineAt) =>
  deadlineAt ? Math.max(0, Math.ceil((deadlineAt - Date.now()) / 1000)) : null;

// Daily mode forces a fixed timer + full roster, independent of prefs.
const DAILY_TURN_SEC = 10;
const effectiveTurnSec = () =>
  store.state.playMode === 'daily' ? DAILY_TURN_SEC : store.state.prefs.turnSec;
const effectiveArtistIds = () =>
  store.state.playMode === 'daily' ? ARTISTS.map((a) => a.id) : store.state.prefs.artistIds;

// ── Daily RNG ────────────────────────────────────────────────────
// Each round draws from a fresh RNG seeded with (dailySeed, roundIdx), so
// the piece sequence survives reload — we can rebuild any round from the
// persisted (dailySeed, pieces.length) pair.
const dailyRngForRound = (seed, roundIdx) =>
  mulberry32((seed ^ ((roundIdx + 1) * 0x9E3779B9)) >>> 0);

const seedForToday = () => fnvHash(dateKey());

// ── Personal best ────────────────────────────────────────────────
// PB at the moment a fresh game started, so the HUD ghost doesn't shift
// mid-game. Recomputed on game start and on hydrate-mid-game.
let pbAtGameStart = 0;
const personalBest = (record) =>
  record.length ? Math.max(...record.map((r) => r.score)) : 0;

// ── Flash + lifecycle ────────────────────────────────────────────
const FLASH_OK_MS  = 420;
const FLASH_BAD_MS = 900;

const backToIntro = () => {
  cancelTimer();
  resetCompositeUI();
  resetSheetUI();
  store.setLifecycle({ screen: 'intro', playMode: 'normal', dailySeed: null });
};

const toggleArtist = (artistId) => {
  const set = new Set(store.state.prefs.artistIds);
  if (set.has(artistId)) set.delete(artistId);
  else set.add(artistId);
  if (set.size < 2) return;
  store.setLifecycle({ prefs: { ...store.state.prefs, artistIds: [...set] } });
};

const setTurnSec = (sec) => {
  if (sec === store.state.prefs.turnSec) return;
  store.setLifecycle({ prefs: { ...store.state.prefs, turnSec: sec } });
};

const startGame = () => {
  animated.clear();
  resetCompositeUI();
  resetSheetUI();
  pbAtGameStart = personalBest(store.state.record);
  const { prefs } = store.state;
  const piece = pickFragment([], prefs.artistIds);
  if (!piece) return;
  const correct = findSong(piece.songId).artistId;
  const deadlineAt = prefs.turnSec > 0
    ? armTimer(timeoutArtist, prefs.turnSec * 1000)
    : null;
  store.setLifecycle({
    screen: 'playing',
    stage: 'artist',
    score: 0,
    pieces: [],
    seenKeys: [`${piece.songId}:${piece.fragmentId}`],
    currentPiece: piece,
    choices: pickArtistChoices(correct, prefs.artistIds),
    pickedArtistId: null,
    revealed: null,
    flash: null,
    roundStartedAt: Date.now(),
    deadlineAt,
    playMode: 'normal',
    dailySeed: null,
  });
};

const startDaily = () => {
  animated.clear();
  resetCompositeUI();
  resetSheetUI();
  pbAtGameStart = personalBest(store.state.record);
  const dailySeed = seedForToday();
  const rng = dailyRngForRound(dailySeed, 0);
  const roster = ARTISTS.map((a) => a.id);
  const piece = pickFragment([], roster, rng);
  if (!piece) return;
  const correct = findSong(piece.songId).artistId;
  const choices = pickArtistChoices(correct, roster, rng);
  const deadlineAt = armTimer(timeoutArtist, DAILY_TURN_SEC * 1000);
  store.setLifecycle({
    screen: 'playing',
    stage: 'artist',
    score: 0,
    pieces: [],
    seenKeys: [`${piece.songId}:${piece.fragmentId}`],
    currentPiece: piece,
    choices,
    pickedArtistId: null,
    revealed: null,
    flash: null,
    roundStartedAt: Date.now(),
    deadlineAt,
    playMode: 'daily',
    dailySeed,
  });
};

const nextRound = () => {
  const { seenKeys, playMode, dailySeed, pieces } = store.state;
  const allowed = effectiveArtistIds();
  const turnSec = effectiveTurnSec();
  const rng = (playMode === 'daily' && dailySeed != null)
    ? dailyRngForRound(dailySeed, pieces.length)
    : Math.random;
  const piece = pickFragment(seenKeys, allowed, rng);
  if (!piece) { endGame(); return; }
  const key = `${piece.songId}:${piece.fragmentId}`;
  const newSeen = seenKeys.includes(key) ? seenKeys : [...seenKeys, key];
  const correct = findSong(piece.songId).artistId;
  const choices = pickArtistChoices(correct, allowed, rng);
  const deadlineAt = turnSec > 0 ? armTimer(timeoutArtist, turnSec * 1000) : null;
  store.setLifecycle({
    stage: 'artist',
    currentPiece: piece,
    choices,
    pickedArtistId: null,
    revealed: null,
    flash: null,
    seenKeys: newSeen,
    roundStartedAt: Date.now(),
    deadlineAt,
  });
};

const pickArtist = (artistId) => {
  if (store.state.flash) return;
  cancelTimer();
  const { currentPiece, roundStartedAt } = store.state;
  const song = findSong(currentPiece.songId);
  const ok = artistId === song.artistId;
  const elapsedMs = roundStartedAt ? Date.now() - roundStartedAt : 0;
  store.setLifecycle({
    pickedArtistId: artistId,
    deadlineAt: null,
    flash: { ok, pickedArtistId: artistId, correctArtistId: song.artistId, timedOut: false },
    score: ok ? store.state.score + 1 : store.state.score,
    pieces: [...store.state.pieces, {
      songId: currentPiece.songId,
      fragmentId: currentPiece.fragmentId,
      pickedArtistId: artistId,
      artistOk: ok,
      timedOut: false,
      elapsedMs,
    }],
  });
  setTimeout(ok ? nextRound : endGame, ok ? FLASH_OK_MS : FLASH_BAD_MS);
};

const timeoutArtist = () => {
  if (store.state.screen !== 'playing' || store.state.flash) return;
  const { currentPiece, roundStartedAt } = store.state;
  const song = findSong(currentPiece.songId);
  const elapsedMs = roundStartedAt ? Date.now() - roundStartedAt : 0;
  store.setLifecycle({
    pickedArtistId: null,
    deadlineAt: null,
    flash: { ok: false, pickedArtistId: null, correctArtistId: song.artistId, timedOut: true },
    pieces: [...store.state.pieces, {
      songId: currentPiece.songId,
      fragmentId: currentPiece.fragmentId,
      pickedArtistId: null,
      artistOk: false,
      timedOut: true,
      elapsedMs,
    }],
  });
  setTimeout(endGame, FLASH_BAD_MS);
};

const MAX_RECORD = 500;

const endGame = () => {
  cancelTimer();
  const { pieces, score, playMode, dailyResults, record } = store.state;
  const played = pieces.length;
  const totalMs = pieces.reduce((a, p) => a + (p.elapsedMs || 0), 0);
  const entry = { score, played, totalMs, when: Date.now() };
  const newRecord = [...record, entry].slice(-MAX_RECORD);

  let newDailyResults = dailyResults;
  if (playMode === 'daily' && played > 0) {
    const k = dateKey();
    const prev = dailyResults[k];
    const better = !prev
      || score > prev.score
      || (score === prev.score && totalMs < prev.totalMs);
    if (better) newDailyResults = { ...dailyResults, [k]: entry };
  }

  store.setLifecycle({
    screen: 'final',
    flash: null,
    record: newRecord,
    dailyResults: newDailyResults,
    deadlineAt: null,
  });
};

const restart = () => {
  if (store.state.playMode === 'daily') startDaily();
  else startGame();
};

// ── Top-level view ───────────────────────────────────────────────
const view = (state) => {
  if (state.screen === 'final')   return Final(state);
  if (state.screen === 'playing') return Playing(state);
  return Inicio(state);
};

const Masthead = () =>
  h('header', { class: 'masthead' },
    h('span', { class: 'masthead__title' }, 'Lyric Hunt'),
    h('span', { class: 'masthead__meta' }, cacheVersion || '42.uy / lyrics'),
  );

// ── Inicio (start screen) ────────────────────────────────────────
const Inicio = (state) => {
  const playable = new Set(playableArtists().map((a) => a.id));
  const selectedPlayable = state.prefs.artistIds.filter((id) => playable.has(id));
  const canStart = state.prefs.artistIds.length >= 2 && selectedPlayable.length >= 1;
  const todayDaily = state.dailyResults?.[dateKey()] ?? null;
  return h('div', { class: 'inicio' + onceClass('inicio', 'is-animate') },
    Masthead(),
    Hero(),
    TimePicker(state.prefs.turnSec),
    LineupRow(state.prefs.artistIds),
    Actions(canStart, todayDaily),
    RecentRuns(state.record),
    Catalogue(),
    sheetOpen ? ArtistSheet(state) : null,
  );
};

const Hero = () =>
  h('div', { class: 'inicio__hero' },
    h('h1', { class: 'inicio__title' }, 'Lyric Hunt'),
    h('p', { class: 'inicio__deck' }, 'adiviná de quién es el verso.'),
  );

const TimeChip = (sec, current) => {
  const isOn = sec === current;
  const isInf = sec === 0;
  return h('button', {
    class: 'time-picker__opt' + (isOn ? ' is-on' : '') + (isInf ? ' is-inf' : ''),
    type: 'button',
    'aria-pressed': isOn ? 'true' : 'false',
    'aria-label': isInf ? 'sin tiempo' : `${sec} segundos`,
    onclick: () => setTurnSec(sec),
  }, isInf ? '∞' : `${fmtN(sec)}s`);
};

const TimePicker = (turnSec) =>
  h('section', { class: 'inicio__section' },
    h('div', { class: 'inicio__label' }, 'tiempo'),
    h('div', { class: 'time-picker' },
      TimeChip(8, turnSec),
      TimeChip(10, turnSec),
      TimeChip(12, turnSec),
      TimeChip(0, turnSec),
    ),
  );

const LineupRow = (artistIds) => {
  const playable = playableArtists();
  const playableSet = new Set(playable.map((a) => a.id));
  const selected = artistIds.filter((id) => playableSet.has(id)).length;
  return h('section', { class: 'inicio__section' },
    h('div', { class: 'inicio__label' }, 'artistas'),
    h('button', {
      class: 'lineup-row',
      type: 'button',
      onclick: openSheet,
    },
      h('span', { class: 'lineup-row__count' }, `${selected} / ${playable.length}`),
      h('span', { class: 'lineup-row__cta' }, 'cambiar →'),
    ),
  );
};

const Actions = (canStart, todayDaily) =>
  h('section', { class: 'inicio__actions' },
    h('button', {
      class: 'btn btn--primary inicio__play',
      type: 'button',
      disabled: !canStart,
      onclick: startGame,
    }, 'Jugar →'),
    !canStart
      ? h('div', { class: 'inicio__hint' }, 'Mínimo dos artistas.')
      : null,
    todayDaily
      ? h('div', { class: 'daily-row daily-row--done' },
          h('span', { class: 'daily-row__label' }, 'reto del día ✓'),
          h('span', { class: 'daily-row__stat' }, `★ ${todayDaily.score}`),
          h('span', { class: 'daily-row__stat' }, fmtTime(todayDaily.totalMs ?? 0)),
          h('button', {
            class: 'daily-row__again',
            type: 'button',
            onclick: startDaily,
          }, 'otra vez →'),
        )
      : h('button', {
          class: 'btn btn--ghost inicio__daily',
          type: 'button',
          onclick: startDaily,
        }, 'Reto del día →'),
  );

const RecentRuns = (record) => {
  const recent = [...record].slice(-10).reverse();
  if (recent.length === 0) return null;
  const bestScore = Math.max(...record.map((r) => r.score));
  return h('section', { class: 'inicio__section' },
    h('div', { class: 'inicio__label' }, 'tus partidas'),
    h('ul', { class: 'recent-runs' },
      ...recent.map((r, i) =>
        h('li', {
          class: 'recent-runs__row'
            + (r.score === bestScore && bestScore > 0 ? ' is-best' : ''),
          style: `--i:${i}`,
        },
          h('span', { class: 'recent-runs__streak' },
            h('span', { class: 'recent-runs__star' }, '★'),
            h('span', { class: 'recent-runs__num' }, fmtN(r.score)),
          ),
          h('span', { class: 'recent-runs__time' }, fmtTime(r.totalMs ?? 0)),
          h('span', { class: 'recent-runs__when' }, fmtRelative(r.when)),
        )
      ),
    ),
  );
};

const Catalogue = () =>
  h('div', { class: 'catalogue' },
    `catálogo · ${ARTISTS.length} artistas · ${SONGS.length} canciones · ${SONGS.reduce((a, s) => a + (s.fragments?.length || 0), 0)} versos`,
  );

// ── Artist sheet (bottom sheet over Inicio) ──────────────────────
const ArtistSheet = (state) => {
  const lineup = ARTISTS;
  const lineupIds = new Set(lineup.map((a) => a.id));
  const selected = state.prefs.artistIds.filter((id) => lineupIds.has(id));
  const soleSelected = selected.length <= 2;
  return h('div', { class: 'sheet' + onceClass('sheet:open', 'is-animate') },
    h('div', { class: 'sheet__backdrop', onclick: closeSheet }),
    h('div', { class: 'sheet__panel' },
      h('div', { class: 'sheet__head' },
        h('span', { class: 'sheet__title' }, 'artistas'),
        h('span', { class: 'sheet__count' }, `${selected.length} / ${lineup.length}`),
        h('button', { class: 'sheet__close', type: 'button', onclick: closeSheet }, 'Listo'),
      ),
      h('div', { class: 'sheet__body' },
        h('div', { class: 'lineup' },
          ...lineup.map((a, i) => ArtistToggle(a, i, selected, soleSelected)),
        ),
        soleSelected
          ? h('div', { class: 'sheet__hint' }, 'Mínimo dos. El resto, vos elegís.')
          : null,
      ),
    ),
  );
};

const ArtistToggle = (artist, idx, selected, soleSelected) => {
  const isOn = selected.includes(artist.id);
  const songCount = SONGS.filter((s) => s.artistId === artist.id).length;
  const silent = songCount === 0;
  const disabled = isOn && soleSelected;
  return h('button', {
    class: 'lineup__card'
      + (isOn ? ' is-on' : '')
      + (disabled ? ' is-locked' : '')
      + (silent ? ' is-silent' : ''),
    type: 'button',
    style: `--i:${idx}`,
    'aria-pressed': isOn ? 'true' : 'false',
    onclick: disabled ? null : () => toggleArtist(artist.id),
  },
    h('span', { class: 'lineup__check', 'aria-hidden': 'true' }, isOn ? '✓' : ''),
    h('span', { class: 'lineup__body' },
      h('span', { class: 'lineup__name' }, artist.displayName),
      silent
        ? null
        : h('span', { class: 'lineup__meta' },
            `${songCount} canción${songCount === 1 ? '' : 'es'}`),
    ),
  );
};

// ── Shared: epigraph + word-by-word ──────────────────────────────
const renderLyric = (text, pieceKey) => {
  const lines = text.split('\n');
  let w = 0;
  const out = [];
  lines.forEach((line, li) => {
    const tokens = line.split(/(\s+)/);
    const lineChildren = tokens.map((tok) => {
      if (tok === '' || /^\s+$/.test(tok)) return tok;
      const idx = w++;
      return h('span', {
        class: 'word' + onceClass(`word:${pieceKey}:${li}:${idx}`, 'is-animate'),
        style: `--i:${idx}`,
      }, tok);
    });
    out.push(h('span', { class: 'epigraph__line' }, ...lineChildren));
    if (li < lines.length - 1) out.push(h('br'));
  });
  return out;
};

const Epigraph = (piece, pieceKey) =>
  h('blockquote', { class: 'epigraph' },
    h('p', { class: 'epigraph__quote' },
      ...renderLyric(piece.fragment, pieceKey)
    ),
  );

// Timer bar drained via CSS animation; ticker fine-tunes width via custom prop.
const TimerBar = (deadlineAt) => {
  const sec = effectiveTurnSec();
  if (sec === 0 || !deadlineAt) return null;
  const ms = sec * 1000;
  const elapsed = Math.max(0, ms - (deadlineAt - Date.now()));
  return h('div', { class: 'pieza__timer', 'aria-hidden': 'true' },
    h('div', {
      class: 'pieza__timer__fill',
      style: `--turn-ms:${ms}ms; --elapsed:${elapsed};`,
    }),
  );
};

const streakGhost = (current) => {
  if (pbAtGameStart <= 0) return null;
  if (current > pbAtGameStart) return '¡récord!';
  if (current === pbAtGameStart && current > 0) return '¡empate!';
  return `tu mejor ${pbAtGameStart}`;
};

const Pieza = (state) => {
  const timed = effectiveTurnSec() > 0;
  const sec = state.flash ? null : remainingSec(state.deadlineAt);
  const urgent = sec !== null && sec <= 2;
  const streak = state.score;
  const ghost = streakGhost(streak);
  const isDaily = state.playMode === 'daily';

  const clockBadge = state.flash
    ? h('span', { class: 'pieza__clock pieza__clock--paused' }, state.flash.ok ? '✓' : '✗')
    : timed
      ? h('span', {
          class: 'pieza__clock' + (urgent ? ' pieza__clock--urgent' : ''),
          'aria-label': 'Segundos restantes',
        }, `${sec}s`)
      : h('span', {
          class: 'pieza__clock pieza__clock--infinity',
          'aria-label': 'Sin tiempo',
        }, '∞');

  return h('div', { class: 'pieza-wrap' + (urgent ? ' is-urgent' : '') },
    h('div', { class: 'pieza' },
      h('div', { class: 'pieza__streak' },
        h('span', { class: 'pieza__streak__label' }, 'Racha'),
        h('em', { class: 'pieza__streak__num' + (streak >= 5 ? ' is-hot' : '') }, fmtN(streak)),
        ghost ? h('span', { class: 'pieza__streak__ghost' }, ghost) : null,
      ),
      h('div', { class: 'pieza__right' },
        isDaily ? h('span', { class: 'pieza__mode' }, 'reto') : null,
        clockBadge,
      ),
    ),
    timed && !state.flash
      ? h('div', { class: 'pieza__timeline' }, TimerBar(state.deadlineAt))
      : null,
  );
};

// ── Playing ──────────────────────────────────────────────────────
const Playing = (state) => {
  const piece = state.currentPiece;
  if (!piece) return Inicio(state);
  const pieceKey = `${piece.songId}:${piece.fragmentId}`;
  return h('div', { class: 'page' },
    Masthead(),
    Pieza(state),
    Epigraph(piece, pieceKey),
    ArtistStage(state, pieceKey),
  );
};

const choiceClass = (artistId, flash) => {
  if (!flash) return '';
  if (artistId === flash.correctArtistId) return ' is-correct';
  if (artistId === flash.pickedArtistId)  return ' is-wrong';
  return ' is-dim';
};

const Choice = (artistId, idx, pieceKey, flash) => {
  const artist = findArtist(artistId);
  return h('button', {
    class: 'choice'
      + onceClass(`choice:${pieceKey}:${idx}`, 'is-animate')
      + choiceClass(artistId, flash),
    type: 'button',
    style: `--i:${idx}`,
    disabled: !!flash,
    onclick: () => pickArtist(artistId),
  }, artist.displayName);
};

const ArtistStage = (state, pieceKey) =>
  h('section', { class: 'stage stage--artist' },
    h('div', { class: 'prompt' }, '¿Quién?'),
    h('div', { class: 'choices' },
      ...state.choices.map((id, i) => Choice(id, i, pieceKey, state.flash))
    ),
  );

// ── Final ────────────────────────────────────────────────────────
const tierFor = (streak, played) => {
  if (played === 0) return 'none';
  if (streak >= 5)  return 'win';
  if (streak === 0) return 'lose';
  return 'mid';
};

const TITLE_BY_TIER = {
  win:  '¡OTRA!',
  mid:  'NADA MAL',
  lose: 'DESAFINADO',
  none: 'TELÓN',
};
const SUB_BY_TIER = {
  win:  'el público de pie',
  mid:  'una buena tirada',
  lose: 'el público se fue',
  none: 'no sonó ninguna canción',
};

const CONFETTI_COLORS = ['#ffb86b', '#7cff6b', '#f4ece0'];
const Confetti = () => {
  const N = 24;
  const spans = [];
  for (let i = 0; i < N; i++) {
    const x = Math.floor(Math.random() * 100);
    const d = Math.floor(Math.random() * 1100);
    const dur = 1500 + Math.floor(Math.random() * 1200);
    const c = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
    spans.push(h('span', {
      style: `--x:${x}; --d:${d}ms; --dur:${dur}ms; --c:${c};`,
    }));
  }
  return h('div', { class: 'confetti', 'aria-hidden': 'true' }, ...spans);
};

const seguidasLabel = (n) => n === 1 ? '1 seguida' : `${n} seguidas`;

const Final = (state) => {
  const played = state.pieces.length;
  const streak = state.score;
  const tier = tierFor(streak, played);
  const justFinished = state.record[state.record.length - 1] ?? null;
  const totalMs = state.pieces.reduce((a, p) => a + (p.elapsedMs || 0), 0);
  const isDaily = state.playMode === 'daily';

  return h('div', { class: `final final--${tier}` },
    Masthead(),
    h('div', { class: 'final__banner' },
      tier === 'win' ? Confetti() : null,
      isDaily ? h('div', { class: 'final__mode' }, 'reto del día') : null,
      h('h1', { class: 'final__title' }, TITLE_BY_TIER[tier]),
      h('div', { class: 'final__sub' }, SUB_BY_TIER[tier]),
    ),
    h('div', { class: 'final__big' },
      h('div', { class: 'final__stat final__stat--streak' },
        h('span', {
          class: 'final__big__num is-animate',
          style: `--target:${streak};`,
          'aria-label': seguidasLabel(streak),
        }),
        h('small', {}, seguidasLabel(streak)),
      ),
      played > 0
        ? h('div', { class: 'final__stat final__stat--time' },
            h('span', {
              class: 'final__big__num final__big__num--time',
              'aria-label': `tiempo total ${fmtTime(totalMs)}`,
            }, fmtTime(totalMs)),
            h('small', {}, 'tiempo total'),
          )
        : null,
    ),
    BestRecord(state.record, justFinished),
    played > 0 ? Tally(state) : null,
    played >= 2
      ? h('button', {
          class: 'btn btn--ghost composite__toggle',
          type: 'button',
          'aria-expanded': compositeOpen ? 'true' : 'false',
          onclick: toggleComposite,
        }, compositeOpen ? 'Ocultar canción ←' : 'Ver la canción que armaste →')
      : null,
    played >= 2 && compositeOpen ? Composite(state.pieces) : null,
    h('div', { class: 'actions' },
      h('button', { class: 'btn btn--primary', type: 'button', onclick: restart }, 'Otra vez →'),
      h('button', { class: 'btn btn--ghost',  type: 'button', onclick: backToIntro }, 'Al inicio'),
    ),
  );
};

const BestRecord = (record, justFinished) => {
  if (record.length === 0) return null;
  const bestScore = Math.max(...record.map((e) => e.score));
  if (bestScore === 0) return null;
  const newRecord = justFinished
    && justFinished.score > 0
    && justFinished.score >= bestScore
    && (record.length === 1
        || justFinished.score > Math.max(...record.slice(0, -1).map((e) => e.score)));
  return h('aside', { class: 'best-record' },
    h('span', { class: 'best-record__label' }, 'Récord'),
    h('span', { class: 'best-record__value' }, bestScore),
    newRecord ? h('span', { class: 'best-record__badge' }, '¡Nuevo!') : null,
  );
};

const Tally = (state) =>
  h('div', { class: 'tally' },
    ...state.pieces.map((p, i) => {
      const song = findSong(p.songId);
      const realArtist = artistOf(p.songId);
      const split = h('span', { class: 'tally__split' }, fmtTime(p.elapsedMs || 0));
      if (p.artistOk) {
        return h('div', { class: 'tally__row tally__row--ok' },
          h('span', { class: 'tally__no' }, fmtN(i + 1)),
          h('span', { class: 'tally__mark' }, '✓'),
          h('b', {}, realArtist.displayName),
          h('span', { class: 'tally__song' }, song.song),
          split,
        );
      }
      const picked = p.pickedArtistId ? findArtist(p.pickedArtistId) : null;
      return h('div', { class: 'tally__row tally__row--bad' },
        h('span', { class: 'tally__no' }, fmtN(i + 1)),
        h('span', { class: 'tally__mark' }, '✗'),
        h('b', {}, realArtist.displayName),
        h('span', { class: 'tally__song' }, song.song),
        h('span', { class: 'tally__pick' },
          p.timedOut ? 'sin tiempo' : `elegiste: ${picked ? picked.displayName : '—'}`,
        ),
        split,
      );
    }),
  );

// ── Composite ("la canción que armaste") ─────────────────────────
const stanzaLines = (text) => {
  const lines = text.split('\n');
  const out = [];
  lines.forEach((line, i) => {
    out.push(line);
    if (i < lines.length - 1) out.push(h('br'));
  });
  return out;
};

const Stanza = (text, i) =>
  h('p', { class: 'composite__stanza', style: `--i:${i}` },
    ...stanzaLines(text),
  );

const Composite = (pieces) =>
  h('section', { class: 'composite' + onceClass('composite:open', 'is-animate') },
    h('div', { class: 'composite__label' }, 'la canción que armaste'),
    h('div', { class: 'composite__body' },
      ...pieces
        .map((p) => findSong(p.songId).fragments[p.fragmentId])
        .filter(Boolean)
        .map((text, i) => Stanza(text, i)),
    ),
  );

// ── Render loop ──────────────────────────────────────────────────
const render = (state) => {
  document.body.classList.toggle('has-sheet', sheetOpen);
  root.replaceChildren(view(state));
};

// Countdown ticker — touches narrow DOM only. No-op when deadlineAt is null
// (untimed mode).
const startTicker = () => {
  setInterval(() => {
    const { screen, deadlineAt, flash } = store.state;
    if (screen !== 'playing' || flash || !deadlineAt) return;
    const clock = document.querySelector('.pieza__clock');
    const wrap  = document.querySelector('.pieza-wrap');
    if (!clock || !wrap) return;
    const sec = remainingSec(deadlineAt);
    clock.textContent = `${sec}s`;
    const urgent = sec <= 2;
    clock.classList.toggle('pieza__clock--urgent', urgent);
    wrap.classList.toggle('is-urgent', urgent);
  }, 200);
};

const start = async () => {
  await store.ready;
  cacheVersion = await readCacheVersion();
  store.subscribe(render);
  render(store.state);
  startTicker();
  // Hydrated mid-round: rebuild round-local state. Timer rearmed only when
  // timed; round timing reset to now so the offline gap isn't counted.
  if (store.state.screen === 'playing'
      && store.state.stage === 'artist'
      && !store.state.flash) {
    pbAtGameStart = personalBest(store.state.record);
    const turnSec = effectiveTurnSec();
    const deadlineAt = turnSec > 0 ? armTimer(timeoutArtist, turnSec * 1000) : null;
    store.setLifecycle({ roundStartedAt: Date.now(), deadlineAt });
  }
};

start();
