// Room card selections use the existing preference-sync engine. Cosmetic IDs only; no account or upload.
// The card itself — the store, the pref and the setters — lives in ui/seatArt.js (`{ charId, avatar }`); this module is
// the branch's sync face of it: `installCardSync` sends both fields (`room.card { charId, avatar }`), the seat-card
// portrait and the avatar beside it.
import { useStore, shallowEqual } from '../store.js';
import { data } from '../data.js';
import { cardStore, setCard, setCardAvatar, cardOperators, CARD_PREF } from './seatArt.js';
import { cardAvatarOperatorId, cardPortraitOperatorId, cleanPlayerCard } from '../../../shared/playerCard.js';
import { CARD_ROSTER, parseCardRoster } from '../../../shared/cardRoster.js';
import { installPrefSync } from './loadoutSync.js';

export { cardStore, CARD_PREF, setCard as setCardOperator, setCardAvatar };
export const useMyCard = () => useStore((s) => s, shallowEqual, cardStore);

/** Re-send after every welcome (including reconnect); ordered sends, retries and stale-await guards are shared.
 * A pick outside the room's list may still be an official operator of another period: the roster decides it before the
 * card is cleared (DESIGN §37.325). The branch sends both `{ charId, avatar }` fields. */
export function installCardSync({ net, target = cardStore, timers, ready = () => data.load('chess'),
  operators = () => cardOperators(data.list('chess')), rosterReady = () => data.load(CARD_ROSTER), roster = () => data.getRaw(CARD_ROSTER) } = {}) {
  return installPrefSync({
    net, timers, target, key: ['charId', 'avatar'], stateKey: 'sync', msgType: 'room.card', field: null, tag: 'card',
    prepare: async () => {
      const cur = target.get();
      if (!cur.charId && !cur.avatar) return cleanPlayerCard(null);
      if (await ready() == null) return null; // never erase a selection because game data is unavailable
      const ids = new Set(operators().map((c) => c.charId));
      const unknown = (v, ownerOf) => !!v && !ids.has(ownerOf(v));
      let allowed = (id) => ids.has(id);
      // a cross-period pick asks for the small roster, never another version's data; while it is missing, send nothing
      // (the server keeps the card it has) instead of clearing it
      if (unknown(cur.charId, cardPortraitOperatorId) || unknown(cur.avatar, cardAvatarOperatorId)) {
        if (await rosterReady() == null) return null;
        const parsed = parseCardRoster(roster());
        if (!parsed) return null;
        const rosterIds = parsed.ids;
        allowed = (id) => ids.has(id) || rosterIds.has(id);
      }
      return cleanPlayerCard(cur, allowed);
    },
  });
}
