// Reserved for future undoable mutations. The store / history machinery is
// wired up but no command kinds are currently registered — guess inputs are
// uncontrolled (read at submit time) and game lifecycle bypasses commands.
// To add an undoable mutation later, register it here with apply / revert /
// coalesceKey and dispatch `makeCommand('TYPE', { from, to })` from the view.

export const COMMANDS = {};

export const makeCommand = (type, payload) => ({ type, payload });

export const coalesceKeyOf = (cmd) =>
  `${cmd.type}:${COMMANDS[cmd.type].coalesceKey(cmd.payload)}`;

export const isNoOp = (cmd) => cmd.payload.from === cmd.payload.to;
