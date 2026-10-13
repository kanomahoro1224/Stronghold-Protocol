# 干员皮肤 (Operator skins)

An operator's Spine model and avatar can be replaced by one of its official alternative outfits (时装). Written to
be **portable**: nearly everything lives in new files, and the handful of edits to existing ones are listed below
line by line so they can be re-applied after merging an upstream release.

> Line numbers are as of the commit that added this document and will drift. The anchor (the enclosing function or
> section) is the durable part.

## How it works

```
docs/research/08-skins.json        what EXISTS upstream (273 skins / 174 operators) — a static list, like the other
        │                          research tables; never fetched at build time
        ├── tools/build-skins.mjs ──→ data/skins.json          the catalogue the CLIENT reads: id, name, series.
        │                                                      No URLs.
        │
        └── tools/install-skins.mjs  downloads every skin ahead of time (7 files each) and splices it into
                 │                   data/assets.json + data/skins-installed.json        ← build time, never in-game
                 │
                 └── data/assets.json ────→ chars[charId].skins[skinId] = { spine:{front,back?}, avatar, name, group }
                            │
                            └── server/resources.js ──→ /data/resource-manifest.json   (可选资源: tierForPath() puts
                                                          the `skins` segment in 可选, so the client caches them
                                                          from the CDN only when 同时预载 is on)

player picks a skin ──→ room.skins ──→ PlayerState.skins ──→ Match.publicView().players[].skins   (PUBLIC: teammates see it)
                                              │
                                              └── battleInput() u.skin ──→ snapshot ──→ renderer ──→ spineEntry(m, id, {skin})
```

Three properties are load-bearing:

- **Skins ship with the install; nothing is installed from inside the game.** All 273 skins (~330 MB) are downloaded
  by `tools/install-skins.mjs` and uploaded to the asset CDN. There is no 「安装」 button and no `room.skin.install`
  message: the picker offers every catalogue skin this install's manifest can draw, and the renderer fetches its model
  from the CDN on demand. An operator the catalogue has no skin for simply shows no 皮肤 section. They are **可选资源**
  in the preload (`server/resources.js` `tierForPath()`), so 同时预载 has to be on for the client to cache them.
- **The skin *choice* is keyed by chess id; the skin *catalogue* and the asset manifest are keyed by operator id.**
  A chess record is `chess_char_1_01_a` and carries `charId: char_498_inside`. Mixing the two is silent: the picker
  renders an empty section and `setSkins` drops every entry.
- **A skin model must go through the build-time spine pipeline.** `resolveRoles()` runs offline in
  `tools/assets/spine.mjs`, and the client's `validSpine()` requires the `anims` it produces. A model that skipped
  that step fails to load and leaves the unit on its placeholder avatar forever — invisible until someone looks at
  the board. `installSkins()` therefore builds its models through the same `fexliModelDef()` the full plan uses.

## New files

| Path | What |
|---|---|
| `docs/research/08-skins.json` | Static research table: `{ meta, skins: { [charId]: [{ skinId, stem, name, group, avatar, battleSpine }] } }` |
| `tools/build-skins.mjs` | `docs/research/08-skins.json` → `data/skins.json` |
| `tools/install-skins.mjs` | Build-time downloader: `list` / `add` / `remove` / `add-char`; splices each skin into the manifest |
| `data/skins.json` | The client's catalogue (no URLs) |
| `data/skins-installed.json` | Which skin ids this install downloaded — the record `tools/fetch-assets.mjs` reads |
| `public/js/ui/skins.js` | Client store + `room.skins` sync |
| `public/js/ui/skinPicker.js` | The 皮肤 section of 干员调配 (self-contained: `screens/loadout.js` only names it) |
| `test/skins.test.js`, `test/skins-protocol.test.js`, `test/skins-lifecycle.test.js`, `test/ui/skins.e2e.test.js` | Lookup, wire format, end-to-end lifecycle, real-browser picker |

## Edits to existing files

