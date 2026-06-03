import { store } from './store.js';
import {
  ARTISTS, SONGS, pickFragment, pickArtistChoices,
  findArtist, findSong, artistOf, checkBonus,
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
// The user has TURN_MS to act in each guess stage; when the deadline
// passes the round auto-resolves. `activeTimeoutId` lets us cancel the
// scheduled expiry whenever the user acts before time runs out.
const TURN_MS = 8000;
let activeTimeoutId = null;

const cancelTimer = () => {
  if (activeTimeoutId !== null) {
    clearTimeout(activeTimeoutId);
    activeTimeoutId = null;
  }
};

const armTimer = (onExpire) => {
  cancelTimer();
  activeTimeoutId = setTimeout(() => {
    activeTimeoutId = null;
    onExpire();
  }, TURN_MS);
  return Date.now() + TURN_MS;
};

const remainingSec = (deadlineAt) =>
  deadlineAt ? Math.max(0, Math.ceil((deadlineAt - Date.now()) / 1000)) : null;

// ── Game lifecycle (bypasses commands) ───────────────────────────
const startGame = () => {
  animated.clear();
  const piece = pickFragment([]);
  const correct = findSong(piece.songId).artistId;
  const deadlineAt = armTimer(timeoutArtist);
  store.setLifecycle({
    screen: 'playing',
    stage: 'artist',
    score: 0,
    pieces: [],
    seenKeys: [`${piece.songId}:${piece.fragmentId}`],
    currentPiece: piece,
    choices: pickArtistChoices(correct),
    pickedArtistId: null,
    bonusGuess: '',
    revealed: null,
    deadlineAt,
  });
};

const nextRound = () => {
  const { seenKeys } = store.state;
  const piece = pickFragment(seenKeys);
  const newSeen = seenKeys.includes(`${piece.songId}:${piece.fragmentId}`)
    ? seenKeys
    : [...seenKeys, `${piece.songId}:${piece.fragmentId}`];
  const correct = findSong(piece.songId).artistId;
  const deadlineAt = armTimer(timeoutArtist);
  store.setLifecycle({
    stage: 'artist',
    currentPiece: piece,
    choices: pickArtistChoices(correct),
    pickedArtistId: null,
    bonusGuess: '',
    revealed: null,
    seenKeys: newSeen,
    deadlineAt,
  });
};

const pickArtist = (artistId) => {
  cancelTimer();
  const { currentPiece } = store.state;
  const song = findSong(currentPiece.songId);
  const artistOk = artistId === song.artistId;
  if (artistOk) {
    // Advance to bonus stage. No timer — the user can take their time on
    // the song/album guess.
    store.setLifecycle({
      stage: 'bonus',
      pickedArtistId: artistId,
      deadlineAt: null,
    });
  } else {
    // Wrong pick: no bonus stage; reveal immediately, 0 points.
    store.setLifecycle({
      stage: 'revealed',
      pickedArtistId: artistId,
      revealed: { artistOk: false, bonusMatch: null, points: 0, timedOut: false },
      pieces: [...store.state.pieces, {
        songId: currentPiece.songId,
        fragmentId: currentPiece.fragmentId,
        points: 0, skipped: false,
        artistOk: false, bonusMatch: null,
      }],
      deadlineAt: null,
    });
  }
};

// Timer expiry — artist stage. Treated as "no pick", 0 points; reveals
// the correct answer so the user can still learn what they missed.
const timeoutArtist = () => {
  if (store.state.stage !== 'artist') return;
  const { currentPiece } = store.state;
  store.setLifecycle({
    stage: 'revealed',
    pickedArtistId: null,
    revealed: { artistOk: false, bonusMatch: null, points: 0, timedOut: true },
    pieces: [...store.state.pieces, {
      songId: currentPiece.songId,
      fragmentId: currentPiece.fragmentId,
      points: 0, skipped: false,
      artistOk: false, bonusMatch: null,
    }],
    deadlineAt: null,
  });
};

const submitBonus = () => {
  cancelTimer();
  const { currentPiece } = store.state;
  const song = findSong(currentPiece.songId);
  const bonusGuess = document.querySelector('input[name="bonus"]')?.value ?? '';
  const bonusMatch = checkBonus(bonusGuess, song);
  const points = 1 + (bonusMatch ? 1 : 0);
  store.setLifecycle({
    stage: 'revealed',
    bonusGuess,
    revealed: { artistOk: true, bonusMatch, points, timedOut: false },
    score: store.state.score + points,
    pieces: [...store.state.pieces, {
      songId: currentPiece.songId,
      fragmentId: currentPiece.fragmentId,
      points, skipped: false,
      artistOk: true, bonusMatch,
    }],
    deadlineAt: null,
  });
};

const skipBonus = () => {
  cancelTimer();
  // Take the artist point; no bonus.
  const { currentPiece } = store.state;
  store.setLifecycle({
    stage: 'revealed',
    bonusGuess: '',
    revealed: { artistOk: true, bonusMatch: null, points: 1, timedOut: false },
    score: store.state.score + 1,
    pieces: [...store.state.pieces, {
      songId: currentPiece.songId,
      fragmentId: currentPiece.fragmentId,
      points: 1, skipped: false,
      artistOk: true, bonusMatch: null,
    }],
    deadlineAt: null,
  });
};

const skipVerse = () => {
  cancelTimer();
  // Skip the whole verse (artist stage); no points awarded.
  const { currentPiece } = store.state;
  store.setLifecycle({
    pieces: [...store.state.pieces, {
      songId: currentPiece.songId,
      fragmentId: currentPiece.fragmentId,
      points: 0, skipped: true,
      artistOk: false, bonusMatch: null,
    }],
    deadlineAt: null,
  });
  nextRound();
};

const MAX_RECORD = 500;

const endGame = () => {
  cancelTimer();
  const played = store.state.pieces.length;
  const entry = { score: store.state.score, played, when: Date.now() };
  const record = [...store.state.record, entry].slice(-MAX_RECORD);
  store.setLifecycle({ screen: 'final', revealed: null, record, deadlineAt: null });
};
const restart   = () => { cancelTimer(); startGame(); };
const backToIntro = () => { cancelTimer(); store.setLifecycle({ screen: 'intro' }); };

// ── Top-level view ───────────────────────────────────────────────
const view = (state) => {
  if (state.screen === 'intro') return Intro();
  if (state.screen === 'final') return Final(state);
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
      `A single line, ${ARTISTS.length} suspects. Pick the artist. If you nail it, name the song or the album for a bonus point.`,
    ),
    h('div', { class: 'intro__rule' }),
    h('ul', { class: 'intro__rules' },
      h('li', {}, h('b', {}, '1'), 'point for the right artist.'),
      h('li', {}, h('b', {}, '+1'), 'bonus for the song or the album.'),
      h('li', {}, h('b', {}, '0'), 'if you skip the verse.'),
    ),
    Record(store.state.record, null),
    h('button', { class: 'btn btn--primary intro__btn', onclick: startGame },
      'Begin →'
    ),
    h('div', { class: 'intro__foot' },
      `Catalogue: ${ARTISTS.length} artists · ${SONGS.length} songs · ${SONGS.reduce((a, s) => a + s.fragments.length, 0)} verses`
    ),
  );

