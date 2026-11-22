// mend: the CLI SPEC.md specifies (MIT). Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]` with the working directory as the root of a tree of text files.
// It reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits),
// finds the lines each edit names at the first of three matching tiers, and writes every change
// or none, printing what it changed or why it failed.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

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

const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/** A file as lines: its line break, its lines, whether it ends with a line break. */
interface FileDoc {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileDoc {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileDoc): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, as [old, new] pairs, for the `R` output lines. */
  readonly moves: [string, string][] = [];
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

// ---------------------------------------------------------------------------
// Matching lines (SPEC.md section 5)
// ---------------------------------------------------------------------------

function lineMatches(fileLine: string, oLine: string, tier: number): boolean {
  if (tier === 0) return fileLine === oLine;
  if (tier === 1) {
    const trimEnd = (s: string): string => s.replace(/[ \t]+$/, '');
    return trimEnd(fileLine) === trimEnd(oLine);
  }
  const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  return trimBoth(fileLine) === trimBoth(oLine);
}

/** Positions at or after `from` where O occurs in `lines` at `tier`. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineMatches(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once (at or after `from`), with its occurrences. */
function findTier(lines: string[], o: string[], from: number, strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** One line of N: a context line (written as the file's own matched line) or a fresh line. */
interface NewLine {
  text: string;
  ctx: number | null;
}
interface Replacement {
  o: string[];
  n: NewLine[];
}

function reindent(text: string, p: string, f: string): string {
  if (text === '' || text.trim() === '') return text;
  if (text.startsWith(p)) return f + text.slice(p.length);
  return text;
}

/** Replace O at position `at` with N: context lines come from the file, other lines of N are
 * re-indented at tier 2. */
function applyReplacement(lines: string[], at: number, r: Replacement, tier: number): string[] {
  const f = leadingWs(lines[at] ?? '');
  const p = leadingWs(r.o[0] ?? '');
  const out: string[] = [];
  for (const nl of r.n) {
    if (nl.ctx !== null) out.push(lines[at + nl.ctx]!);
    else if (tier === 2) out.push(reindent(nl.text, p, f));
    else out.push(nl.text);
  }
  return [...lines.slice(0, at), ...out, ...lines.slice(at + r.o.length)];
}

// ---------------------------------------------------------------------------
// Patch bodies: context / old / new / backslash lines (sections 6 and 8)
// ---------------------------------------------------------------------------

type BodyKind = 'ctx' | 'old' | 'new' | 'backslash';
interface BodyLine {
  kind: BodyKind;
  text: string;
}

function bodyLine(line: string): BodyLine {
  if (line === '') return { kind: 'ctx', text: '' };
  const c = line[0]!;
  if (c === ' ') return { kind: 'ctx', text: line.slice(1) };
  if (c === '-') return { kind: 'old', text: line.slice(1) };
  if (c === '+') return { kind: 'new', text: line.slice(1) };
  return { kind: 'backslash', text: line.slice(1) };
}

function replacementFromBody(body: BodyLine[]): Replacement {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      const idx = o.length;
      o.push(b.text);
      n.push({ text: b.text, ctx: idx });
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else if (b.kind === 'new') {
      n.push({ text: b.text, ctx: null });
    }
  }
  return { o, n };
}

/** Whether a `\` line follows the body's last context or `+` line. */
function noEolAfter(body: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i]!.kind === 'ctx' || body[i]!.kind === 'new') last = i;
  }
  return last >= 0 && body[last + 1] !== undefined && body[last + 1]!.kind === 'backslash';
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  body: BodyLine[];
}
interface UnifiedSection {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path after `--- ` or `+++ `: up to the first tab, surrounding spaces removed, a leading
 * a/ or b/ removed, /dev/null means no file. */
function patchPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function isBodyLine(line: string): boolean {
  return line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\';
}

function parseUnified(lines: string[]): UnifiedSection[] {
  const sections: UnifiedSection[] = [];
  let sec: UnifiedSection | null = null;
  let hunk: Hunk | null = null;
  let phase: 'outside' | 'header' | 'body' | 'between' = 'outside';
  const flushHunk = (): void => {
    if (hunk === null || sec === null) return;
    // Empty lines at the end of a body are not part of it.
    while (hunk.body.length > 0) {
      const last = hunk.body[hunk.body.length - 1]!;
      if (last.kind === 'ctx' && last.text === '') hunk.body.pop();
      else break;
    }
    sec.hunks.push(hunk);
    hunk = null;
  };
  const flushSection = (): void => {
    flushHunk();
    if (sec !== null) sections.push(sec);
    sec = null;
    phase = 'outside';
  };
  const newSection = (gitOld: string | null, gitNew: string | null): UnifiedSection => ({
    gitOld,
    gitNew,
    pairOld: null,
    pairNew: null,
    renameOld: null,
    renameNew: null,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const n = i + 1;
    if (phase === 'body') {
      if (line.startsWith('diff --git ')) {
        flushHunk();
        // Fall through: the line starts a new section below.
      } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        flushHunk();
        // Fall through: the pair starts a new section below.
      } else if (isBodyLine(line)) {
        hunk!.body.push(bodyLine(line));
        i += 1;
        continue;
      } else {
        flushHunk();
        phase = 'between';
        // Fall through: re-process the line between hunks.
      }
    }
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${n}`);
      flushSection();
      sec = newSection(m[1]!, m[2]!);
      phase = 'header';
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = patchPath(line);
      const newP = patchPath(lines[i + 1]!);
      if (phase === 'header' && sec !== null) {
        // The pair is part of this section's header.
        sec.pairOld = oldP;
        sec.pairNew = newP;
      } else {
        flushSection();
        sec = newSection(null, null);
        sec.pairOld = oldP;
        sec.pairNew = newP;
        phase = 'header';
      }
      i += 2;
      continue;
    }
    if (phase === 'outside') {
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${n}`);
      i += 1;
      continue;
    }
    if (phase === 'header' && sec !== null) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${n + 1}`);
      if (line.startsWith('+++ ')) {
        sec.pairNew = patchPath(line);
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        sec.renameOld = line.slice(12).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        sec.renameNew = line.slice(10).trim();
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
      if (line.startsWith('@@')) {
        const m = HUNK_RE.exec(line);
        if (m === null) throw new Exit2(`error: parse ${n}`);
        hunk = { a: parseInt(m[1]!, 10), body: [] };
        phase = 'body';
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (phase === 'between') {
      if (line.startsWith('@@')) {
        const m = HUNK_RE.exec(line);
        if (m === null) throw new Exit2(`error: parse ${n}`);
        hunk = { a: parseInt(m[1]!, 10), body: [] };
        phase = 'body';
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  flushSection();
  return sections;
}

/** Apply a section's hunks in order to a file's lines. */
function applyHunks(doc: FileDoc, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const hunk of hunks) {
    const rep = replacementFromBody(hunk.body);
    if (rep.o.length === 0) {
      let at = hunk.a + d;
      if (at < 0) at = 0;
      if (at > doc.lines.length) at = doc.lines.length;
      const wasAtEnd = at === doc.lines.length;
      const add = rep.n.map((nl) => nl.text);
      doc.lines.splice(at, 0, ...add);
      if (wasAtEnd) doc.final = !noEolAfter(hunk.body);
      d += add.length;
      continue;
    }
    const found = findTier(doc.lines, rep.o, 0, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = hunk.a - 1 + d;
    let best = found.occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const runsToEnd = best + rep.o.length === doc.lines.length;
    doc.lines = applyReplacement(doc.lines, best, rep, found.tier);
    if (runsToEnd) doc.final = !noEolAfter(hunk.body);
    d += rep.n.length - rep.o.length;
  }
}

function unifiedEdits(sections: UnifiedSection[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  for (const sec of sections) {
    const oldP = sec.pairOld ?? sec.renameOld ?? sec.gitOld;
    const newP = sec.pairNew ?? sec.renameNew ?? sec.gitNew;
    const isCreate = oldP === null || sec.newFile;
    const isDelete = newP === null || sec.deletedFile;
    const hunks = sec.hunks;
    const checkPaths = (tree: Tree): void => {
      if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    };
    if (isCreate) {
      edits.push((tree) => {
        checkPaths(tree);
        if (newP === null) return;
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const plus: string[] = [];
        for (const h of hunks) {
          for (const b of h.body) if (b.kind === 'new') plus.push(b.text);
        }
        // The created file ends with a line break unless a `\` line follows its last `+` line.
        let noEol = false;
        outer: for (let hi = hunks.length - 1; hi >= 0; hi--) {
          const body = hunks[hi]!.body;
          for (let k = body.length - 1; k >= 0; k--) {
            if (body[k]!.kind === 'new') {
              noEol = body[k + 1] !== undefined && body[k + 1]!.kind === 'backslash';
              break outer;
            }
          }
        }
        tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      });
      continue;
    }
    if (isDelete) {
      edits.push((tree) => {
        checkPaths(tree);
        if (oldP === null) throw new Fail('missing', '');
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        tree.now.set(oldP, null);
      });
      continue;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      edits.push((tree) => {
        checkPaths(tree);
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const doc = splitFile(tree.get(oldP)!);
        applyHunks(doc, hunks, strict, oldP);
        tree.now.set(oldP, null);
        tree.now.set(newP, joinFile(doc));
        tree.moves.push([oldP, newP]);
      });
      continue;
    }
    const p = oldP ?? newP;
    edits.push((tree) => {
      checkPaths(tree);
      if (p === null) return;
      if (tree.get(p) === null) throw new Fail('missing', p);
      const doc = splitFile(tree.get(p)!);
      applyHunks(doc, hunks, strict, p);
      tree.now.set(p, joinFile(doc));
    });
  }
  return edits;
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

interface SrBlock {
  path: string;
  old: string[];
  new: string[];
}

function parseSearchReplace(lines: string[]): SrBlock[] {
  const blocks: SrBlock[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j > prevReplace; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${s + 1}`);
    }
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    blocks.push({ path, old: lines.slice(s + 1, eq), new: lines.slice(eq + 1, rep) });
    prevReplace = rep;
    prevPath = path;
    i = rep + 1;
  }
  return blocks;
}