| File | Where | What |
|---|---|---|
| `shared/protocol.js` | before `isLoadoutEntries` | `SKIN_LIMITS`, `isSkinId`, `isSkinSelection`. **`isSkinId` cannot be `isId`**: that allows only `[A-Za-z0-9_\-.:]` and skin ids carry `@` and `#` |
| `shared/protocol.js` | `C2S` table | `'room.skins'` |
| `server/net.js` | `HEAVY_TYPES` | `'room.skins'` |
| `server/net.js` | `Session` ctor | `this.skins = null` |
| `server/lobby.js` | after `freezeLoadout` | `freezeSkins()` — the same gate as `checkLoadout` (`isGolden` / `visible === false` / `isHidden` / `isDiy` / `baseId !== id`) |
| `server/lobby.js` | `onMessage` | `case 'room.skins'` |
| `server/lobby.js` | after `loadout()` | `skins()` — no phase gate (unlike the loadout: a skin is cosmetic and public) |
| `server/lobby.js` | `humanSeat()` & `startMatch()` | passes `skins` from session to seat and from room seats to `new Match()` |
| `server/match/Match.js` | after `setLoadout` | `setSkins()` — any phase, `markPublic()` |
| `server/match/Match.js` | `publicView().players[]` | `...(Object.keys(ps.skins).length ? { skins: ps.skins } : {})` — omitted when empty, so the payload is unchanged for players with no skins |
| `server/match/Match.js` | prep view units | `skin: ps.skins?.[rec?.baseId || piece.id] || ps.skins?.[piece.id]` — supports both base and golden/promoted pieces |
| `server/match/PlayerState.js` | ctor | `this.skins = Object.freeze({})` + restore from `seat.skins` |
| `server/match/PlayerState.js` | after `setLoadout` | `setSkins()` — bots refused, same gate as above, calls `this.dirty()` |
| `server/match/PlayerState.js` | `battleInput()` | `const baseId = (rec && rec.baseId) || piece.id; const skin = this.skins[baseId] || this.skins[piece.id]; if (skin) u.skin = skin;` — preserves skin when upgraded to golden |
| `server/match/PlayerState.js` | `pieceView()` | includes `skin` on prep board/hand/temp piece views |
| `server/sim/snapshot.js` | `unitInfo()` | `skin: u.skin ?? undefined` — **`undefined`, not `null`**: `JSON.stringify` drops it, so the `DESIGN §8.2` wire-format contract test still passes and an install with no skins is byte-identical to before |
| `public/js/assets.js` | `spineEntry()` | `opts.skin` → `chars[id].skins[id].spine`, else the operator's own model |
| `public/js/assets.js` | `avatarUrl()` & `hasBackSpine()` | supports `opts.skin` for avatar; `hasBack(id, skinId)` forwards skin |
| `public/js/render/units.js` | `_loadSpine()` & `_loadPicture()` | passes `skin: this.info.skin` to spine and avatar diamond fallback |
| `public/js/render/units.js` | `_wantsBack()` | asks `hasBack(id, this.info.skin)` |
| `public/js/render/app.js` | `pieceInfo()` and `addInfo()` | `skin: piece.skin ?? skinFor(baseId) ?? null` / `skin: u.skin ?? null`; `sig` includes `skin` to drop cache on switch |
| `public/js/data.js` | `DATA_FILES` | `skins: 'skins.json'` |
| `public/js/ui/gameComponents.js` | `GAME_FILES` | `'skins'` — `test/ui/playtest3.test.js` requires every file the in-match UI reads to be awaited by the match screen, and 干员调配 is reachable during a match |
| `public/js/screens/loadout.js` | imports + `Detail()` | import `SkinSection`, then `<${SkinSection} chess=${chess} />`. **Two lines** — the section itself is entirely in `ui/skinPicker.js` |
| `public/js/main.js` | imports + boot | `installSkinsSync({ net })` |
| `public/css/screens/loadout.css` | end | `.lo-skins` / `.lo-skin` tiles (mirrors `.lo-mods`) |
| `data/assets.json` | — | regenerated; carries `chars[charId].skins` for every skin in `data/skins-installed.json` |

