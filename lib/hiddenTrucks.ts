/**
 * Trucks never offered for booking (test and retired units). Its own module,
 * with no imports, so light code (the AT&T soft-hold sync, pure tests) can use
 * it without pulling in the availability engine.
 */
export const HIDDEN_TRUCKS = new Set(['0001', '0002', '1257', '00001257', '1991'])
