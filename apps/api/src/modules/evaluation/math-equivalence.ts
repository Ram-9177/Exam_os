/**
 * Mathematical equivalence of two expressions typed by people ("2(x+1)" vs "2x + 2", "sin(x)^2 + cos(x)^2" vs "1").
 *
 * The expressions are parsed (numbers, variables, + − × ÷ ^, implicit multiplication, sin cos tan asin acos atan sinh
 * cosh tanh sqrt cbrt exp ln log abs, π/pi, e) and evaluated at the same random values of their variables; equal at
 * every sample point (relative difference below 1e-7) means equivalent. This is how answer checkers in maths
 * assessment work without a full computer-algebra system. An expression that cannot be parsed is never "equivalent".
 */
type Node =
  | { t: 'num'; v: number }
  | { t: 'var'; name: string }
  | { t: 'un'; op: '-'; a: Node }
  | { t: 'bin'; op: '+' | '-' | '*' | '/' | '^'; a: Node; b: Node }
  | { t: 'fn'; name: string; a: Node };

const FUNCS: Record<string, (x: number) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, sqrt: Math.sqrt, cbrt: Math.cbrt, exp: Math.exp,
  ln: Math.log, log: Math.log10, abs: Math.abs,
};
const CONSTS: Record<string, number> = { pi: Math.PI, π: Math.PI, e: Math.E };

export function normaliseExpression(src: string): string {
  return src
    .replace(/[×·∙]/g, '*')
    .replace(/÷/g, '/')
    .replace(/[−–—]/g, '-')
    .replace(/\*\*/g, '^')
    .replace(/²/g, '^2')
    .replace(/³/g, '^3')
    .replace(/√/g, 'sqrt')
    .trim();
}

type Tok = { k: 'num'; v: number } | { k: 'id'; v: string } | { k: 'op'; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (/[0-9.]/.test(c)) {
      const m = /^\d*\.?\d+(?:e[+-]?\d+)?/i.exec(src.slice(i)) ?? /^\d+\.?/.exec(src.slice(i));
      if (!m) throw new Error('bad number');
      out.push({ k: 'num', v: Number(m[0]) });
      i += m[0].length;
    } else if (/[a-zA-Zπ]/.test(c)) {
      const m = /^(?:π|[a-zA-Z]+)/.exec(src.slice(i))!;
      // known function/constant names stay whole; anything else splits into single-letter variables (xy = x·y)
      const word = m[0];
      // "sinx" = sin(x), "2pix" = 2·π·x: take known names greedily, everything else letter by letter
      const names = [...Object.keys(FUNCS), ...Object.keys(CONSTS)].sort((x, y) => y.length - x.length);
      let w = 0;
      while (w < word.length) {
        const name = names.find((n) => word.startsWith(n, w) && n.length > 1);
        if (name) {
          out.push({ k: 'id', v: name });
          w += name.length;
        } else {
          out.push({ k: 'id', v: word[w]! });
          w++;
        }
      }
      i += word.length;
    } else if ('+-*/^()'.includes(c)) {
      out.push({ k: 'op', v: c });
      i++;
    } else throw new Error(`unexpected ${c}`);
  }
  return out;
}

