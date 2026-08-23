/**
 * What does the app decide to do with a real episode, and why?
 * Read-only: inspects, never converts.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const prepare = require('../electron/prepare.js');

const files = process.argv.slice(2);
for (const file of files) {
  const plan = await prepare.inspect(file).catch((e) => ({ error: String(e && e.message) }));
  const tracks = await prepare.listTracks(file).catch(() => null);
  console.log(path.basename(file));
  console.log('   tier      :', plan.tier, '| needsWork', plan.needsWork, plan.error ? `| ERROR ${plan.error}` : '');
  console.log('   reason    :', plan.reason || '(none)');
  console.log('   audioIndex:', plan.audioIndex);
  if (tracks && tracks.audio) {
    for (const a of tracks.audio) {
      console.log(`   audio[${a.index}] ${a.codec} ${a.language || '??'} ${a.channels || '?'}ch ${a.title || ''}`);
    }
  }
  console.log('');
}