// ── Shared: epigraph + pieza ─────────────────────────────────────
// Word-by-word reveal — each word becomes its own animated span carrying
// a running index `--i` for CSS to stagger animation-delay. Whitespace
// and line breaks are preserved so wrapping still feels natural.
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

const Epigraph = (piece, song, pieceKey, isRevealed) =>
  h('blockquote', { class: 'epigraph' },
    h('span', { class: 'epigraph__corner epigraph__corner--tl' }, 'mystery line'),
    h('span', { class: 'epigraph__corner epigraph__corner--tr' }, '◆◆◆'),
    h('p', { class: 'epigraph__quote' },
      ...renderLyric(piece.fragment, pieceKey)
    ),
    h('span', { class: 'epigraph__corner epigraph__corner--br' }, isRevealed ? song.year : '???'),
  );

// Visual timer bar — drained by CSS animation. Negative animation-delay
// snapshots how much time has already passed so re-renders or hydrates
// resume from the right position instead of restarting from 100%.
const TimerBar = (deadlineAt) => {
  const elapsed = Math.max(0, TURN_MS - (deadlineAt - Date.now()));
  return h('div', {
    class: 'pieza__timer',
    'aria-hidden': 'true',
  },
    h('div', {
      class: 'pieza__timer__fill',
      style: `--turn-ms:${TURN_MS}ms; --elapsed:${elapsed};`,
    }),
  );
};

