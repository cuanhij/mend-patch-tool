// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a successful edit recorded, as [old, new] pairs, for the `R` lines. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  move(oldP: string, newP: string): void {
    this.moves.push([oldP, newP]);
  }
}

/** One line of an edit's old or new text: `ctx` marks a context line, one of both O and N. */
interface PatchLine {
  text: string;
  ctx: boolean;
}

/** A file as lines: its line break, and whether its text ends with one. */
interface FileLines {
  lines: string[];
  br: '\n' | '\r\n';
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const onlyWs = (s: string): boolean => /^[ \t]*$/.test(s);

/**
 * Positions where O occurs in the file's lines, at the first tier with one, or null.
 * Only positions at or after `from` count; with `toEnd` only an occurrence ending at the
 * file's last line counts.
 */
function findOccurrences(
  file: string[],
  old: string[],
  strict: boolean,
  from = 0,
  toEnd = false,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const norm = tier === 0 ? (s: string): string => s : tier === 1 ? trimEndWs : trimWs;
    const o = old.map(norm);
    const positions: number[] = [];
    for (let i = from; i + old.length <= file.length; i += 1) {
      if (toEnd && i + old.length !== file.length) continue;
      let ok = true;
      for (let j = 0; j < old.length; j += 1) {
        if (norm(file[i + j]!) !== o[j]) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** The lines N writes when O matched at `pos`: context lines as the file's own, others re-indented at tier 2. */
function buildReplacement(file: string[], pos: number, O: PatchLine[], N: PatchLine[], tier: number): string[] {
  const out: string[] = [];
  const ctxPos: number[] = [];
  O.forEach((o, k) => {
    if (o.ctx) ctxPos.push(pos + k);
  });
  let c = 0;
  const f = tier === 2 ? leadingWs(file[pos]!) : '';
  const p = tier === 2 ? leadingWs(O[0]!.text) : '';
  for (const n of N) {
    if (n.ctx) {
      out.push(file[ctxPos[c]!]!);
      c += 1;
    } else {
      let t = n.text;
      if (tier === 2 && t !== '' && !onlyWs(t) && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  return out;
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One unified hunk: its header's old start A, its old and new lines, and whether a `\` line follows its last context or `+` line (noEol) or its last `+` line (plusNoEol). */
interface Hunk {
  a: number;
  O: PatchLine[];
  N: PatchLine[];
  noEol: boolean;
  plusNoEol: boolean | null;
}

interface Section {
  oldPath: string | null | undefined;
  newPath: string | null | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** The path a `--- ` or `+++ ` line names: `/dev/null` is null, a leading `a/` or `b/` is removed. */
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/')) return raw.slice(2);
  if (raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function gitPaths(line: string): [string, string] | null {
  const m = /^diff --git a\/(.+?) b\/(.+?)\s*$/.exec(line);
  if (m === null) return null;
  return [m[1]!, m[2]!];
}

function hunkFromBody(a: number, body: string[]): Hunk {
  const O: PatchLine[] = [];
  const N: PatchLine[] = [];
  for (const l of body) {
    if (l === '') {
      O.push({ text: '', ctx: true });
      N.push({ text: '', ctx: true });
    } else if (l[0] === ' ') {
      O.push({ text: l.slice(1), ctx: true });
      N.push({ text: l.slice(1), ctx: true });
    } else if (l[0] === '-') O.push({ text: l.slice(1), ctx: false });
    else if (l[0] === '+') N.push({ text: l.slice(1), ctx: false });
  }
  // A `\` line refers to the body line before it: it counts when it follows the hunk's last context or `+` line.
  let noEol = false;
  for (let j = body.length - 1; j >= 0; j -= 1) {
    const l = body[j]!;
    if (l === '' || l[0] === ' ' || l[0] === '+') {
      noEol = j + 1 < body.length && body[j + 1]![0] === '\\';
      break;
    }
  }
  let plusNoEol: boolean | null = null;
  for (let j = body.length - 1; j >= 0; j -= 1) {
    const l = body[j]!;
    if (l[0] === '+') {
      plusNoEol = j + 1 < body.length && body[j + 1]![0] === '\\';
      break;
    }
  }
  return { a, O, N, noEol, plusNoEol };
}

/**
 * Parse one unified section's header and hunks, starting at `i`. Returns the index of the next
 * section's start, or the end of the patch.
 */
function parseSection(lines: string[], i: number, sec: Section): number {
  let dashOld: string | null | undefined;
  let dashNew: string | null | undefined;
  let renameFrom: string | undefined;
  let renameTo: string | undefined;
  const gitOld = sec.oldPath;
  const gitNew = sec.newPath;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('@@')) break;
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      dashOld = headerPath(line);
      dashNew = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
    if (line.startsWith('+++ ')) {
      dashNew = headerPath(line);
      i += 1;
      continue;
    }
    if (line.startsWith('rename from ')) {
      renameFrom = line.slice('rename from '.length).trim();
      i += 1;
      continue;
    }
    if (line === 'rename from') {
      renameFrom = '';
      i += 1;
      continue;
    }
    if (line.startsWith('rename to ')) {
      renameTo = line.slice('rename to '.length).trim();
      i += 1;
      continue;
    }
    if (line === 'rename to') {
      renameTo = '';
      i += 1;
      continue;
    }
    if (line.startsWith('new file mode')) {
      sec.newFile = true;
      i += 1;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      sec.deletedFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  sec.oldPath = dashOld !== undefined ? dashOld : renameFrom !== undefined ? renameFrom : gitOld;
  sec.newPath = dashNew !== undefined ? dashNew : renameTo !== undefined ? renameTo : gitNew;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) return i;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return i;
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      i += 1;
      const body: string[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (l.startsWith('diff --git ')) break;
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
          body.push(l);
          i += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      sec.hunks.push(hunkFromBody(a, body));
      continue;
    }
    i += 1;
  }
  return i;
}

function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  const file = splitFile(before);
  let d = 0;
  for (const h of hunks) {
    if (h.O.length === 0) {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > file.lines.length) pos = file.lines.length;
      const atEnd = pos === file.lines.length;
      file.lines.splice(pos, 0, ...h.N.map((n) => n.text));
      if (atEnd) file.final = !h.noEol;
      d += h.N.length;
      continue;
    }
    const m = findOccurrences(file.lines, h.O.map((o) => o.text), strict);
    if (m === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = m.positions[0]!;
    let bd = Math.abs(best - target);
    for (const p of m.positions) {
      const dd = Math.abs(p - target);
      if (dd < bd) {
        bd = dd;
        best = p;
      }
    }
    const atEnd = best + h.O.length === file.lines.length;
    const rep = buildReplacement(file.lines, best, h.O, h.N, m.tier);
    file.lines.splice(best, h.O.length, ...rep);
    if (atEnd) file.final = !h.noEol;
    d += h.N.length - h.O.length;
  }
  return joinFile(file);
}

function sectionEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    const isCreate = oldP === null || sec.newFile;
    const isDelete = !isCreate && (newP === null || sec.deletedFile);
    if (isCreate) {
      const p = newP === null || newP === undefined ? '' : newP;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let finalBreak = true;
      for (const h of sec.hunks) {
        for (const n of h.N) if (!n.ctx) plus.push(n.text);
        if (h.plusNoEol !== null) finalBreak = !h.plusNoEol;
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (finalBreak ? '\n' : ''));
      return;
    }
    if (isDelete) {
      const p = oldP === null || oldP === undefined ? '' : oldP;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const isMove = oldP !== undefined && newP !== undefined && oldP !== null && newP !== null && oldP !== newP;
    if (isMove) {
      const o = oldP as string;
      const n = newP as string;
      if (!safe(o)) throw new Fail('unsafe', o);
      if (!safe(n)) throw new Fail('unsafe', n);
      const before = tree.get(o);
      if (before === null) throw new Fail('missing', o);
      if (tree.get(n) !== null) throw new Fail('exists', n);
      const result = applyHunks(before, sec.hunks, strict, o);
      tree.now.set(o, null);
      tree.now.set(n, result);
      tree.move(o, n);
      return;
    }
    const p = (oldP ?? newP ?? '') as string;
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(before, sec.hunks, strict, p));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const g = gitPaths(line);
      if (g === null) throw new Exit2(`error: parse ${i + 1}`);
      const sec: Section = { oldPath: g[0], newPath: g[1], newFile: false, deletedFile: false, hunks: [] };
      sections.push(sec);
      i = parseSection(lines, i + 1, sec);
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: Section = { oldPath: undefined, newPath: undefined, newFile: false, deletedFile: false, hunks: [] };
      sections.push(sec);
      i = parseSection(lines, i, sec);
      continue;
    }
    if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i += 1;
  }
  return sections.map((s) => sectionEdit(s, strict));
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const file = splitFile(before);
    const m = findOccurrences(file.lines, oldLines, strict);
    if (m === null) throw new Fail('no-match', path);
    if (m.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = m.positions[0]!;
    const rep = buildReplacement(
      file.lines,
      pos,
      oldLines.map((t) => ({ text: t, ctx: false })),
      newLines.map((t) => ({ text: t, ctx: false })),
      m.tier,
    );
    file.lines.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, joinFile(file));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j >= prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    let sep = -1;
    for (let k = searchLine + 1; k < lines.length; k += 1) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        sep = k;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let end = -1;
    for (let k = sep + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevEnd = end + 1;
    prevPath = path;
    i = end + 1;
  }
  return edits;
}

/** One V4A chunk: its anchor (null: none), whether `*** End of File` closed it, and its body lines. */
interface Chunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

function chunkLines(body: string[]): { O: PatchLine[]; N: PatchLine[] } {
  const O: PatchLine[] = [];
  const N: PatchLine[] = [];
  for (const l of body) {
    if (l === '') {
      O.push({ text: '', ctx: true });
      N.push({ text: '', ctx: true });
    } else if (l[0] === ' ') {
      O.push({ text: l.slice(1), ctx: true });
      N.push({ text: l.slice(1), ctx: true });
    } else if (l[0] === '-') O.push({ text: l.slice(1), ctx: false });
    else if (l[0] === '+') N.push({ text: l.slice(1), ctx: false });
  }
  return { O, N };
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : `${fileLines.join('\n')}\n`);
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: Chunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const file = splitFile(before);
    let cursor = 0;
    for (const chunk of chunks) {
      const { O, N } = chunkLines(chunk.body);
      if (chunk.anchor !== null) {
        const m = findOccurrences(file.lines, [chunk.anchor], strict, cursor);
        if (m === null) throw new Fail('no-match', path);
        cursor = m.positions[0]! + 1;
      }
      if (O.length === 0) {
        const pos = chunk.eof ? file.lines.length : cursor;
        file.lines.splice(pos, 0, ...N.map((n) => n.text));
        cursor = pos + N.length;
        continue;
      }
      const m = findOccurrences(file.lines, O.map((o) => o.text), strict, cursor, chunk.eof);
      if (m === null) throw new Fail('no-match', path);
      const pos = m.positions[0]!;
      const rep = buildReplacement(file.lines, pos, O, N, m.tier);
      file.lines.splice(pos, O.length, ...rep);
      cursor = pos + rep.length;
    }
    const result = joinFile(file);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, result);
      tree.move(path, moveTo);
    } else {
      tree.now.set(path, result);
    }
  };
}

