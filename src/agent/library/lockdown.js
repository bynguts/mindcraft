import 'ses';

// This sets up the secure environment
// For configuration, see https://github.com/endojs/endo/blob/master/packages/ses/docs/lockdown.md

let lockeddown = false;
export function lockdown() {
  if (lockeddown) return;
  lockeddown = true;

  globalThis.lockdown({
    localeTaming: 'safe',
    consoleTaming: 'safe',
    errorTaming: 'safe',
    stackFiltering: 'verbose'
  });
}

export const makeCompartment = (endowments = {}) => {
  harden(endowments);

  return new Compartment({
    Math,
    Date,
    ...endowments
  });
}