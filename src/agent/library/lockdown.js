import 'ses';

// This sets up the secure environment
// We disable some of the taming to allow for more flexibility

// For configuration, see https://github.com/endojs/endo/blob/master/packages/ses/docs/lockdown.md

let lockeddown = false;
export function lockdown() {
  if (lockeddown) return;
  lockeddown = true;

  // FIXED: Hapus unsafeEval untuk mengunci global eval() dan Function()
  // Ini mencegah LLM kabur dari Compartment sandbox (Security Patch).
  // Catatan: Pastikan 'npx patch-package' sudah dijalankan agar protodef tidak error.
  globalThis.lockdown({
    localeTaming: 'unsafe',
    consoleTaming: 'unsafe',
    errorTaming: 'unsafe',
    stackFiltering: 'verbose'
    // evalTaming secara default akan menjadi 'safeEval' (aman)
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