const Pieza = (state) => {
  // While playing a round, show the round-in-progress number; in the
  // revealed stage `pieces` already includes this round, so don't +1.
  const n = state.stage === 'revealed' ? state.pieces.length : state.pieces.length + 1;
  // Countdown is shown only during the artist stage. The bonus stage is
  // untimed so the user can think through the song/album guess.
  const sec = state.stage === 'artist' ? remainingSec(state.deadlineAt) : null;
  const urgent = sec !== null && sec <= 2;
  return h('div', { class: 'pieza-wrap' + (urgent ? ' is-urgent' : '') },
    h('div', { class: 'pieza' },
      h('span', { class: 'pieza__no' },
        'R', h('em', {}, '#'), fmtN(n)),
      h('span', { class: 'pieza__score' },
        h('em', {}, state.score), 'pts'),
    ),
    sec !== null
      ? h('div', { class: 'pieza__timeline' },
          TimerBar(state.deadlineAt),
          h('span', {
            class: 'pieza__clock' + (urgent ? ' pieza__clock--urgent' : ''),
            'aria-label': 'Seconds remaining',
          }, `${sec}s`),
        )
      : null,
  );
};

// ── Playing ──────────────────────────────────────────────────────
const Playing = (state) => {
  const piece = state.currentPiece;
  if (!piece) return Intro();
  const song = findSong(piece.songId);
  const artist = artistOf(piece.songId);
  const pieceKey = `${piece.songId}:${piece.fragmentId}`;

  let stageBlock;
  if (state.stage === 'artist')        stageBlock = ArtistStage(state, pieceKey);
  else if (state.stage === 'bonus')    stageBlock = BonusStage(state, artist, pieceKey);
  else                                 stageBlock = RevealedStage(state, song, artist, pieceKey);

  return h('div', { class: 'page' },
    Masthead(),
    Pieza(state),
    Epigraph(piece, song, pieceKey, state.stage === 'revealed'),
    stageBlock,
  );
};

const Choice = (artistId, idx, pieceKey) => {
  const artist = findArtist(artistId);
  return h('button', {
    class: 'choice' + onceClass(`choice:${pieceKey}:${idx}`, 'is-animate'),
    type: 'button',
    style: `--i:${idx}`,
    onclick: () => pickArtist(artistId),
  }, artist.displayName);
};

const ArtistStage = (state, pieceKey) =>
  h('section', { class: 'stage stage--artist' },
    h('div', { class: 'prompt' }, 'Who?'),
    h('div', { class: 'choices' },
      ...state.choices.map((id, i) => Choice(id, i, pieceKey))
    ),
    h('div', { class: 'actions actions--right' },
      h('button', { class: 'btn btn--end', type: 'button', onclick: skipVerse }, 'Skip verse'),
    ),
  );

const BonusStage = (state, artist, pieceKey) =>
  h('section', { class: 'stage stage--bonus' + onceClass(`bonus:${pieceKey}`, 'is-animate') },
    h('div', { class: 'confirmed' },
      h('span', { class: 'confirmed__tick' }, '✓'),
      h('span', { class: 'confirmed__name' }, artist.displayName),
      h('span', { class: 'confirmed__pts' }, '+1'),
    ),
    h('form', {
      class: 'bonus',
      onsubmit: (e) => { e.preventDefault(); submitBonus(); },
    },
      h('label', { class: 'bonus__field' },
        h('span', { class: 'bonus__label' }, 'Now: song or album'),
        h('input', {
          class: 'bonus__input',
          name: 'bonus',
          type: 'text',
          autocomplete: 'off',
          autocapitalize: 'words',
          spellcheck: false,
          placeholder: 'Either earns +1',
        }),
      ),
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn--primary', type: 'submit' }, 'Reveal'),
        h('button', { class: 'btn btn--ghost',  type: 'button', onclick: skipBonus }, 'Pass on bonus'),
      ),
    ),
  );

