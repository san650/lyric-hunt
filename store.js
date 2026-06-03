import { COMMANDS, isNoOp } from './commands.js';
import { History } from './history.js';
import { loadState, saveState, requestPersistence } from './db.js';

// Top-level state shape:
//   schema:           shape version; bump when adding/removing fields so
//                     old persisted blobs get discarded instead of merged
//                     into the new defaults (and leaving holes like an
//                     empty `choices` mid-game)
//   screen:           'intro' | 'playing' | 'final'
//   stage:            'artist' | 'bonus' | 'revealed'   (within `playing`)
//   currentPiece:     { fragment, songId, fragmentId }  ← seeded on next()
//   choices:          array of artistId — the chips shown in artist stage
//   pickedArtistId:   the artistId the user clicked (set when leaving artist)
//   bonusGuess:       what the user typed (set when leaving bonus)
//   revealed:         null | { artistOk, bonusMatch: 'song'|'album'|null, points: 0..2 }
//   score:            total accumulated points
//   pieces:           [{ songId, fragmentId, points, skipped, artistOk, bonusMatch }]
//   seenKeys:         array of "songId:fragmentId" already drawn this game

const SCHEMA = 4;

const initialState = () => ({
  schema: SCHEMA,
  screen: 'intro',
  stage: 'artist',
  currentPiece: null,
  choices: [],
  pickedArtistId: null,
  bonusGuess: '',
  revealed: null,
  score: 0,
  pieces: [],
  seenKeys: [],
  // Wall-clock timestamp set on startGame; the playing screen renders a
  // live clock against this, and endGame folds the elapsed time into the
  // record entry. Null on intro/final.
  startedAt: null,
  // Lifetime record of finished games. Each entry:
  //   { score, played, when, elapsed }
  // `endGame` appends one; persists across reloads and across games.
  record: [],
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
      this.state = { ...initialState(), ...persisted.state };
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
