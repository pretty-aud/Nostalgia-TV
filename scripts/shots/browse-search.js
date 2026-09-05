/* The library page mid-search — the rail must be gone. Bare statements. */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
document.getElementById('btnBrowse').click();
await wait(900);
const box = document.getElementById('browseSearch');
box.focus();
box.value = 'the';
box.dispatchEvent(new Event('input', { bubbles: true }));
await wait(500);