const Stamp = (text, isNull, pieceKey) =>
  h('span', {
    class: 'stamp' + (isNull ? ' stamp--null' : '') + onceClass(`stamp:${pieceKey}`, 'is-animate'),
  }, text);

const RevealedStage = (state, song, artist, pieceKey) => {
  const r = state.revealed;
  const picked = findArtist(state.pickedArtistId);

  const stampText = (() => {
    if (r.points === 2) return 'Sweep · +2';
    if (r.points === 1) return 'Just artist · +1';
    return r.timedOut ? 'Timed out · +0' : 'Nothing · +0';
  })();

  // What the user typed in the bonus stage (if any).
  const bonusTyped = (state.bonusGuess || '').trim();

  return h('section', { class: 'stage stage--revealed' },
    h('div', { class: 'outcome__head' },
      Stamp(stampText, r.points === 0, pieceKey),
      h('span', { class: 'outcome__points' },
        `+${r.points}`, h('span', {}, ' / 2'),
      ),
    ),
    h('dl', { class: 'attribution' },
      // Artist row — always shown, marked by what the user picked.
      r.artistOk
        ? h('div', { class: 'attribution__row attribution__row--ok' },
            h('dt', {}, h('span', { class: 'mark' }, '✓'), ' Artist'),
            h('dd', {}, artist.displayName),
          )
        : h('div', { class: 'attribution__row attribution__row--bad' },
            h('dt', {}, h('span', { class: 'mark' }, '✗'), ' You picked'),
            h('dd', {}, picked ? picked.displayName : '—'),
          ),
      !r.artistOk
        ? h('div', { class: 'attribution__row attribution__row--ok' },
            h('dt', {}, h('span', { class: 'mark' }, '→'), ' Correct'),
            h('dd', {}, artist.displayName),
          )
        : null,

      // Bonus rows — only meaningful if artist was correct.
      r.artistOk && r.bonusMatch
        ? h('div', { class: 'attribution__row attribution__row--ok' },
            h('dt', {}, h('span', { class: 'mark' }, '✓'),
              ' Bonus (', r.bonusMatch, ')'),
            h('dd', {}, bonusTyped || '—'),
          )
        : null,
      r.artistOk && !r.bonusMatch && bonusTyped
        ? h('div', { class: 'attribution__row attribution__row--bad' },
            h('dt', {}, h('span', { class: 'mark' }, '✗'), ' You said'),
            h('dd', {}, bonusTyped),
          )
        : null,

      // Always show song; hide empty album/year rows.
      h('div', { class: 'attribution__row attribution__row--info' },
        h('dt', {}, 'Song'),
        h('dd', {}, song.song),
      ),
      song.album
        ? h('div', { class: 'attribution__row attribution__row--info' },
            h('dt', {}, 'Album'),
            h('dd', {}, song.album),
          )
        : null,
      song.year
        ? h('div', { class: 'attribution__row attribution__row--info' },
            h('dt', {}, 'Year'),
            h('dd', {}, song.year),
          )
        : null,
    ),
    h('div', { class: 'actions' },
      h('button', { class: 'btn btn--primary', type: 'button', onclick: nextRound }, 'Another verse →'),
      h('button', { class: 'btn btn--end',    type: 'button', onclick: endGame },    'Finish'),
    ),
  );
};

// ── Final ────────────────────────────────────────────────────────
const quipFor = (score, played) => {
  if (played === 0) return { line: 'Stepping out for air. Back soon.', cite: 'Anonymous' };
  const ratio = score / Math.max(1, played * 2);
  if (ratio >= 0.9)  return { line: "You're a walking jukebox.", cite: 'The jury' };
  if (ratio >= 0.6)  return { line: 'Top marks.', cite: 'The dean' };
  if (ratio >= 0.3)  return { line: 'Not bad. Listen more.', cite: 'Uncle Discman' };
  if (ratio > 0)     return { line: "One day you'll reach the trenches.", cite: 'Indio Solari, paraphrased' };
  return { line: 'El que nace mona Chita nunca llega a ser Tarzán.', cite: 'R. Musso' };
};

