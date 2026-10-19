// Converts the Orval-generated zod module (minified) into JSON Schemas, in source order,
// then aligns them with the ordered endpoint calls from the generated client.
// Usage: node schemas.mjs <zodChunk> <clientChunk> <out.json>
// Nothing from the downloaded files is executed: both are parsed with acorn and walked.
import fs from 'node:fs';
import * as acorn from 'acorn';

const [zodFile, clientFile, outFile] = process.argv.slice(2);

// ---------- zod AST -> JSON Schema ----------
const ZOD = { Ik: 'object', Yj: 'string', ai: 'number', zM: 'boolean', YO: 'array', k5: 'enum', bz: 'any' };

function lit(node) {
  if (node.type === 'Literal') return node.value;
  if (node.type === 'TemplateLiteral') return node.quasis.map((q) => q.value.cooked).join('');
  if (node.type === 'UnaryExpression' && node.operator === '-') return -lit(node.argument);
  if (node.type === 'ArrayExpression') return node.elements.map(lit);
  return undefined;
}
const keyName = (p) => (p.key.type === 'Identifier' ? p.key.name : p.key.value);

function toSchema(node) {
  if (node.type !== 'CallExpression') return { unknown: true };
  const callee = node.callee;
  if (callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && callee.object.name === 'a') {
    const kind = ZOD[callee.property.name];
    const args = node.arguments;
    switch (kind) {
      case 'object': {
        const props = {}; const required = [];
        if (args[0] && args[0].type === 'ObjectExpression') {
          for (const p of args[0].properties) {
            const s = toSchema(p.value);
            const k = keyName(p);
            if (!s._optional) required.push(k);
            delete s._optional;
            props[k] = s;
          }
        }
        return { type: 'object', properties: props, ...(required.length ? { required } : {}) };
      }
      case 'string': return { type: 'string' };
      case 'number': return { type: 'number' };
      case 'boolean': return { type: 'boolean' };
      case 'array': { const it = toSchema(args[0]); delete it._optional; return { type: 'array', items: it }; }
      case 'enum': return { type: 'string', enum: lit(args[0]) };
      case 'any': return {};
      default: return { unknown: callee.property.name };
    }
  }
  if (callee.type === 'MemberExpression') {
    const base = toSchema(callee.object);
    const m = callee.property.name;
    const a0 = node.arguments[0] ? lit(node.arguments[0]) : undefined;
    switch (m) {
      case 'optional': base._optional = true; break;
      case 'nullish': base._optional = true; base.nullable = true; break;
      case 'nullable': base.nullable = true; break;
      case 'describe': base.description = a0; break;
      case 'datetime': base.format = 'date-time'; break;
      case 'uuid': base.format = 'uuid'; break;
      case 'default': base.default = a0; base._optional = true; break;
      case 'min': base[base.type === 'string' ? 'minLength' : base.type === 'array' ? 'minItems' : 'minimum'] = a0; break;
      case 'max': base[base.type === 'string' ? 'maxLength' : base.type === 'array' ? 'maxItems' : 'maximum'] = a0; break;
      default: base['x-' + m] = a0;
    }
    return base;
  }
  return { unknown: true };
}

// Find the module factory body and walk its top-level statements in order.
const zsrc = fs.readFileSync(zodFile, 'utf8');
const zast = acorn.parse(zsrc, { ecmaVersion: 'latest' });
const topLevel = [];
function collect(expr) {
  if (!expr) return;
  if (expr.type === 'SequenceExpression') return expr.expressions.forEach(collect);
  if (expr.type === 'CallExpression') return topLevel.push(expr);
  if (expr.type === 'AssignmentExpression') return collect(expr.right);
}
function walkBody(body) {
  for (const st of body) {
    if (st.type === 'ExpressionStatement') collect(st.expression);
    else if (st.type === 'VariableDeclaration') for (const d of st.declarations) collect(d.init);
  }
}
// self.webpackChunk.push([[id],{ID:(i,n,e)=>{...}}])
const push = zast.body
  .map((s) => s.expression)
  .find((e) => e && e.type === 'CallExpression' && e.callee.type === 'MemberExpression' && e.callee.property.name === 'push');
const modules = push.arguments[0].elements[1].properties;
walkBody(modules[0].value.body.body);
const zodSchemas = topLevel
  .filter((c) => c.callee.type === 'MemberExpression')
  .map((c) => { const s = toSchema(c); delete s._optional; return s; })
  .filter((s) => s.type === 'object' || s.type === 'array');

const isResponse = (s) => s.type === 'object' && s.properties && (('success' in s.properties && 'error_code' in s.properties) || 'total_records' in s.properties);

// Segment: each operation = [non-response schemas...] + response schema.
const ops = [];
let pending = [];
for (const s of zodSchemas) {
  if (isResponse(s)) { ops.push({ pre: pending, response: s }); pending = []; }
  else pending.push(s);
}