function srEdits(blocks: SrBlock[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  for (const block of blocks) {
    edits.push((tree) => {
      if (!safe(block.path)) throw new Fail('unsafe', block.path);
      if (block.old.length === 0) {
        if (tree.get(block.path) !== null) throw new Fail('exists', block.path);
        tree.now.set(block.path, block.new.length === 0 ? '' : block.new.join('\n') + '\n');
        return;
      }
      const before = tree.get(block.path);
      if (before === null) throw new Fail('missing', block.path);
      const doc = splitFile(before);
      const found = findTier(doc.lines, block.old, 0, strict);
      if (found === null) throw new Fail('no-match', block.path);
      if (found.occ.length > 1) throw new Fail('ambiguous', block.path);
      const rep: Replacement = { o: block.old, n: block.new.map((t) => ({ text: t, ctx: null })) };
      doc.lines = applyReplacement(doc.lines, found.occ[0]!, rep, found.tier);
      tree.now.set(block.path, joinFile(doc));
    });
  }
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

const V4A_ADD = '*** Add File: ';
const V4A_DELETE = '*** Delete File: ';
const V4A_UPDATE = '*** Update File: ';
const V4A_MOVE = '*** Move to: ';

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}
interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  moveTo: string | null;
  addLines: string[];
  chunks: V4aChunk[];
}

