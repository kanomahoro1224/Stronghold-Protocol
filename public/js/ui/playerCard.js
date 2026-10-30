// Room card selections use the existing preference-sync engine. Cosmetic IDs only; no account or upload.
// The card itself — the store, the pref and the setters — lives in ui/seatArt.js (`{ charId, avatar }`); this module is
// the branch's sync face of it: `installCardSync` sends both fields (`room.card { charId, avatar }`), the seat-card
// portrait and the avatar beside it.
import { useStore, shallowEqual } from '../store.js';
import { data } from '../data.js';
import { cardStore, setCard, setCardAvatar, cardOperators, CARD_PREF } from './seatArt.js';
import { cleanPlayerCard } from '../../../shared/playerCard.js';
import { installPrefSync } from './loadoutSync.js';

export { cardStore, CARD_PREF, setCard as setCardOperator, setCardAvatar };
export const useMyCard = () => useStore((s) => s, shallowEqual, cardStore);

/** Re-send after every welcome (including reconnect); ordered sends, retries and stale-await guards are shared. */
export function installCardSync({ net, target = cardStore, timers, ready = () => data.load('chess'), operators = () => cardOperators(data.list('chess')) } = {}) {
  return installPrefSync({
    net, timers, target, key: ['charId', 'avatar'], stateKey: 'sync', msgType: 'room.card', field: null, tag: 'card',
    prepare: async () => {
      if (!target.get().charId && !target.get().avatar) return cleanPlayerCard(null);
      if (await ready() == null) return null; // never erase a selection because game data is unavailable
      const ids = new Set(operators().map((c) => c.charId));
      return cleanPlayerCard(target.get(), (id) => ids.has(id));
    },
  });
}