const v4aSectionStart = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const start = i + 1;
      let next = start;
      while (next < last && !v4aSectionStart(lines[next]!)) next += 1;
      let end = next;
      while (end > start && blank(lines[end - 1]!)) end -= 1;
      const fileLines: string[] = [];
      for (let k = start; k < end; k += 1) {
        const l = lines[k]!;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (blank(l)) fileLines.push('');
        else throw new Exit2(`error: parse ${k + 1}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
      i = next;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      const start = i + 1;
      let next = start;
      while (next < last && !v4aSectionStart(lines[next]!)) next += 1;
      for (let k = start; k < next; k += 1) {
        if (!blank(lines[k]!)) throw new Exit2(`error: parse ${k + 1}`);
      }
      edits.push(v4aDeleteEdit(path));
      i = next;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const start = i + 1;
      let next = start;
      while (next < last && !v4aSectionStart(lines[next]!)) next += 1;
      let end = next;
      while (end > start && blank(lines[end - 1]!)) end -= 1;
      let moveTo: string | null = null;
      let k = start;
      if (k < end && lines[k]!.startsWith('*** Move to: ')) {
        moveTo = lines[k]!.slice('*** Move to: '.length).trim();
        k += 1;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      const finishChunk = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (k < end) {
        const l = lines[k]!;
        if (l.startsWith('@@')) {
          finishChunk();
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          k += 1;
          continue;
        }
        if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${k + 1}`);
          cur.eof = true;
          finishChunk();
          k += 1;
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${k + 1}`);
            cur = { anchor: null, eof: false, body: [] };
          }
          cur.body.push(l);
          k += 1;
          continue;
        }
        throw new Exit2(`error: parse ${k + 1}`);
      }
      finishChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      i = next;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // One line per changed path, in byte order of the paths; a move prints `R old -> new` (sorted by new)
  // instead of its `D` and `A` lines.
  const consumed = new Set<string>();
  const rows: Array<{ key: string; line: string }> = [];
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