function parseV4a(lines: string[]): V4aSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  interface Raw {
    kind: 'add' | 'delete' | 'update';
    path: string;
    lineNo: number;
    raw: { text: string; no: number }[];
  }
  const raws: Raw[] = [];
  let cur: Raw | null = null;
  for (let idx = first + 1; idx < last; idx++) {
    const line = lines[idx]!;
    const n = idx + 1;
    if (line.startsWith(V4A_ADD)) {
      if (cur !== null) raws.push(cur);
      cur = { kind: 'add', path: line.slice(V4A_ADD.length).trim(), lineNo: n, raw: [] };
    } else if (line.startsWith(V4A_DELETE)) {
      if (cur !== null) raws.push(cur);
      cur = { kind: 'delete', path: line.slice(V4A_DELETE.length).trim(), lineNo: n, raw: [] };
    } else if (line.startsWith(V4A_UPDATE)) {
      if (cur !== null) raws.push(cur);
      cur = { kind: 'update', path: line.slice(V4A_UPDATE.length).trim(), lineNo: n, raw: [] };
    } else if (cur === null) {
      if (!blank(line)) throw new Exit2(`error: parse ${n}`);
    } else {
      cur.raw.push({ text: line, no: n });
    }
  }
  if (cur !== null) raws.push(cur);
  const out: V4aSection[] = [];
  for (const r of raws) {
    // Blank lines at the end of a section are not part of it.
    let raw = r.raw;
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (r.kind === 'add') {
      const addLines: string[] = [];
      for (const { text, no } of raw) {
        if (text.startsWith('+')) addLines.push(text.slice(1));
        else if (text === '') addLines.push('');
        else throw new Exit2(`error: parse ${no}`);
      }
      out.push({ kind: 'add', path: r.path, lineNo: r.lineNo, moveTo: null, addLines, chunks: [] });
    } else if (r.kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.no}`);
      out.push({ kind: 'delete', path: r.path, lineNo: r.lineNo, moveTo: null, addLines: [], chunks: [] });
    } else {
      // A blank line before an Update section's first chunk is not part of the chunk.
      while (raw.length > 0 && blank(raw[0]!.text)) raw = raw.slice(1);
      let moveTo: string | null = null;
      let i = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith(V4A_MOVE)) {
        moveTo = raw[0]!.text.slice(V4A_MOVE.length).trim();
        i = 1;
      }
      const chunks: V4aChunk[] = [];
      let chunk: V4aChunk | null = null;
      for (; i < raw.length; i++) {
        const { text, no } = raw[i]!;
        if (text.startsWith('@@')) {
          if (chunk !== null) chunks.push(chunk);
          const anchor = text.slice(2).trim();
          chunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
        } else if (text === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${no}`);
          chunk.eof = true;
          chunks.push(chunk);
          chunk = null;
        } else if (text === '' || text[0] === ' ' || text[0] === '-' || text[0] === '+') {
          if (chunk === null) {
            if (chunks.length !== 0) throw new Exit2(`error: parse ${no}`);
            chunk = { anchor: null, eof: false, body: [] };
          }
          chunk.body.push(bodyLine(text));
        } else {
          throw new Exit2(`error: parse ${no}`);
        }
      }
      if (chunk !== null) chunks.push(chunk);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${r.lineNo}`);
      out.push({ kind: 'update', path: r.path, lineNo: r.lineNo, moveTo, addLines: [], chunks });
    }
  }
  return out;
}

/** Apply one V4A chunk; returns the cursor just after the lines written. */
function applyV4aChunk(doc: FileDoc, chunk: V4aChunk, cursor: number, strict: boolean, path: string): number {
  let cur = cursor;
  if (chunk.anchor !== null) {
    const tiers = strict ? [0] : [0, 1, 2];
    let found: number | null = null;
    for (const t of tiers) {
      for (let k = cur; k < doc.lines.length; k++) {
        if (lineMatches(doc.lines[k]!, chunk.anchor, t)) {
          found = k;
          break;
        }
      }
      if (found !== null) break;
    }
    if (found === null) throw new Fail('no-match', path);
    cur = found + 1;
  }
  const rep = replacementFromBody(chunk.body);
  if (rep.o.length === 0) {
    const at = chunk.eof ? doc.lines.length : cur;
    const add = rep.n.map((nl) => nl.text);
    doc.lines.splice(at, 0, ...add);
    return at + add.length;
  }
  const tiers = strict ? [0] : [0, 1, 2];
  let chosen: { tier: number; at: number } | null = null;
  for (const t of tiers) {
    const occ = occurrences(doc.lines, rep.o, t, cur);
    if (chunk.eof) {
      const ok = occ.filter((p) => p + rep.o.length === doc.lines.length);
      if (ok.length > 0) {
        chosen = { tier: t, at: ok[0]! };
        break;
      }
    } else if (occ.length > 0) {
      chosen = { tier: t, at: occ[0]! };
      break;
    }
  }
  if (chosen === null) throw new Fail('no-match', path);
  doc.lines = applyReplacement(doc.lines, chosen.at, rep, chosen.tier);
  return chosen.at + rep.n.length;
}

function v4aEdits(sections: V4aSection[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  for (const s of sections) {
    if (s.kind === 'add') {
      const p = s.path;
      const content = s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n';
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, content);
      });
    } else if (s.kind === 'delete') {
      const p = s.path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      const p = s.path;
      const moveTo = s.moveTo;
      const chunks = s.chunks;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        const doc = splitFile(before);
        let cursor = 0;
        for (const chunk of chunks) cursor = applyV4aChunk(doc, chunk, cursor, strict, p);
        const out = joinFile(doc);
        if (moveTo !== null) {
          tree.now.set(p, null);
          tree.now.set(moveTo, out);
          tree.moves.push([p, moveTo]);
        } else {
          tree.now.set(p, out);
        }
      });
    }
  }
  return edits;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Order and atomicity (SPEC.md section 10)
// ---------------------------------------------------------------------------

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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(parseUnified(lines), strict);
    else if (kind === 'search-replace') edits = srEdits(parseSearchReplace(lines), strict);
    else edits = v4aEdits(parseV4a(lines), strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.get(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null && !covered.has(oldP) && !covered.has(newP)) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteOrder)) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: was === null ? `A ${p}` : now === null ? `D ${p}` : `M ${p}` });
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.text);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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
