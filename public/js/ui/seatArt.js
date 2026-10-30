// 名片干员 (PR #643 split 6): the portrait on a doctor's seat card in the waiting room (screens/room.js) and on the
// strategy draft's name cards (screens/bandDraft.js) — the operator the player picked (room.card; everybody sees it as
// room.state seats[].card), else one of the 5★/6★ operators chosen by the player id, the same on every client — worn in
// the player's outfit (seatCardSkin, the maintainer's decision 4 of 2026-10-21). The rules are pure: the screen passes
// the chess records (ui/assetUrls.js chessPortraitUrl turns the operator into its portrait; without the art pack the
// card keeps its avatar frame). The pick itself lives in `cardStore` (a pref; ui/playerCard.js installCardSync sends it).
// [ASSUMED] The event's card shows the account's assistant (名片形象, display_meta_table avatarTypeData ASSISTANT): this
// remake has no accounts, so the pick is made on one's own seat card and kept in this browser (CARD_PREF 'room.card').
// [ASSUMED] With no pick, a 5★/6★ operator is chosen by hash32(playerId) — a remake rule, so that every card has art as in
// the event's room and every client draws the same one.

import { createStore, loadPref, savePref } from '../store.js';
import { ownerSkin } from './skins.js';
import { chessPortraitUrl } from './assetUrls.js';
import { cardAvatarOperatorId, cardPortraitOperatorId, cleanPlayerCard } from '../../../shared/playerCard.js';

/** 名片干员: the player's own pick (a localStorage pref, sent as room.card). */
export const CARD_PREF = 'room.card';

/** The store field of the retired string-path pick and its sync state field (ui/loadoutSync.js installCardSync,
 * card-sync.test.js's harness); the branch's own store keeps `{ charId, avatar }` + `sync` (ui/playerCard.js). */
export const CARD_KEY = 'card';
export const CARD_SYNC_KEY = 'cardSync';

/** A stored pick as the store holds it: the branch's `{ charId, avatar }` (shared/playerCard.js). A plain charId string
 * of an older build becomes an avatar-less card; anything else reads as 默认. */
export function parseStoredCard(v) {
  if (typeof v === 'string') return cleanPlayerCard(v ? { charId: v, avatar: '' } : null);
  return cleanPlayerCard(v);
}

/** This browser's pick and its sync state (survives room / match resets like ui/skins.js' store). */
export const cardStore = createStore({ ...parseStoredCard(loadPref(CARD_PREF, null)), open: false, sync: 'idle', [CARD_SYNC_KEY]: 'idle' });

/**
 * Patch one's own card ({ charId, avatar }): persisted at once, the sync engine sends it.
 * @param {{ charId?: string, avatar?: string }} patch
 */
export function setPlayerCard(patch) {
  const next = parseStoredCard({ ...cardStore.get(), ...patch });
  try { savePref(CARD_PREF, next); } catch { /* private mode: the session keeps it */ }
  cardStore.set(next);
}
export const setCard = (charId) => setPlayerCard({ charId });
export const setCardAvatar = (avatar) => setPlayerCard({ avatar });

