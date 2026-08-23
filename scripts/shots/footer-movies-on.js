// The same footer with the movie switch ON — the pair is the only way to tell
// whether "off" reads as switched off rather than as broken.
const button = document.getElementById('btnMovies');
if (!button) throw new Error('btnMovies is not in the markup');
if (button.hidden) throw new Error('btnMovies is hidden — the stub library has no movies');
if (button.getAttribute('aria-pressed') !== 'true') button.click();
await new Promise((r) => setTimeout(r, 400));
if (button.getAttribute('aria-pressed') !== 'true') throw new Error('the switch did not turn on');

const box = document.querySelector('.footactions').getBoundingClientRect();
return { x: box.left - 24, y: box.top - 10, width: box.width + 48, height: box.height + 20 };
