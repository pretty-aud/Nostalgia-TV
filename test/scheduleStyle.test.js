import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { activeBumperStyleId, DEFAULT_SETTINGS } from '../src/shared/scheduler.js';
import { resolveStyle, BUILTIN_STYLES } from '../src/shared/bumperStyles.js';

/**
 * A SCHEDULE CAN CHOOSE ITS OWN UP-NEXT CARD.
 *
 * Saturday mornings announcing itself over the schedule card while a late-night
 * block uses the box office. The decision lives in the scheduler so it can be
 * ASKED rather than greped — the last per-schedule rule this session added was
 * first written as an `if` inside boot(), where a test could only check the
 * shape of the source and passed while the rule sat in the wrong place.
 */
const SCHEDULES = [
  { id: 'sat', name: 'Saturday', items: ['alpha'], bumperStyle: 'cewr' },
  { id: 'late', name: 'Late night', items: ['beta'], bumperStyle: 'boxoffice' },
  { id: 'plain', name: 'Plain', items: ['gamma'] },        // saved before the field existed
  { id: 'explicit', name: 'Explicit', items: [], bumperStyle: null },
];

const withSchedule = (id) => ({ ...DEFAULT_SETTINGS, schedules: SCHEDULES, activeScheduleId: id });

describe('which up-next style is in force', () => {
  it('takes the running schedule\'s own choice', () => {
    expect(activeBumperStyleId(withSchedule('sat'))).toBe('cewr');
    expect(activeBumperStyleId(withSchedule('late'))).toBe('boxoffice');
  });

  it('lets two schedules disagree, which is the whole point', () => {
    expect(activeBumperStyleId(withSchedule('sat')))
      .not.toBe(activeBumperStyleId(withSchedule('late')));
  });

  /**
   * INHERIT IS THE MIGRATION. Every schedule already on her disk predates this
   * field and reads undefined; undefined is falsy and falls through to the
   * global. If this ever returned a concrete default instead, every existing
   * schedule would silently acquire a style she never picked.
   */
  it('inherits the app setting when the schedule says nothing', () => {
    const settings = { ...withSchedule('plain'), bumperStyle: 'boxoffice' };
    expect(activeBumperStyleId(settings)).toBe('boxoffice');
  });

  it('treats an explicit null the same as absent', () => {
    const settings = { ...withSchedule('explicit'), bumperStyle: 'cewr' };
    expect(activeBumperStyleId(settings)).toBe('cewr');
  });

  it('inherits when no schedule is running at all', () => {
    const settings = { ...DEFAULT_SETTINGS, schedules: SCHEDULES, activeScheduleId: null, bumperStyle: 'cewr' };
    expect(activeBumperStyleId(settings)).toBe('cewr');
  });

  it('inherits when the active id names a schedule that was deleted', () => {
    const settings = { ...withSchedule('gone'), bumperStyle: 'boxoffice' };
    expect(activeBumperStyleId(settings)).toBe('boxoffice');
  });

  /**
   * It must NOT resolve. resolveStyle falls back to the default for anything it
   * does not recognise, so resolving inside this function would turn "inherit"
   * into "explicitly the still menu" — the one answer that cannot afterwards be
   * told apart from a real choice.
   */
  it('returns an id, leaving the fallback to the caller', () => {
    const settings = { ...withSchedule('plain'), bumperStyle: null };
    expect(activeBumperStyleId(settings)).toBe(null);
    expect(resolveStyle(activeBumperStyleId(settings)).id).toBe('still');
  });
});

describe('the schedule editor\'s style menu', () => {
  const HTML = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
  /**
   * COMMENTS STRIPPED — twice now this session a source assertion has read the
   * prose explaining a rule instead of the rule. Here it was subtler: the
   * blankSchedule check used a fixed-width window, and the comment written
   * beside the new field pushed the field itself outside it. Stripping first
   * makes the window measure code.
   */
  const JS = readFileSync(new URL('../src/renderer/index.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');

  it('ships a styled select in the editor', () => {
    expect(HTML).toMatch(/<select class="select" id="schedStyle"/);
  });

  /**
   * ONE LIST. The theme menu is 35 hand-written options beside a separate
   * array, and five palettes shipped that nobody could select past a green
   * suite. Every menu built since is built from its array.
   *
   * Scoped to THIS select, not to the whole file. The first version asked that
   * no style id appear as any value= anywhere, and failed on
   * `<option value="still">` in the BACKDROP menu — a different control whose
   * option happens to share a word with a style id. An assertion that broad
   * stops describing the rule it was written for.
   */
  it('builds its options from BUILTIN_STYLES rather than writing them out', () => {
    const tag = /<select class="select" id="schedStyle"[^>]*>([\s\S]*?)<\/select>/.exec(HTML);
    expect(tag, 'the schedStyle select is missing').toBeTruthy();
    expect(tag[1].trim(), 'its options belong to BUILTIN_STYLES, not to the markup').toBe('');
    expect(JS).toMatch(/styleMenu[\s\S]{0,400}for \(const style of BUILTIN_STYLES\)/);
  });

  it('offers inherit, and offers it first', () => {
    expect(JS).toMatch(/inherit\.value = ''/);
    expect(JS).toMatch(/styleMenu\.append\(inherit\)[\s\S]{0,200}for \(const style of BUILTIN_STYLES\)/);
  });

  it('writes null for inherit, so the saved shape means one thing', () => {
    expect(JS).toMatch(/draft\.bumperStyle = event\.target\.value \|\| null/);
  });

  it('starts a new schedule inheriting', () => {
    expect(JS).toMatch(/function blankSchedule\(\)[\s\S]{0,300}bumperStyle: null/);
  });

  it('shows inherit for a style this build no longer ships', () => {
    // A stale id must not read as a deliberate choice she never made — what it
    // will actually do is inherit, so that is what the menu must say.
    expect(JS).toMatch(/BUILTIN_STYLES\.some\(\(s\) => s\.id === own\) \? own : ''/);
  });
});

/**
 * The two places that decide what actually plays must both ask the schedule.
 * Reading settings.bumperStyle directly at either one gives a card and a
 * backdrop that disagree — the box office playing on gradient alone, with the
 * failure looking like the clip pipeline rather than like a missed call site.
 */
describe('the playback path', () => {
  const JS = readFileSync(new URL('../src/renderer/index.js', import.meta.url), 'utf8');

  it('asks for the schedule\'s style when choosing the card', () => {
    expect(JS).toMatch(/resolveStyle\(activeBumperStyleId\(state\.settings\)\)/);
  });

  it('asks for it again when deciding whether to cut a backdrop', () => {
    expect(JS).toMatch(/activeBumperStyleId\(state\.settings\) !== 'boxoffice'/);
  });

  it('leaves the settings sheet reading the global, which is what it edits', () => {
    // The picker in Settings sets the app-wide default; showing it a schedule's
    // override would make the control lie about what it writes.
    expect(JS).toMatch(/resolveStyle\(state\.settings\.bumperStyle\)/);
  });
});