export function parseExpression(src: string): Node {
  const toks = tokenize(normaliseExpression(src));
  let p = 0;
  const peek = () => toks[p];
  const eat = (v?: string) => {
    const t = toks[p];
    if (!t || (v !== undefined && (t.k !== 'op' || t.v !== v))) throw new Error(`expected ${v ?? 'token'}`);
    p++;
    return t;
  };
  // implicit multiplication starts where a primary can start: number, identifier, '('
  const startsPrimary = (t: Tok | undefined) => !!t && (t.k === 'num' || t.k === 'id' || (t.k === 'op' && t.v === '('));
  function expr(): Node {
    let n = term();
    while (peek()?.k === 'op' && (peek()!.v === '+' || peek()!.v === '-')) {
      const op = eat().v as '+' | '-';
      n = { t: 'bin', op, a: n, b: term() };
    }
    return n;
  }
  function term(): Node {
    let n = unary();
    for (;;) {
      const t = peek();
      if (t?.k === 'op' && (t.v === '*' || t.v === '/')) {
        const op = eat().v as '*' | '/';
        n = { t: 'bin', op, a: n, b: unary() };
      } else if (startsPrimary(t)) n = { t: 'bin', op: '*', a: n, b: power() };
      else return n;
    }
  }
  function unary(): Node {
    if (peek()?.k === 'op' && peek()!.v === '-') {
      eat();
      return { t: 'un', op: '-', a: unary() };
    }
    if (peek()?.k === 'op' && peek()!.v === '+') {
      eat();
      return unary();
    }
    return power();
  }
  function power(): Node {
    const base = primary();
    if (peek()?.k === 'op' && peek()!.v === '^') {
      eat();
      return { t: 'bin', op: '^', a: base, b: unary() }; // right-associative, allows 2^-1
    }
    return base;
  }
  function primary(): Node {
    const t = eat();
    if (t.k === 'num') return { t: 'num', v: t.v };
    if (t.k === 'id') {
      if (FUNCS[t.v]) {
        if (peek()?.k === 'op' && peek()!.v === '(') {
          eat('(');
          const a = expr();
          eat(')');
          return { t: 'fn', name: t.v, a };
        }
        return { t: 'fn', name: t.v, a: power() }; // sin x
      }
      if (CONSTS[t.v] !== undefined) return { t: 'num', v: CONSTS[t.v]! };
      return { t: 'var', name: t.v };
    }
    if (t.k === 'op' && t.v === '(') {
      const n = expr();
      eat(')');
      return n;
    }
    throw new Error('unexpected token');
  }
  const n = expr();
  if (p !== toks.length) throw new Error('trailing input');
  return n;
}

function variables(n: Node, out = new Set<string>()): Set<string> {
  if (n.t === 'var') out.add(n.name);
  else if (n.t === 'un' || n.t === 'fn') variables(n.a, out);
  else if (n.t === 'bin') {
    variables(n.a, out);
    variables(n.b, out);
  }
  return out;
}

function evaluate(n: Node, env: Record<string, number>): number {
  switch (n.t) {
    case 'num':
      return n.v;
    case 'var':
      return env[n.name] ?? NaN;
    case 'un':
      return -evaluate(n.a, env);
    case 'fn':
      return FUNCS[n.name]!(evaluate(n.a, env));
    case 'bin': {
      const a = evaluate(n.a, env);
      const b = evaluate(n.b, env);
      return n.op === '+' ? a + b : n.op === '-' ? a - b : n.op === '*' ? a * b : n.op === '/' ? a / b : Math.pow(a, b);
    }
  }
}

/** Deterministic pseudo-random sample points (the same answer always gets the same verdict). */
function samples(count: number, seed = 42): number[] {
  let s = seed;
  return Array.from({ length: count }, () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return 0.3 + (s / 2147483648) * 2.4; // 0.3 … 2.7: avoids 0, 1 and the poles of tan/log near small integers
  });
}

export function equivalent(a: string, b: string): boolean {
  let na: Node, nb: Node;
  try {
    na = parseExpression(a);
    nb = parseExpression(b);
  } catch {
    return false;
  }
  const vars = [...new Set([...variables(na), ...variables(nb)])];
  const pts = samples(12 * Math.max(1, vars.length));
  let compared = 0;
  for (let i = 0; i < 12; i++) {
    const env = Object.fromEntries(vars.map((v, k) => [v, pts[i * Math.max(1, vars.length) + k]!]));
    const x = evaluate(na, env);
    const y = evaluate(nb, env);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    compared++;
    if (Math.abs(x - y) > 1e-7 * Math.max(1, Math.abs(x), Math.abs(y))) return false;
  }
  return compared >= 6;
}
