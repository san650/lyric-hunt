import { store } from './store.js';
import {
  ARTISTS, SONGS, pickFragment, pickArtistChoices,
  findArtist, findSong, artistOf, playableArtists,
} from './lyrics.js';

const root = document.getElementById('view');

// ── Animation-once gate ──────────────────────────────────────────
// CSS entry animations are declared with `.is-animate` so a re-render
// alone does not replay them. `onceClass(key, 'is-animate')` returns the
// modifier on first sight of `key` and an empty string thereafter.
// Cleared on game start so a fresh round can animate even if a key was
// used in a prior game.
// See: pwa-gotchas/reference/render-restarts-animation.md
const animated = new Set();
const onceClass = (key, cls) => {
  if (animated.has(key)) return '';
  animated.add(key);
  return ' ' + cls;
};

// ── DOM helpers ──────────────────────────────────────────────────
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

const fmtN = (n) => String(n).padStart(2, '0');

// ── Stage timer ──────────────────────────────────────────────────
// The user has turnSec seconds to pick an artist; when the deadline
// passes the round auto-resolves and the game ends.
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

const turnMs = () => store.state.prefs.turnSec * 1000;

// ── Flash + lifecycle ────────────────────────────────────────────
// After a pick we briefly hold the screen so the player sees lime on the
// right answer (and red on a wrong one) before advancing.
const FLASH_OK_MS  = 420;
const FLASH_BAD_MS = 900;

const goToSetup = () => {
  cancelTimer();
  store.setLifecycle({ screen: 'setup' });
};
const backToIntro = () => {
  cancelTimer();
  store.setLifecycle({ screen: 'intro' });
};

const toggleArtist = (artistId) => {
  const set = new Set(store.state.prefs.artistIds);
  if (set.has(artistId)) set.delete(artistId);
  else set.add(artistId);
  // Guard: never let the lineup drop below two — view also disables the
  // last toggle, this is just belt-and-braces.
  if (set.size < 2) return;
  store.setLifecycle({
    prefs: { ...store.state.prefs, artistIds: [...set] },
  });
};

const setTurnSec = (sec) => {
  if (sec === store.state.prefs.turnSec) return;
  store.setLifecycle({
    prefs: { ...store.state.prefs, turnSec: sec },
  });
};

const startGame = () => {
  animated.clear();
  const { prefs } = store.state;
  const piece = pickFragment([], prefs.artistIds);
  if (!piece) return;
  const correct = findSong(piece.songId).artistId;
  const deadlineAt = armTimer(timeoutArtist, turnMs());
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
    deadlineAt,
  });
};

const nextRound = () => {
  const { seenKeys, prefs } = store.state;
  const piece = pickFragment(seenKeys, prefs.artistIds);
  if (!piece) { endGame(); return; }
  const key = `${piece.songId}:${piece.fragmentId}`;
  const newSeen = seenKeys.includes(key) ? seenKeys : [...seenKeys, key];
  const correct = findSong(piece.songId).artistId;
  const deadlineAt = armTimer(timeoutArtist, turnMs());
  store.setLifecycle({
    stage: 'artist',
    currentPiece: piece,
    choices: pickArtistChoices(correct, prefs.artistIds),
    pickedArtistId: null,
    revealed: null,
    flash: null,
    seenKeys: newSeen,
    deadlineAt,
  });
};

const pickArtist = (artistId) => {
  // Ignore taps while we're already showing the flash for this round.
  if (store.state.flash) return;
  cancelTimer();
  const { currentPiece } = store.state;
  const song = findSong(currentPiece.songId);
  const ok = artistId === song.artistId;
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
    }],
  });
  setTimeout(ok ? nextRound : endGame, ok ? FLASH_OK_MS : FLASH_BAD_MS);
};

// Timer expiry — treat as a wrong pick (no pick). Brief flash showing the
// right answer, then end the game.
const timeoutArtist = () => {
  if (store.state.screen !== 'playing' || store.state.flash) return;
  const { currentPiece } = store.state;
  const song = findSong(currentPiece.songId);
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
    }],
  });
  setTimeout(endGame, FLASH_BAD_MS);
};

const MAX_RECORD = 500;

