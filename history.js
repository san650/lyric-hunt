import { coalesceKeyOf } from './commands.js';

const COALESCE_WINDOW_MS = 700;
const MAX_ENTRIES = 200;

export class History {
  constructor() {
    this.past = [];
    this.future = [];
  }

  hydrate({ past = [], future = [] } = {}) {
    this.past = Array.isArray(past) ? past.slice(-MAX_ENTRIES) : [];
    this.future = Array.isArray(future) ? future : [];
  }

  serialize() {
    return { past: this.past, future: this.future };
  }

  record(cmd) {
    const stamped = { ...cmd, t: Date.now() };
    const last = this.past[this.past.length - 1];
    if (
      last &&
      last.type === cmd.type &&
      coalesceKeyOf(last) === coalesceKeyOf(cmd) &&
      stamped.t - last.t < COALESCE_WINDOW_MS
    ) {
      this.past[this.past.length - 1] = {
        ...last,
        payload: { ...last.payload, to: cmd.payload.to },
        t: stamped.t,
      };
    } else {
      this.past.push(stamped);
      if (this.past.length > MAX_ENTRIES) this.past.shift();
    }
    this.future = [];
  }

  popUndo() { return this.past.pop() ?? null; }
  popRedo() { return this.future.pop() ?? null; }
  pushPast(cmd) { this.past.push(cmd); }
  pushFuture(cmd) { this.future.push(cmd); }
  clear() { this.past = []; this.future = []; }
  canUndo() { return this.past.length > 0; }
  canRedo() { return this.future.length > 0; }
}
