/* The library page with the genre menu open. Bare statements. */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
document.getElementById('btnBrowse').click();
await wait(900);
document.getElementById('btnGenreFilter').click();
await wait(400);
