/* Close-up of the glyphs the skin will actually use, to judge subpixel colour
   fringing. Bare statements; returns a rect so shoot-state enlarges it 3x. */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await document.fonts.load('16px "IBM VGA 8x16"');
await document.fonts.ready;
const stage = document.createElement('div');
stage.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#0B0BB4;color:#fff;'
  + 'font-family:"IBM VGA 8x16";padding:16px;-webkit-font-smoothing:none;';
stage.innerHTML = `
  <div id="zoomme" style="font-size:16px;line-height:24px">
    <div>SOLID \u2588\u2588\u2588\u2588 HALVES \u2580\u2584\u258C ARROWS \u25BA\u25C4 SQUARE \u25A0</div>
    <div>DITHER \u2591\u2592\u2593 BOX \u2554\u2550\u2550\u2557 BAR [\u2588\u2588\u2588\u2588\u2588\u2591\u2591\u2591]</div>
    <div>TEXT AT SIXTEEN PIXELS \u00b7 S01E05 \u00b7 00:12:04</div>
  </div>`;
document.body.append(stage);
await wait(400);
const r = document.getElementById('zoomme').getBoundingClientRect();
return { x: r.x, y: r.y, width: Math.min(430, r.width), height: r.height };
