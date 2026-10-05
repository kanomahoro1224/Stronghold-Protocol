// regenerate public/fonts/fonts.css from the already-downloaded font files (no network).
import { buildFonts } from '../tools/assets/fonts.mjs';
const r = await buildFonts(new URL('../public/fonts/', import.meta.url).pathname.replace(/^\//, ''), (m) => console.log(m));
console.log('errors:', r.errors.length ? r.errors : 'none');
console.log('css written:', !!r.css);
