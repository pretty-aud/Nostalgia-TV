// A few library rows, to check the labelled counts still fit the sidebar.
await new Promise((r) => setTimeout(r, 900));
const rows = [...document.querySelectorAll('#showList .show')];
if (rows.length < 4) throw new Error('the library did not load');
const first = rows[0].getBoundingClientRect();
const last = rows[Math.min(5, rows.length - 1)].getBoundingClientRect();
return { x: 0, y: first.top - 8, width: 348, height: (last.bottom - first.top) + 16 };