// ---------- ordered client calls ----------
const csrc = fs.readFileSync(clientFile, 'utf8');
const callRe = /\(\{url:((?:"[^"]*"(?:\.concat\([^)]*\))*)|`[^`]*`),method:"([A-Z]+)"((?:[^()]|\([^()]*\)){0,240}?)\}(?:,[\w$]+)?\)/g;
const calls = []; const seen = new Set();
for (const m of csrc.matchAll(callRe)) {
  const parts = [...m[1].matchAll(/"([^"]*)"|\.concat\(([^)]*)\)/g)];
  let url = ''; let nParams = 0;
  for (const p of parts) {
    if (p[1] !== undefined) url += p[1];
    else for (const a of p[2].split(',')) { const t = a.trim(); if (/^".*"$/.test(t)) url += t.slice(1, -1); else { url += '{}'; nParams++; } }
  }
  if (!url.includes('/bff/')) continue;
  const key = m[2] + ' ' + url;
  if (seen.has(key)) continue; seen.add(key);
  calls.push({ method: m[2], url, nParams, body: /\bdata:/.test(m[3]), query: /\bparams:/.test(m[3]) });
}

// Monotonic alignment (the client is a tree-shaken subsequence of the spec order).
// score = shape compatibility + token overlap between URL words and the op's field names/descriptions.
const tok = (x) => new Set(String(x).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 2));
const opText = (op) => JSON.stringify([op.pre, op.response]).replace(/"(type|properties|required|description|nullable|format|items|string|number|boolean|object|array)"/g, ' ');
const opTok = ops.map((op) => tok(opText(op).replace(/_/g, ' ')));
const callTok = calls.map((c) => tok(c.url.replace('/bff/', '').replace(/[-_]/g, ' ')));
function compat(c, op) {
  const need = (c.nParams ? 1 : 0) + (c.query ? 1 : 0) + (c.body ? 1 : 0);
  if (op.pre.length !== need) return false;
  if (c.nParams && Object.keys(op.pre[0].properties || {}).length !== c.nParams) return false;
  return true;
}
const df = new Map();
for (const t of opTok) for (const w of t) df.set(w, (df.get(w) || 0) + 1);
const idf = (w) => Math.log((ops.length + 1) / ((df.get(w) || 0) + 1));
const W = Number(process.env.SEM_W || 4);
function score(ci, oj) {
  if (!compat(calls[ci], ops[oj])) return -Infinity;
  let ov = 0; for (const w of callTok[ci]) if (opTok[oj].has(w)) ov += idf(w);
  return 10 + W * ov;
}
const N = calls.length, M = ops.length;
// best[i][j]: best score aligning calls[0..i) within ops[0..j)
const best = Array.from({ length: N + 1 }, () => new Float64Array(M + 1).fill(-Infinity));
const take = Array.from({ length: N + 1 }, () => new Uint8Array(M + 1));
for (let j = 0; j <= M; j++) best[0][j] = 0;
for (let i = 1; i <= N; i++) {
  for (let j = 1; j <= M; j++) {
    const skip = best[i][j - 1];
    const sc = score(i - 1, j - 1);
    const use = sc === -Infinity ? -Infinity : best[i - 1][j - 1] + sc;
    // Allow an unmatched call (penalty) so one oddity does not break the whole chain.
    const miss = best[i - 1][j] - 30;
    if (use > skip && use >= miss) { best[i][j] = use; take[i][j] = 1; }
    else if (skip >= miss) { best[i][j] = skip; take[i][j] = 0; }
    else { best[i][j] = miss; take[i][j] = 2; }
  }
}
const match = new Array(N).fill(-1);
for (let i = N, j = M; i > 0 && j > 0;) {
  if (take[i][j] === 1) { match[i - 1] = j - 1; i--; j--; }
  else if (take[i][j] === 0) j--;
  else i--;
}
// Local reassignment: the client order differs slightly from the spec order inside a tag,
// so let each call pick among compatible ops near its DP position, best semantic score first.
const WIN = Number(process.env.WIN || 12);
const cands = [];
calls.forEach((c, i) => {
  if (match[i] < 0) return;
  for (let j = Math.max(0, match[i] - WIN); j <= Math.min(M - 1, match[i] + WIN); j++) {
    const sc = score(i, j);
    if (sc > -Infinity) cands.push({ i, j, sc: sc - Math.abs(j - match[i]) * 0.01 });
  }
});
cands.sort((a, b) => b.sc - a.sc);
const usedOp = new Set(); const done = new Set();
for (const c of cands) {
  if (done.has(c.i) || usedOp.has(c.j)) continue;
  match[c.i] = c.j; done.add(c.i); usedOp.add(c.j);
}
const out = []; const unmatched = [];
calls.forEach((c, i) => {
  const rec = { ...c };
  if (match[i] < 0) { unmatched.push(c); out.push(rec); return; }
  const pre = [...ops[match[i]].pre];
  if (c.nParams) rec.pathParams = pre.shift();
  if (c.query) rec.queryParams = pre.shift();
  if (c.body) rec.requestBody = pre.shift();
  rec.response = ops[match[i]].response;
  rec.opIndex = match[i];
  out.push(rec);
});

fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
fs.writeFileSync(outFile.replace(/.json$/, '') + '.ops.json', JSON.stringify(ops));
console.log('zod top-level', zodSchemas.length, 'ops', ops.length, 'calls', calls.length, 'unmatched', unmatched.length);
for (const u of unmatched.slice(0, 40)) console.log('  unmatched', u.method, u.url, u.nParams, u.query ? 'Q' : '', u.body ? 'B' : '');

// ---- debug dump of op summaries
if (process.env.DUMP_OPS) {
  const k = (s) => (s ? Object.keys(s.properties || {}).slice(0, 6).join(',') : '');
  const d = (r) => { const x = r.properties.data; if (!x) return ''; return x.type === 'array' ? '[' + k(x.items) + ']' : k(x); };
  fs.writeFileSync(process.env.DUMP_OPS, ops.map((o, i) => `${i}\tpre=${o.pre.map(k).join(' | ')}\tdata=${d(o.response)}`).join('\n'));
  fs.writeFileSync(process.env.DUMP_OPS + '.calls', out.map((c) => `${c.opIndex ?? '-'}\t${c.method} ${c.url}`).join('\n'));
}