const endGame = () => {
  cancelTimer();
  const played = store.state.pieces.length;
  const entry = { score: store.state.score, played, when: Date.now() };
  const record = [...store.state.record, entry].slice(-MAX_RECORD);
  store.setLifecycle({ screen: 'final', flash: null, record, deadlineAt: null });
};

const restart = startGame;

// ── Top-level view ───────────────────────────────────────────────
const view = (state) => {
  if (state.screen === 'intro')   return Intro();
  if (state.screen === 'setup')   return Setup(state);
  if (state.screen === 'final')   return Final(state);
  return Playing(state);
};

const Masthead = () =>
  h('header', { class: 'masthead' },
    h('span', { class: 'masthead__title' },
      'Lyric',
      h('span', { style: 'color:var(--ink-thin); font-style: italic; font-weight: 400;' }, ' Hunt'),
    ),
    h('span', { class: 'masthead__meta' },
      h('span', { class: 'dot' }), '42.uy / lyrics'
    ),
  );

// ── Intro ────────────────────────────────────────────────────────
const Intro = () =>
  h('div', { class: 'intro' },
    Masthead(),
    h('div', { class: 'intro__mark' },
      'Guess', h('em', {}, 'whose line this is.'),
    ),
    h('p', { class: 'intro__deck' },
      `A single line, ${ARTISTS.length} suspects. Pick the artist before the clock runs out. One miss and the curtain falls.`,
    ),
    h('div', { class: 'intro__rule' }),
    BestRecord(store.state.record, null),
    h('div', { class: 'actions intro__actions' },
      h('button', { class: 'btn btn--primary intro__btn', onclick: startGame },
        'Play →'
      ),
      h('button', { class: 'btn btn--ghost intro__setup', onclick: goToSetup },
        'Setup'
      ),
    ),
    h('div', { class: 'intro__foot' },
      `Catalogue: ${ARTISTS.length} artists · ${SONGS.length} songs · ${SONGS.reduce((a, s) => a + s.fragments.length, 0)} verses`
    ),
  );

// ── Setup ────────────────────────────────────────────────────────
const ArtistToggle = (artist, idx, selected, soleSelected) => {
  const isOn = selected.includes(artist.id);
  const songCount = SONGS.filter((s) => s.artistId === artist.id).length;
  const silent = songCount === 0;
  // Stop the user disabling the second-to-last artist from the UI; the
  // toggleArtist guard also catches this but disabling here is what makes
  // the affordance obvious (cursor + dim state).
  const disabled = isOn && soleSelected;
  return h('button', {
    class: 'lineup__card'
      + (isOn ? ' is-on' : '')
      + (disabled ? ' is-locked' : '')
      + (silent ? ' is-silent' : '')
      + onceClass(`lineup:${artist.id}`, 'is-animate'),
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
            `${songCount} song${songCount === 1 ? '' : 's'}`),
    ),
  );
};

const DurationOption = (sec, current) => {
  const isOn = sec === current;
  return h('button', {
    class: 'duration__opt' + (isOn ? ' is-on' : ''),
    type: 'button',
    'aria-pressed': isOn ? 'true' : 'false',
    onclick: () => setTurnSec(sec),
  },
    h('span', { class: 'duration__num' }, fmtN(sec)),
    h('span', { class: 'duration__unit' }, 's'),
  );
};

