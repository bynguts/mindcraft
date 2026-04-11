import 'ses';

// This sets up the secure environment
// We disable some of the taming to allow for more flexibility

// For configuration, see https://github.com/endojs/endo/blob/master/packages/ses/docs/lockdown.md

let lockeddown = false;
export function lockdown() {
  if (lockeddown) return;
  lockeddown = true;




  globalThis.lockdown({
    localeTaming: 'unsafe',
    consoleTaming: 'unsafe',
    errorTaming: 'unsafe',
    stackFiltering: 'verbose'

  });
}

export const makeCompartment = (endowments = {}) => {
  return new Compartment({
    // provide untamed Math, Date, etc
    Math,
    Date,
    // standard endowments
    ...endowments
  });
}