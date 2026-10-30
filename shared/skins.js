// Cosmetic preferences only: never change operator definitions or simulation rules.
// One definition for the browser's store and the wire (docs/SKINS.md): `shared/protocol.js` imports and re-exports it.
// `entries` is the wire's cap on a `{ [charId]: skinId }` selection: the vanilla roster already holds 210 operators
// (test/skins.test.js), so 256 is the floor that fits a full selection. `charIdLen` bounds the operator key; `idLen`
// bounds the skinId value.
export const SKIN_LIMITS = Object.freeze({ entries: 256, idLen: 64, charIdLen: 64 });
// The first character is an operator-id character, so a leading `@`/`#`/`+`/`.`/`-` is refused.
export const isSkinId = (v) => typeof v === 'string' && v.length > 0
  && v.length <= SKIN_LIMITS.idLen && /^[A-Za-z0-9_][A-Za-z0-9_@#+.\-]*$/.test(v);