/** FNV-1a of a string (the default portrait: the same operator for a player on every client). */
function hash32(s) {
  let h = 0x811c9dc5;
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/**
 * The operators a seat card can show — the server's room.card whitelist (server/lobby.js chessCharIds): one record per
 * charId of the visible, non-自选, non-hidden chess records (the elite form, for its E2 art), 6★ first, then by name.
 * @param {any[]} chessList chess.json records
 * @returns {any[]}
 */
export function cardOperators(chessList) {
  const by = new Map();
  for (const c of Array.isArray(chessList) ? chessList : []) {
    if (!c || c.isDiy || c.isHidden || c.visible === false || typeof c.charId !== 'string') continue;
    const prev = by.get(c.charId);
    if (!prev || (c.isGolden && !prev.isGolden)) by.set(c.charId, c);
  }
  return [...by.values()].sort((a, b) => ((b.rarity ?? 0) - (a.rarity ?? 0)) || String(a.name).localeCompare(String(b.name), 'zh'));
}

/** Every viewer uses the seat owner's server-published choice, never their own local card. */
export function seatPortrait(seat, { pool, m }) {
  if (!seat || seat.playerId == null || !Array.isArray(pool) || !pool.length) return null;
  if (seat.isBot) return null;
  const chosen = pool.find((c) => c.charId === cardPortraitOperatorId(seat.card?.charId));
  if (chosen) return cardPortraitUrl(seat.card.charId, m, chosen);
  return chessPortraitUrl(m, pool[hash32(seat.playerId) % pool.length]);
}

/** Explicit profile portraits are independent of battle skins and avatars, just like profile avatars. */
export function cardPortraitUrl(choice, m, operator = null) {
  const charId = cardPortraitOperatorId(choice);
  if (!charId) return null;
  return chessPortraitUrl(m, operator || { charId, isGolden: true }, { skin: choice !== charId ? choice : null });
}

/** The skin outfits of an operator, from the optional skins catalogue (data/versions skins.json, docs/SKINS.md) with
 * the composed manifest (chars[charId].skins) proving the picture — only outfits that ship `key` ('portrait' / 'avatar')
 * and belong to `charId` are offered. */
export function cardPortraitSkins(charId, m, catalogue) {
  const list = catalogue?.chars?.[charId];
  return Array.isArray(list) ? list.filter((s) => cardPortraitOperatorId(s?.id) === charId && s.id !== charId
    && typeof m?.chars?.[charId]?.skins?.[s.id]?.portrait === 'string' && m.chars[charId].skins[s.id].portrait)
    .map((s) => ({ id: s.id, name: s.name, group: s.group || '' })) : [];
}

/** Resolve only manifest-listed avatars; a missing skin falls back to its operator's base icon. */
export function cardAvatarUrl(avatar, m) {
  const charId = cardAvatarOperatorId(avatar);
  if (!charId) return null;
  const rec = m?.chars?.[charId];
  return (avatar !== charId ? rec?.skins?.[avatar]?.avatar : null) || rec?.avatar || null;
}

/** Avatar files alone suffice: choosing a profile image never downloads or enables a battle skin model. */
export function cardAvatarSkins(charId, m, catalogue) {
  const list = catalogue?.chars?.[charId];
  if (!Array.isArray(list)) return [];
  return list.filter((skin) => cardAvatarOperatorId(skin?.id) === charId && skin.id !== charId
    && typeof m?.chars?.[charId]?.skins?.[skin.id]?.avatar === 'string' && m.chars[charId].skins[skin.id].avatar)
    .map((skin) => ({ id: skin.id, name: skin.name, group: skin.group || '' }));
}

/**
 * What the seat cards draw from: the pickable operators by charId and the default pool (5★/6★, by charId so every
 * client orders it the same).
 * @param {any[]} list cardOperators()
 */
export function cardContext(list) {
  return {
    byChar: new Map(list.map((c) => [c.charId, c])),
    pool: list.filter((c) => (c.rarity ?? 0) >= 5).sort((a, b) => (a.charId < b.charId ? -1 : a.charId > b.charId ? 1 : 0)),
  };
}

/**
 * The operator on a seat card: the player's pick (one's own seat shows the local pick at once, the others the server's
 * seats[].card), else one of the pool chosen by the player id [ASSUMED, see the header]. null for an empty seat, a bot,
 * or before the data loads.
 * @param {any} seat room.state seat
 * @param {{ byChar: Map<string, any>, pool: any[] }} ctx cardContext()
 * @param {{ myId?: any, myCard?: string }} [own]
 * @returns {{ chess: any, picked: boolean } | null}
 */
export function seatOperator(seat, { byChar, pool }, { myId, myCard } = {}) {
  if (!seat || seat.playerId == null || seat.isBot) return null;
  const raw = seat.playerId === myId ? myCard : seat.card;
  const pick = typeof raw === 'string' ? raw : raw?.charId || '';
  const rec = pick && byChar ? byChar.get(pick) : null;
  if (rec) return { chess: rec, picked: true };
  if (!Array.isArray(pool) || !pool.length) return null;
  return { chess: pool[hash32(seat.playerId) % pool.length], picked: false };
}

/**
 * The outfit a seat card's operator wears (docs/SKINS.md; the maintainer's decision 4 of 2026-10-21), by the rule of
 * every owner-aware card (ui/skins.js ownerSkin): one's own card wears this browser's choice at once (`localSkins`),
 * another doctor's the choice that seat published — `players` holds `{ playerId, skins }`: the room's seats
 * (room.state seats[].skins) or a match's public players — unless 「显示其他玩家的皮肤」 is off. null = the default art;
 * a skinId the local manifest does not hold (an appearance plugin this page lacks) also draws the default
 * (ui/assetUrls.js chessPortraitUrl falls back).
 * @param {any} seat a seat or player record (`playerId`, `isBot`)
 * @param {string | null | undefined} charId the operator the card shows (seatOperator)
 * @param {{ myId?: any, localSkins?: Record<string, string>, players?: any[], otherSkins?: boolean }} ctx
 * @returns {string | null}
 */
export function seatCardSkin(seat, charId, { myId = null, localSkins = {}, players = [], otherSkins = true } = {}) {
  if (!seat || seat.isBot || seat.playerId == null || !charId) return null;
  if (seat.playerId === myId) return ownerSkin(charId, { localSkins });
  return ownerSkin(charId, { ownerId: seat.playerId, myId, players: Array.isArray(players) ? players.filter(Boolean) : [], otherSkins });
}

/**
 * The picture a seat card draws: the first of `srcs` — the outfit's portrait, then the operator's default portrait — that
 * has not failed to load in this card (`failed`); null when none is left, and the card shows its avatar frame (§35.18's
 * leftover: an outfit file that failed went straight to the frame).
 * @param {(string | null | undefined)[]} srcs in order of preference
 * @param {readonly string[]} [failed]
 * @returns {string | null}
 */
export function seatArtSrc(srcs, failed = []) {
  for (const src of Array.isArray(srcs) ? srcs : []) if (src && !failed.includes(src)) return src;
  return null;
}
