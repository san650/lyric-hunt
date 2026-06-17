import { COMMANDS, isNoOp } from './commands.js';
import { History } from './history.js';
import { loadState, saveState, requestPersistence } from './db.js';
import { ARTISTS } from './lyrics.js';

// Top-level state shape:
//   schema:           shape version; bump when adding/removing fields so
//                     old persisted blobs get discarded instead of merged
//                     into the new defaults (and leaving holes like an
//                     empty `choices` mid-game)
//   screen:           'intro' | 'playing' | 'final'
//                     ('setup' was removed in schema 8 — collapsed into intro)
//   stage:            'artist' | 'revealed'   (within `playing`)
//   currentPiece:     { fragment, songId, fragmentId }  ← seeded on next()
//   choices:          array of artistId — the chips shown in artist stage
//   pickedArtistId:   the artistId the user clicked (set when leaving artist)
//   revealed:         null | { artistOk, timedOut }
//   score:            current streak — number of correct guesses in a row
//   pieces:           [{ songId, fragmentId, artistOk, pickedArtistId,
//                       timedOut, elapsedMs }]
//   seenKeys:         array of "songId:fragmentId" already drawn this game
//   roundStartedAt:   wall-clock millis when current round armed; used to
//                     compute per-piece elapsedMs on resolve. Independent of
//                     deadlineAt so untimed mode still measures answer time.
//   deadlineAt:       wall-clock millis for the artist-stage timer expiry
//                     (null when prefs.turnSec === 0, i.e. no-timer mode)
//   record:           lifetime [{ score, played, totalMs, when }]
//   prefs:            persisted user preferences ({ artistIds, turnSec })
//                     turnSec === 0 means no timer (unlimited per round)
//   playMode:         'normal' | 'daily'  (transient game-mode flag; daily
//                     mode forces turnSec=10 + full roster + seeded RNG)
//   dailySeed:        number | null — 32-bit seed for the daily RNG (set
//                     only while playMode === 'daily')
//   dailyResults:     { 'YYYY-MM-DD': { score, played, totalMs, when } }
//                     persisted per-day best result for the daily challenge

const SCHEMA = 8;
const DEFAULT_TURN_SEC = 8;

const defaultPrefs = () => ({
  artistIds: ARTISTS.map((a) => a.id),
  turnSec: DEFAULT_TURN_SEC,
});

const initialState = () => ({
  schema: SCHEMA,
  screen: 'intro',
  stage: 'artist',
  currentPiece: null,
  choices: [],
  pickedArtistId: null,
  revealed: null,
  // Transient flash overlay between artist pick and next-round/end-game.
  // Never persisted across reloads — see #hydrate.
  flash: null,
  score: 0,
  pieces: [],
  seenKeys: [],
  roundStartedAt: null,
  deadlineAt: null,
  record: [],
  prefs: defaultPrefs(),
  playMode: 'normal',
  dailySeed: null,
  dailyResults: {},
});

class Store {
  constructor() {
    this.state = initialState();
    this.history = new History();
    this.listeners = new Set();
    this.ready = this.#hydrate();
  }

  async #hydrate() {
    const persisted = await loadState();
    if (persisted?.state?.schema === SCHEMA) {
      // Drop `flash` on hydration: the setTimeout that advanced past it is
      // gone, so a persisted flash would freeze the screen forever.
      this.state = { ...initialState(), ...persisted.state, flash: null };
      if (persisted.history) this.history.hydrate(persisted.history);
    }
    // Older schemas are silently discarded — the user lands on the intro
    // screen instead of mid-game with a half-shaped state.
    requestPersistence();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #notify() { for (const fn of this.listeners) fn(this.state); }

  async #persist() {
    try {
      await saveState({ state: this.state, history: this.history.serialize() });
    } catch (err) {
      console.error('persist failed', err);
    }
  }

  // ── Lifecycle (not undoable; clears history) ─────────────────
  setLifecycle(patch) {
    this.state = { ...this.state, ...patch };
    this.history.clear();
    this.#persist();
    this.#notify();
  }

  // ── Undoable mutations ───────────────────────────────────────
  dispatch(cmd) {
    if (isNoOp(cmd)) return;
    const def = COMMANDS[cmd.type];
    if (!def) throw new Error(`Unknown command: ${cmd.type}`);
    const next = structuredClone(this.state);
    def.apply(next, cmd.payload);
    this.state = next;
    this.history.record(cmd);
    this.#persist();
    this.#notify();
  }

  undo() {
    const cmd = this.history.popUndo();
    if (!cmd) return null;
    const next = structuredClone(this.state);
    COMMANDS[cmd.type].revert(next, cmd.payload);
    this.state = next;
    this.history.pushFuture(cmd);
    this.#persist();
    this.#notify();
    return cmd;
  }

  redo() {
    const cmd = this.history.popRedo();
    if (!cmd) return null;
    const next = structuredClone(this.state);
    COMMANDS[cmd.type].apply(next, cmd.payload);
    this.state = next;
    this.history.pushPast(cmd);
    this.#persist();
    this.#notify();
    return cmd;
  }

  canUndo() { return this.history.canUndo(); }
  canRedo() { return this.history.canRedo(); }
}

export const store = new Store();