// Tier: drives banner color, title, and which entry animation plays.
const tierFor = (score, played) => {
  if (played === 0) return 'none';
  const r = score / (played * 2);
  if (r >= 0.6) return 'win';
  if (r < 0.3)  return 'lose';
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
  mid:  'crowd is half-listening',
  lose: 'crowd has left the building',
  none: 'no songs were sung',
};

// Confetti — fixed pattern of falling colored dots. Pure CSS animation,
// each span carrying its own --x, --d (delay), --dur, --c (color) so the
// pile feels random without any JS-driven motion.
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
  const max = played * 2;
  const quip = quipFor(state.score, played);
  const tier = tierFor(state.score, played);
  // The just-finished game's entry is the last one in record. Pass the
  // prior entries to Record() so it can compare and stamp NEW RECORD.
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
        style: `--target:${state.score};`,
        'aria-label': `${state.score} points`,
      }),
      h('small', {}, `${state.score} pts of ${max} · ${played} verses`),
    ),
    played > 0
      ? h('blockquote', { class: 'final__quip' },
          quip.line,
          h('cite', {}, quip.cite),
        )
      : null,
    Record(state.record, justFinished),
    played > 0 ? Tally(state) : null,
    h('div', { class: 'actions' },
      h('button', { class: 'btn btn--primary', type: 'button', onclick: restart }, 'Play again →'),
      h('button', { class: 'btn btn--ghost',  type: 'button', onclick: backToIntro }, 'Back to start'),
    ),
  );
};

// ── Record panel ─────────────────────────────────────────────────
// Lifetime stats across every finished game. Shown on intro and final.
// `justFinished` is the most recent entry (so we can stamp NEW RECORD if
// the current game beat the previous best); pass null on the intro.
const Record = (record, justFinished) => {
  const games = record.length;
  if (games === 0) {
    return h('aside', { class: 'record record--empty' },
      h('div', { class: 'record__title' }, 'Record'),
      h('p', { class: 'record__placeholder' },
        'Your best score will appear here after the first game.'),
    );
  }

  const ratio = (e) => e.played === 0 ? 0 : e.score / (e.played * 2);
  const bestScore = Math.max(...record.map((e) => e.score));
  const bestRatio = Math.max(...record.map(ratio));
  const last = record[record.length - 1];

  const newRecord = justFinished
    && justFinished.score > 0
    && justFinished.score >= bestScore
    && (record.length === 1
        || justFinished.score > Math.max(...record.slice(0, -1).map((e) => e.score)));

  return h('aside', { class: 'record' },
    h('div', { class: 'record__head' },
      h('span', { class: 'record__title' }, 'Record'),
      newRecord ? h('span', { class: 'record__badge' }, 'New record') : null,
    ),
    h('div', { class: 'record__grid' },
      Stat('Best',   bestScore),
      Stat('Acc.',   `${Math.round(bestRatio * 100)}%`),
      Stat('Games',  games),
      Stat('Last',   last.score),
    ),
  );
};

const Stat = (label, value) =>
  h('div', { class: 'record__stat' },
    h('span', { class: 'record__stat-label' }, label),
    h('span', { class: 'record__stat-value' }, value),
  );

const Tally = (state) =>
  h('div', { class: 'tally' },
    ...state.pieces.map((p, i) => {
      const song = findSong(p.songId);
      return h('div', { class: 'tally__row' + (p.skipped ? ' skipped' : '') },
        h('span', {}, fmtN(i + 1)),
        h('b', {}, song.song + ' — ' + artistOf(p.songId).displayName),
        h('span', { class: 'pts' }, p.skipped ? '—' : '+' + p.points),
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
    const { screen, stage, deadlineAt } = store.state;
    if (screen !== 'playing' || stage !== 'artist' || !deadlineAt) return;
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
  // If we hydrated mid-artist-stage (user reloaded mid-guess), re-arm
  // the timer with a fresh window — the in-memory setTimeout from before
  // the reload is gone. Bonus stage has no timer.
  if (store.state.screen === 'playing' && store.state.stage === 'artist') {
    store.setLifecycle({ deadlineAt: armTimer(timeoutArtist) });
  }
};

start();
