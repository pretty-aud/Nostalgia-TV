import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'acorn';

/**
 * THE NAME THAT ISN'T THERE.
 *
 * `prefFor` — the one-line reader for a show's saved audio and subtitle
 * preference — was deleted as collateral when the mpv switchover removed the
 * conversion-era block it happened to sit inside. Its four callers stayed.
 * Nothing complained: esbuild bundles a free identifier without a murmur (it
 * is a legal reference to a global that might exist at runtime), and three of
 * the four callers sit in async functions whose rejection nobody awaits, so
 * the ReferenceError became SILENCE. The audio and subtitle menus opened
 * empty on every dual-audio file, the per-show language preference never
 * applied, and the auto-crop never ran — for a whole build, found by a viewer
 * and not by 512 tests.
 *
 * The check: parse each source file, collect every name DECLARED anywhere in
 * it, and flag every name USED that is neither declared nor a known global.
 *
 * Deliberately flat rather than scope-aware. A name declared in some other
 * block of the same file is not reported, so this cannot produce a scoping
 * false positive — it answers exactly one question, "does this identifier
 * exist in this file at all", which is the question the failure asked.
 */

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** Environment names the sources may legitimately reach for. */
const GLOBALS = new Set([
  // browser
  'window', 'document', 'console', 'navigator', 'location', 'history', 'screen',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
  'cancelAnimationFrame', 'queueMicrotask', 'fetch', 'URL', 'URLSearchParams', 'Blob',
  'FileReader', 'File', 'FormData', 'Image', 'Audio', 'Option', 'Event', 'CustomEvent',
  'AbortController', 'IntersectionObserver', 'ResizeObserver', 'MutationObserver',
  'localStorage', 'sessionStorage', 'performance', 'crypto', 'structuredClone',
  'getComputedStyle', 'matchMedia', 'alert', 'HTMLElement', 'Node', 'Element', 'CSS',
  'DOMParser', 'Response', 'Request', 'Headers',
  // language
  'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date', 'RegExp',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Symbol', 'Error', 'TypeError',
  'RangeError', 'Infinity', 'NaN', 'undefined', 'globalThis', 'Intl', 'Proxy',
  'Reflect', 'BigInt', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'Uint8Array', 'ArrayBuffer', 'DataView', 'TextEncoder', 'TextDecoder',
  // node / electron main
  'process', 'require', 'module', 'exports', '__dirname', '__filename', 'Buffer',
  'arguments',
]);

function declarePattern(node, declared) {
  if (!node) return;
  switch (node.type) {
    case 'Identifier':
      declared.add(node.name); break;
    case 'ObjectPattern':
      for (const p of node.properties) declarePattern(p.type === 'RestElement' ? p.argument : p.value, declared);
      break;
    case 'ArrayPattern':
      for (const e of node.elements) declarePattern(e, declared);
      break;
    case 'AssignmentPattern': declarePattern(node.left, declared); break;
    case 'RestElement': declarePattern(node.argument, declared); break;
    default: break;
  }
}

/** True when this Identifier is a property/label name, not a value reference. */
function isNotAReference(node, parent) {
  if (!parent) return false;
  if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return true;
  if (parent.type === 'Property' && parent.key === node && !parent.computed) return true;
  if (parent.type === 'MethodDefinition' && parent.key === node && !parent.computed) return true;
  if (parent.type === 'PropertyDefinition' && parent.key === node && !parent.computed) return true;
  return parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement';
}

function freeIdentifiers(source) {
  // sourceType 'module' parses both: the CommonJS main-process files contain
  // no import/export, and module mode is the strict superset.
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  const declared = new Set();
  const used = new Map();

  const walk = (node, parent) => {
    if (!node || typeof node.type !== 'string') return;

    if (node.type === 'VariableDeclarator') declarePattern(node.id, declared);
    if (node.id && (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ClassDeclaration' || node.type === 'ClassExpression')) {
      declared.add(node.id.name);
    }
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      for (const p of node.params) declarePattern(p, declared);
    }
    if (node.type === 'CatchClause' && node.param) declarePattern(node.param, declared);
    if (node.type === 'ImportDeclaration') for (const s of node.specifiers) declared.add(s.local.name);

    if (node.type === 'Identifier' && !isNotAReference(node, parent) && !used.has(node.name)) {
      used.set(node.name, node.loc.start.line);
    }

    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end') continue;
      const child = node[key];
      if (Array.isArray(child)) { for (const c of child) walk(c, node); }
      else if (child && typeof child.type === 'string') walk(child, node);
    }
  };

  walk(ast, null);
  return [...used]
    .filter(([name]) => !declared.has(name) && !GLOBALS.has(name))
    .map(([name, line]) => `${name} (line ${line})`);
}

/** Every shipped source file, minus the generated bundle. */
function sourceFiles() {
  const found = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { visit(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      if (entry.name === 'bundle.js') continue;   // esbuild output, not source
      found.push(full);
    }
  };
  visit(join(ROOT, 'src'));
  visit(join(ROOT, 'electron'));
  return found;
}

describe('every identifier a source file uses exists', () => {
  const files = sourceFiles();

  it('finds the source files to check', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const file of files) {
    it(`${relative(ROOT, file).replace(/\\/g, '/')} has no free identifiers`, () => {
      expect(freeIdentifiers(readFileSync(file, 'utf8'))).toEqual([]);
    });
  }
});

describe('the check itself catches a deleted helper', () => {
  it('reports a call to a function nothing declares', () => {
    const source = 'function play(id) { return prefFor(id).audio; }';
    expect(freeIdentifiers(source)).toEqual(['prefFor (line 1)']);
  });

  it('does not report a helper declared later in the file', () => {
    const source = 'function play(id) { return prefFor(id); }\nfunction prefFor(id) { return {}; }';
    expect(freeIdentifiers(source)).toEqual([]);
  });

  it('does not report property names that match nothing', () => {
    const source = 'const a = { prefFor: 1 }; a.prefFor = 2;';
    expect(freeIdentifiers(source)).toEqual([]);
  });
});