Skins need one line in `server/resources.js`: `collectResourceFiles()` walks the whole asset manifest, so the skin
models and avatars become preload entries by themselves, but `tierForPath()` would classify them as 必备 like every
other `chars.*` path. Its optional-segment list therefore carries `skins` — `chars.<charId>.skins.<skinId>.*` is the
only path with that segment — so the whole set lands in 可选资源 with its own 干员皮肤 category
(`public/js/resources/common.js` `resourceGroup()`).

## Regenerating the asset side

```
node tools/build-skins.mjs                                   # docs/research/08-skins.json → data/skins.json
node tools/install-skins.mjs list [text]                     # what exists / what is downloaded
node tools/install-skins.mjs add <skinId…>                   # download (resumable; safe to interrupt)
node tools/install-skins.mjs add-char <charId…>              # every skin of those operators
node tools/install-skins.mjs remove <skinId…>                # drop from the manifest (files stay on disk)
npm run assets                                               # rebuilds the manifest from the selection file
```

`tools/fetch-assets.mjs` only builds the skins listed in `data/skins-installed.json`, so a full run never
re-downloads one that was removed **and** drops it from the manifest — matching what the installer writes. Run the
downloader for every skin in the catalogue, then upload `public/assets/` (and `data/`) to the CDN: the game reads
them from there, and there is no server-side install to fall back on.

**在部署机上跑，不要在本机跑**（用户要求 2026-10-11）：本机到 GitHub 约 0.08 MB/s，部署机约 1–3.5 MB/s，而
`public/assets/spine/op` 有 500 MB 左右。流程是把 `tools/`、`docs/research/08-skins.json`、`data/skins.json` 传到
部署机，在仓库根目录 `node tools/install-skins.mjs add-char <全部干员>`（**不要**同时传 `data/skins-installed.json`，
否则会被当成已装而全部跳过），装完再用同一台机器把 `public/assets/spine/op`、`public/assets/char/avatar/skin` 和
`data/` 推到 R2。是否已在桶里用上传脚本的 `--dry-run` 判断（它读对象头，权威）；CDN 的 HEAD 会命中边缘缓存的旧
404，不能作为依据。

Upstream sources: `fexli/ArknightsResource` (`spine/{charId}/{stem}/{Front,Back}/`) for the models,
`yuanyan3060/ArknightsGameResource` (`avatar/{avatarId}.png`) for the 180×180 thumbnails, and Kengxxiao's
`skin_table.json` for the names and series. Two naming rules, both verified:

```
stem   = skinId.replace(/@/g, '_').replace(/#/g, '_')      char_002_amiya@winter#1 → char_002_amiya_winter_1
avatar = 'avatar/' + encodeURIComponent(avatarId) + '.png'  avatarId comes from skin_table, NOT from the skinId
```

A default outfit is a `charSkins` entry whose `displaySkin.skinGroupName` is `默认服装` (or whose `skinName` is
empty); only the rest are skins. The catalogue's 273 come from that table, so its spelling of a series
(`ambienceSynesthesia`) is the one to keep.

The full skin art (`skin/{portraitId}b.png`) is deliberately **not** used: at ~2.5 MB each it would add ~680 MB,
more than the entire rest of the asset set, for a thumbnail.

## Known limitations

- **No skin effects.** The official per-character battle effects are `.ab` particle bundles that the project does
  not extract (`docs/ASSETS.md`); battle FX stay procedural.
- **No operator voices.** A separate piece of work; the files exist (`ArknightsAssets2`, `voice` branch) but there
  is no event→line mapping or playback path yet.
- **Bots always wear the default model** (`setSkins` refuses bots, as `setLoadout` does).
- **The whole set is 可选资源.** It is ~330 MB, so it is only cached when the player enables 预载资源 **and** ticks
  同时预载; without it every skin still works — the renderer fetches the model from the CDN on demand, exactly like an
  un-preloaded voice line.
- **`remove` leaves the files on disk.** They are shared between skins and a re-add would only fetch them again;
  `npm run assets --prune` clears the orphans.
