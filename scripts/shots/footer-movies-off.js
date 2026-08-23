// Sidebar footer with the movie switch OFF, so its dimmed state can be seen
// next to the settings gear it sits beside.
const button = document.getElementById('btnMovies');
if (!button) throw new Error('btnMovies is not in the markup');
if (button.hidden) throw new Error('btnMovies is hidden — the stub library has no movies');
if (button.getAttribute('aria-pressed') !== 'false') button.click();
await new Promise((r) => setTimeout(r, 400));
if (button.getAttribute('aria-pressed') !== 'false') throw new Error('the switch did not turn off');

const box = document.querySelector('.footactions').getBoundingClientRect();
return { x: box.left - 24, y: box.top - 10, width: box.width + 48, height: box.height + 20 };
