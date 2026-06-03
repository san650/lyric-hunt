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

// ── Game lifecycle (bypasses commands) ───────────────────────────
const startGame = () => {
  animated.clear();
  const piece = pickFragment([]);
  const correct = findSong(piece.songId).artistId;
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
  });
};

const nextRound = () => {
  const { seenKeys } = store.state;
  const piece = pickFragment(seenKeys);
  const newSeen = seenKeys.includes(`${piece.songId}:${piece.fragmentId}`)
    ? seenKeys
    : [...seenKeys, `${piece.songId}:${piece.fragmentId}`];
  const correct = findSong(piece.songId).artistId;
  store.setLifecycle({
    stage: 'artist',
    currentPiece: piece,
    choices: pickArtistChoices(correct),
    pickedArtistId: null,
    bonusGuess: '',
    revealed: null,
    seenKeys: newSeen,
  });
};

const pickArtist = (artistId) => {
  const { currentPiece } = store.state;
  const song = findSong(currentPiece.songId);
  const artistOk = artistId === song.artistId;
  if (artistOk) {
    // Advance to bonus stage; reveal stays null until bonus submit.
    store.setLifecycle({
      stage: 'bonus',
      pickedArtistId: artistId,
    });
  } else {
    // Wrong pick: no bonus stage; reveal immediately, 0 points.
    store.setLifecycle({
      stage: 'revealed',
      pickedArtistId: artistId,
      revealed: { artistOk: false, bonusMatch: null, points: 0 },
      pieces: [...store.state.pieces, {
        songId: currentPiece.songId,
        fragmentId: currentPiece.fragmentId,
        points: 0, skipped: false,
        artistOk: false, bonusMatch: null,
      }],
    });
  }
};

const submitBonus = () => {
  const { currentPiece } = store.state;
  const song = findSong(currentPiece.songId);
  const bonusGuess = document.querySelector('input[name="bonus"]')?.value ?? '';
  const bonusMatch = checkBonus(bonusGuess, song);
  const points = 1 + (bonusMatch ? 1 : 0);
  store.setLifecycle({
    stage: 'revealed',
    bonusGuess,
    revealed: { artistOk: true, bonusMatch, points },
    score: store.state.score + points,
    pieces: [...store.state.pieces, {
      songId: currentPiece.songId,
      fragmentId: currentPiece.fragmentId,
      points, skipped: false,
      artistOk: true, bonusMatch,
    }],
  });
};

const skipBonus = () => {
  // Take the artist point; no bonus.
  const { currentPiece } = store.state;
  store.setLifecycle({
    stage: 'revealed',
    bonusGuess: '',
    revealed: { artistOk: true, bonusMatch: null, points: 1 },
    score: store.state.score + 1,
    pieces: [...store.state.pieces, {
      songId: currentPiece.songId,
      fragmentId: currentPiece.fragmentId,
      points: 1, skipped: false,
      artistOk: true, bonusMatch: null,
    }],
  });
};

const skipVerse = () => {
  // Skip the whole verse (artist stage); no points awarded.
  const { currentPiece } = store.state;
  store.setLifecycle({
    pieces: [...store.state.pieces, {
      songId: currentPiece.songId,
      fragmentId: currentPiece.fragmentId,
      points: 0, skipped: true,
      artistOk: false, bonusMatch: null,
    }],
  });
  nextRound();
};

const endGame   = () => store.setLifecycle({ screen: 'final', revealed: null });
const restart   = () => startGame();
const backToIntro = () => store.setLifecycle({ screen: 'intro' });

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
    h('button', { class: 'btn btn--primary intro__btn', onclick: startGame },
      'Begin →'
    ),
    h('div', { class: 'intro__foot' },
      `Catalogue: ${ARTISTS.length} artists · ${SONGS.length} songs · ${SONGS.reduce((a, s) => a + s.fragments.length, 0)} verses`
    ),
  );

// ── Shared: epigraph + pieza ─────────────────────────────────────
const renderLyric = (text, pieceKey) => {
  const lines = text.split('\n');
  return lines.map((line, i) =>
    h('span', {
      class: 'epigraph__line' + onceClass(`line:${pieceKey}:${i}`, 'is-animate'),
    }, line + (line ? '' : ' '))
  );
};

const Epigraph = (piece, song, pieceKey, isRevealed) =>
  h('blockquote', { class: 'epigraph' },
    h('span', { class: 'epigraph__corner epigraph__corner--tl' }, 'anonymous verse'),
    h('span', { class: 'epigraph__corner epigraph__corner--tr' }, '— · —'),
    h('p', { class: 'epigraph__quote' },
      ...renderLyric(piece.fragment, pieceKey)
    ),
    h('span', { class: 'epigraph__corner epigraph__corner--br' }, isRevealed ? song.year : '???'),
  );

const Pieza = (state) => {
  // While playing a round, show the round-in-progress number; in the
  // revealed stage `pieces` already includes this round, so don't +1.
  const n = state.stage === 'revealed' ? state.pieces.length : state.pieces.length + 1;
  return h('div', { class: 'pieza' },
    h('span', { class: 'pieza__no' },
      'Verse ', h('em', {}, '№'), fmtN(n)),
    h('span', { class: 'pieza__score' },
      h('em', {}, state.score), 'pts'),
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
    return 'Nothing · +0';
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

const Final = (state) => {
  const played = state.pieces.length;
  const max = played * 2;
  const quip = quipFor(state.score, played);

  return h('div', { class: 'final' },
    Masthead(),
    h('h1', { class: 'final__head' }, 'End of the songbook.'),
    h('div', { class: 'final__big' },
      state.score,
      h('small', {}, `${state.score} pts of ${max} · ${played} verses`),
    ),
    played > 0
      ? h('blockquote', { class: 'final__quip' },
          quip.line,
          h('cite', {}, quip.cite),
        )
      : null,
    played > 0 ? Tally(state) : null,
    h('div', { class: 'actions' },
      h('button', { class: 'btn btn--primary', type: 'button', onclick: restart }, 'Play again →'),
      h('button', { class: 'btn btn--ghost',  type: 'button', onclick: backToIntro }, 'Back to start'),
    ),
  );
};

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

const start = async () => {
  await store.ready;
  store.subscribe(render);
  render(store.state);
};

start();
