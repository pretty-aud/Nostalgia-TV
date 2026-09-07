/**
 * THE TWO CONDENSED FACES: do they load, and are they actually condensed?
 *
 * Both questions need asking separately, because the failure modes look
 * identical on screen. A face that fails to load silently falls back, and the
 * card just comes out in the wrong type — no error, no warning, and the only
 * tell is that it looks slightly off in a screenshot nobody is comparing.
 *
 * Bare statements; throws so shoot-all gates on it.
 *
 * Failing controls, each RUN:
 *   - point the @font-face src at a filename that does not exist and it throws
 *     "Roboto Condensed did not load";
 *   - change the src to a face that is NOT condensed (inter.woff2) and it
 *     throws "Roboto Condensed is not condensed".
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(400);

const stage = document.createElement('div');
stage.style.cssText = 'position:fixed;left:24px;top:24px;z-index:99999;background:#000;'
  + 'padding:28px 34px;color:#fff;width:760px;';
document.body.append(stage);

/**
 * Measured against a family that CANNOT resolve, not against a bare fallback.
 *
 * document.fonts.check() answers "is a face matching this description
 * available", which is not the same as "did my file load" — it can be
 * satisfied by a system font of the same name. Setting the same text twice,
 * once with the real family in front of a shared fallback and once with a
 * deliberate nonsense family in front of the SAME fallback, cannot be fooled
 * that way: if the woff2 never arrived, both fall through to the fallback and
 * measure identically.
 */
const NONSENSE = 'zzz-no-such-family-zzz';
const SPECIMEN = 'UP NEXT HANDLING 0123';

const measure = (family, weight) => {
  const el = document.createElement('span');
  el.textContent = SPECIMEN;
  el.style.cssText = `font-family:${family};font-weight:${weight};font-size:64px;`
    + 'white-space:nowrap;position:absolute;visibility:hidden;';
  stage.append(el);
  const width = el.getBoundingClientRect().width;
  el.remove();
  return width;
};

const FACES = [
  { family: 'Roboto Condensed', weight: 700 },
  { family: 'Oswald', weight: 600 },
];

/**
 * The load is REQUESTED, and its rejection is swallowed on purpose.
 *
 * A missing woff2 makes document.fonts.load reject with something that
 * arrives through executeJavaScript as an empty message, so letting it
 * propagate reported the failure as "SNIPPET FAILED: undefined" — a probe
 * that detects the problem and then refuses to say what it was. The width
 * comparison below finds the same fault and can describe it, so this call is
 * only here to make sure the face has been ASKED for before anything is
 * measured; whether it arrived is not its verdict to give.
 */
for (const face of FACES) {
  try {
    await document.fonts.load(`${face.weight} 64px "${face.family}"`);
  } catch { /* the measurement below is the verdict */ }
}
await wait(300);

for (const face of FACES) {
  const real = measure(`"${face.family}", ${NONSENSE}, monospace`, face.weight);
  const absent = measure(`"${NONSENSE}", monospace`, face.weight);
  if (Math.abs(real - absent) < 1) {
    throw new Error(`${face.family} did not load — it measures the same as the fallback `
      + `(${real.toFixed(1)}px vs ${absent.toFixed(1)}px)`);
  }

  /**
   * Condensed means NARROWER THAN THE INTERFACE FACE at the same size. Inter
   * is already loaded and is a normal-width grotesque, so it is the honest
   * comparison — and it is the comparison that fails if someone points this
   * @font-face at a face that is not condensed at all.
   */
  const normal = measure('Inter, sans-serif', face.weight);
  const ratio = real / normal;
  if (ratio > 0.9) {
    throw new Error(`${face.family} is not condensed — ${(ratio * 100).toFixed(0)}% `
      + `of Inter's width (${real.toFixed(1)}px vs ${normal.toFixed(1)}px)`);
  }
  face.ratio = ratio;
}

// A specimen to actually look at, since "it loaded" and "it looks right" are
// different questions and only one of them can be automated.
stage.innerHTML = FACES.map((face) => `
  <div style="font-family:'${face.family}';font-weight:${face.weight};font-size:56px;
              letter-spacing:0.01em;line-height:1.15;">UP NEXT</div>
  <div style="font-family:Inter,sans-serif;font-size:13px;color:#8b8b93;
              margin:2px 0 22px;">${face.family} ${face.weight}
       — ${(face.ratio * 100).toFixed(0)}% of Inter's width</div>
`).join('');
await wait(300);

const box = stage.getBoundingClientRect();
return {
  x: box.x, y: box.y, width: box.width, height: box.height,
};