const Setup = (state) => {
  const { prefs } = state;
  const lineup = ARTISTS;
  const lineupIds = new Set(lineup.map((a) => a.id));
  const selected = prefs.artistIds.filter((id) => lineupIds.has(id));
  const soleSelected = selected.length <= 2;
  // Need ≥2 selected so we have at least one decoy, and at least one of
  // those must actually have material so pickFragment has a piece to draw.
  const playableSet = new Set(playableArtists().map((a) => a.id));
  const playableSelected = selected.filter((id) => playableSet.has(id)).length;
  const canStart = selected.length >= 2 && playableSelected >= 1;
  return h('div', { class: 'setup' },
    Masthead(),
    h('div', { class: 'setup__head' },
      h('h2', { class: 'setup__title' },
        'Setup',
        h('span', { class: 'setup__title-dot' }),
      ),
      h('p', { class: 'setup__deck' }, "Choose tonight's lineup and how long you've got to call each line."),
    ),

    h('section', { class: 'setup__section' },
      h('div', { class: 'setup__sectionhead' },
        h('span', { class: 'setup__label' }, 'Lineup'),
        h('span', { class: 'setup__count' }, `${selected.length}/${lineup.length}`),
      ),
      h('div', { class: 'lineup' },
        ...lineup.map((a, i) => ArtistToggle(a, i, selected, soleSelected)),
      ),
      soleSelected
        ? h('div', { class: 'setup__hint' }, 'Two minimum — the rest are yours to drop.')
        : selected.length >= 2 && playableSelected === 0
          ? h('div', { class: 'setup__hint' }, "None of the picked artists have lyrics yet — add at least one that does.")
          : null,
    ),

    h('section', { class: 'setup__section' },
      h('div', { class: 'setup__sectionhead' },
        h('span', { class: 'setup__label' }, 'Turn length'),
      ),
      h('div', { class: 'duration' },
        DurationOption(8, prefs.turnSec),
        DurationOption(10, prefs.turnSec),
      ),
    ),

    h('div', { class: 'actions setup__actions' },
      h('button', {
        class: 'btn btn--primary setup__start',
        type: 'button',
        disabled: !canStart,
        onclick: startGame,
      }, 'Start the round →'),
      h('button', {
        class: 'btn btn--ghost',
        type: 'button',
        onclick: backToIntro,
      }, 'Back'),
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
    h('span', { class: 'epigraph__corner epigraph__corner--tl' }, 'mystery line'),
    h('span', { class: 'epigraph__corner epigraph__corner--tr' }, '◆◆◆'),
    h('p', { class: 'epigraph__quote' },
      ...renderLyric(piece.fragment, pieceKey)
    ),
  );

// Visual timer bar — drained by CSS animation. Negative animation-delay
// snapshots how much time has already passed so re-renders or hydrates
// resume from the right position instead of restarting from 100%.
const TimerBar = (deadlineAt) => {
  const ms = turnMs();
  const elapsed = Math.max(0, ms - (deadlineAt - Date.now()));
  return h('div', {
    class: 'pieza__timer',
    'aria-hidden': 'true',
  },
    h('div', {
      class: 'pieza__timer__fill',
      style: `--turn-ms:${ms}ms; --elapsed:${elapsed};`,
    }),
  );
};

const Pieza = (state) => {
  const sec = state.flash ? null : remainingSec(state.deadlineAt);
  const urgent = sec !== null && sec <= 2;
  const streak = state.score;
  return h('div', { class: 'pieza-wrap' + (urgent ? ' is-urgent' : '') },
    h('div', { class: 'pieza' },
      h('span', { class: 'pieza__streak' },
        h('span', { class: 'pieza__streak__label' }, 'Streak'),
        h('em', { class: 'pieza__streak__num' + (streak >= 5 ? ' is-hot' : '') }, fmtN(streak)),
      ),
      sec !== null
        ? h('span', {
            class: 'pieza__clock' + (urgent ? ' pieza__clock--urgent' : ''),
            'aria-label': 'Seconds remaining',
          }, `${sec}s`)
        : h('span', { class: 'pieza__clock pieza__clock--paused' }, state.flash?.ok ? '✓' : '✗'),
    ),
    state.flash
      ? null
      : h('div', { class: 'pieza__timeline' }, TimerBar(state.deadlineAt)),
  );
};

// ── Playing ──────────────────────────────────────────────────────
const Playing = (state) => {
  const piece = state.currentPiece;
  if (!piece) return Intro();
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
    h('div', { class: 'prompt' }, 'Who?'),
    h('div', { class: 'choices' },
      ...state.choices.map((id, i) => Choice(id, i, pieceKey, state.flash))
    ),
  );

// ── Final ────────────────────────────────────────────────────────
// Tier: drives banner color, title, and which entry animation plays.
const tierFor = (streak, played) => {
  if (played === 0) return 'none';
  if (streak >= 5)  return 'win';
  if (streak === 0) return 'lose';
  return 'mid';
};

const TITLE_BY_TIER = {
  win:  'ENCORE!',
  mid:  'NOT BAD',
  lose: 'OFF KEY',
  none: 'CURTAIN',
};

const SUB_BY_TIER = {
  win:  'crowd is on its feet',
  mid:  'a respectable run',
  lose: 'crowd has left the building',
  none: 'no songs were sung',
};

const CONFETTI_COLORS = ['#ff2d95', '#00e5ff', '#ffd60a', '#7cff6b', '#9b5cff'];
const Confetti = () => {
  const N = 32;
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

const Final = (state) => {
  const played = state.pieces.length;
  const streak = state.score;
  const tier = tierFor(streak, played);
  const justFinished = state.record[state.record.length - 1] ?? null;

  return h('div', { class: `final final--${tier}` },
    Masthead(),
    h('div', { class: 'final__banner' },
      tier === 'win' ? Confetti() : null,
      h('h1', { class: 'final__title' }, TITLE_BY_TIER[tier]),
      h('div', { class: 'final__sub' }, SUB_BY_TIER[tier]),
    ),
    h('div', { class: 'final__big' },
      h('span', {
        class: 'final__big__num is-animate',
        style: `--target:${streak};`,
        'aria-label': `${streak} in a row`,
      }),
      h('small', {}, streak === 1 ? '1 in a row' : `${streak} in a row`),
    ),
    BestRecord(state.record, justFinished),
    played > 0 ? Tally(state) : null,
    h('div', { class: 'actions' },
      h('button', { class: 'btn btn--primary', type: 'button', onclick: restart }, 'Again →'),
      h('button', { class: 'btn btn--ghost',  type: 'button', onclick: backToIntro }, 'Back to start'),
    ),
  );
};

// ── Best record ──────────────────────────────────────────────────
// Slim badge — just the lifetime high score (and a "New record" flag when
// the just-finished game eclipses every prior one).
const BestRecord = (record, justFinished) => {
  if (record.length === 0) return null;
  const bestScore = Math.max(...record.map((e) => e.score));
  const newRecord = justFinished
    && justFinished.score > 0
    && justFinished.score >= bestScore
    && (record.length === 1
        || justFinished.score > Math.max(...record.slice(0, -1).map((e) => e.score)));
  return h('aside', { class: 'best-record' },
    h('span', { class: 'best-record__label' }, 'Best Record'),
    h('span', { class: 'best-record__value' }, bestScore),
    newRecord ? h('span', { class: 'best-record__badge' }, 'New') : null,
  );
};

const Tally = (state) =>
  h('div', { class: 'tally' },
    ...state.pieces.map((p, i) => {
      const song = findSong(p.songId);
      const realArtist = artistOf(p.songId);
      if (p.artistOk) {
        return h('div', { class: 'tally__row tally__row--ok' },
          h('span', { class: 'tally__no' }, fmtN(i + 1)),
          h('span', { class: 'tally__mark' }, '✓'),
          h('b', {}, realArtist.displayName),
          h('span', { class: 'tally__song' }, song.song),
        );
      }
      const picked = p.pickedArtistId ? findArtist(p.pickedArtistId) : null;
      return h('div', { class: 'tally__row tally__row--bad' },
        h('span', { class: 'tally__no' }, fmtN(i + 1)),
        h('span', { class: 'tally__mark' }, '✗'),
        h('b', {}, realArtist.displayName),
        h('span', { class: 'tally__song' }, song.song),
        h('span', { class: 'tally__pick' },
          p.timedOut ? 'timed out' : `you said: ${picked ? picked.displayName : '—'}`,
        ),
      );
    }),
  );

// ── Render loop ──────────────────────────────────────────────────
const render = (state) => {
  root.replaceChildren(view(state));
};

// Countdown ticker: updates the `.pieza__clock` text node ~5x/sec while
// the artist stage is live, and toggles the urgent class on both the
// clock badge and the wrapping HUD (so the whole row can shake at <2s).
// Touching narrow DOM bits — not the whole tree — avoids restarting any
// animations or losing focus.
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
  store.subscribe(render);
  render(store.state);
  startTicker();
  // If we hydrated mid-round (user reloaded with the timer running), re-arm
  // it with a fresh window — the in-memory setTimeout from before the reload
  // is gone, and there's no flash mid-flight on cold start.
  if (store.state.screen === 'playing'
      && store.state.stage === 'artist'
      && !store.state.flash) {
    store.setLifecycle({ deadlineAt: armTimer(timeoutArtist, turnMs()) });
  }
};

start();
