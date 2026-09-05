/* The library page filtered to two genres, rail suppressed. Bare statements. */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
document.getElementById('btnBrowse').click();
await wait(900);
document.getElementById('btnGenreFilter').click();
await wait(300);
// Re-queried after each click: renderGenreFilter rebuilds the whole list, so
// the second lookup must not hold a node from before the first.
const pick = (name) => [...document.querySelectorAll('#genreMenuList .genreopt')]
  .find((o) => o.textContent.startsWith(name)).click();
pick('Anime');
await wait(250);
pick('Horror');
await wait(450);
