// Shared between server (require) and browser (window.GW): expression parser,
// plane constants and the shot simulator.
(function (root) {
  'use strict';

  // ---- Plane ---------------------------------------------------------------
  const PLANE = {
    XMIN: -25, XMAX: 25, YMIN: -15, YMAX: 15,
    PX_W: 770, PX_H: 450,          // mask resolution (15.4 px per unit)
    SOLDIER_R: 0.5,
    EXPLOSION_R: 0.8,
  };
  PLANE.SCALE = PLANE.PX_W / (PLANE.XMAX - PLANE.XMIN);

  // ---- Expression parser -----------------------------------------------------
  const FUNCS = {
    sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp,
    ln: Math.log, log: Math.log10,
    sin: Math.sin, cos: Math.cos, tan: Math.tan,
    asin: Math.asin, acos: Math.acos, atan: Math.atan,
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
    sign: Math.sign, floor: Math.floor,
  };
  const CONSTS = { pi: Math.PI, e: Math.E };
  // longest first so "sinh" wins over "sin", "y'" over "y"
  const NAMES = Object.keys(FUNCS).concat(Object.keys(CONSTS), ['x', "y''", "y'", 'y'])
    .sort((a, b) => b.length - a.length);

  function tokenize(src) {
    const s = src.replace(/’|´|`/g, "'").toLowerCase();
    const out = [];
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === ' ' || c === '\t') { i++; continue; }
      if (/[0-9.]/.test(c)) {
        const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/.exec(s.slice(i));
        if (!m) throw new Error('Bad number at ' + (i + 1));
        out.push({ k: 'num', v: parseFloat(m[0]) });
        i += m[0].length;
        continue;
      }
      if ('+-*/^(),'.includes(c)) { out.push({ k: c }); i++; continue; }
      if (/[a-z']/.test(c)) {
        const name = NAMES.find((n) => s.startsWith(n, i));
        if (!name) throw new Error('Unknown symbol "' + (s.slice(i).match(/^[a-z']+/) || [c])[0] + '"');
        if (FUNCS[name]) out.push({ k: 'fn', v: name });
        else if (CONSTS[name] !== undefined) out.push({ k: 'num', v: CONSTS[name] });
        else out.push({ k: 'var', v: name });
        i += name.length;
        continue;
      }
      throw new Error('Unexpected "' + c + '"');
    }
    return out;
  }

  // AST nodes: ['n', v] | ['v', name] | ['neg', a] | [op, a, b] | ['f', name, a]
  function parse(src, allowedVars) {
    if (typeof src !== 'string' || !src.trim()) throw new Error('Empty function');
    if (src.length > 300) throw new Error('Function too long');
    const toks = tokenize(src);
    let p = 0, depth = 0;
    const peek = () => toks[p];
    const eat = (k) => {
      if (!toks[p] || toks[p].k !== k) throw new Error('Expected "' + k + '"');
      return toks[p++];
    };
    const startsPrimary = (t) => t && (t.k === 'num' || t.k === 'var' || t.k === 'fn' || t.k === '(');

    function expr() {
      if (++depth > 60) throw new Error('Function too deeply nested');
      let a = term();
      while (peek() && (peek().k === '+' || peek().k === '-')) {
        const op = toks[p++].k;
        a = [op, a, term()];
      }
      depth--;
      return a;
    }
    function term() {
      let a = unary();
      for (;;) {
        const t = peek();
        if (t && (t.k === '*' || t.k === '/')) { p++; a = [t.k, a, unary()]; }
        else if (startsPrimary(t)) a = ['*', a, power()]; // implicit: 2x, 3sin(x), (x)(x)
        else return a;
      }
    }
    function unary() {
      const t = peek();
      if (t && t.k === '-') { p++; return ['neg', unary()]; }
      if (t && t.k === '+') { p++; return unary(); }
      return power();
    }
    function power() {
      const base = primary();
      if (peek() && peek().k === '^') { p++; return ['^', base, unary()]; }
      return base;
    }
    function primary() {
      const t = toks[p++];
      if (!t) throw new Error('Unexpected end of function');
      if (t.k === 'num') return ['n', t.v];
      if (t.k === 'var') {
        if (!allowedVars.includes(t.v)) throw new Error('"' + t.v + '" is not allowed in this mode');
        return ['v', t.v];
      }
      if (t.k === '(') { const e = expr(); eat(')'); return e; }
      if (t.k === 'fn') {
        if (peek() && peek().k === '(') { p++; const e = expr(); eat(')'); return ['f', t.v, e]; }
        return ['f', t.v, power()]; // "sin x"
      }
      throw new Error('Unexpected "' + t.k + '"');
    }
    const ast = expr();
    if (p < toks.length) throw new Error('Unexpected "' + (toks[p].k === 'num' ? toks[p].v : toks[p].v || toks[p].k) + '"');
    return ast;
  }

  function compile(ast) {
    switch (ast[0]) {
      case 'n': { const v = ast[1]; return () => v; }
      case 'v':
        if (ast[1] === 'x') return (x) => x;
        if (ast[1] === 'y') return (x, y) => y;
        return (x, y, yp) => yp;
      case 'neg': { const a = compile(ast[1]); return (x, y, yp) => -a(x, y, yp); }
      case 'f': { const f = FUNCS[ast[1]], a = compile(ast[2]); return (x, y, yp) => f(a(x, y, yp)); }
      default: {
        const a = compile(ast[1]), b = compile(ast[2]);
        switch (ast[0]) {
          case '+': return (x, y, yp) => a(x, y, yp) + b(x, y, yp);
          case '-': return (x, y, yp) => a(x, y, yp) - b(x, y, yp);
          case '*': return (x, y, yp) => a(x, y, yp) * b(x, y, yp);
          case '/': return (x, y, yp) => a(x, y, yp) / b(x, y, yp);
          case '^': return (x, y, yp) => Math.pow(a(x, y, yp), b(x, y, yp));
        }
      }
    }
    throw new Error('bad ast');
  }

  const MODES = {
    y: { label: 'y =', vars: ['x'] },
    dy: { label: "y' =", vars: ['x', 'y'] },
    d2y: { label: "y'' =", vars: ['x', 'y', "y'"] },
  };

  function compileFunction(src, mode) {
    return compile(parse(src, MODES[mode].vars));
  }

  // ---- Obstacle mask ---------------------------------------------------------
  function toPx(x, y) {
    return [(x - PLANE.XMIN) * PLANE.SCALE, (PLANE.YMAX - y) * PLANE.SCALE];
  }
  function newMask() { return new Uint8Array(PLANE.PX_W * PLANE.PX_H); }
  function paintCircle(mask, x, y, r, val) {
    const [cx, cy] = toPx(x, y), rp = r * PLANE.SCALE;
    const x0 = Math.max(0, Math.floor(cx - rp)), x1 = Math.min(PLANE.PX_W - 1, Math.ceil(cx + rp));
    const y0 = Math.max(0, Math.floor(cy - rp)), y1 = Math.min(PLANE.PX_H - 1, Math.ceil(cy + rp));
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const dx = px + 0.5 - cx, dy = py + 0.5 - cy;
        if (dx * dx + dy * dy <= rp * rp) mask[py * PLANE.PX_W + px] = val;
      }
    }
  }
  function maskAt(mask, x, y) {
    const [px, py] = toPx(x, y);
    const ix = Math.floor(px), iy = Math.floor(py);
    if (ix < 0 || iy < 0 || ix >= PLANE.PX_W || iy >= PLANE.PX_H) return 0;
    return mask[iy * PLANE.PX_W + ix];
  }
  function circleFree(mask, x, y, r) {
    for (let a = 0; a < 16; a++) {
      for (const rr of [r, r * 0.5]) {
        if (maskAt(mask, x + rr * Math.cos(a * Math.PI / 8), y + rr * Math.sin(a * Math.PI / 8))) return false;
      }
    }
    return !maskAt(mask, x, y);
  }

  // ---- Shot simulation ---------------------------------------------------------
  // Each team sees the plane from its own side: team 2's view is mirrored (X = -x),
  // so every player always fires to the right in their own view. The curve passes
  // through the shooter: for y = f(x) it is f(X) - f(X0) + Y0; for y' and y'' the
  // ODE starts at (X0, Y0) with y'(X0) = 0.
  //
  // soldiers: [{id, x, y, alive}] (not mutated). Returns
  // { points: [[x,y],...] world coords, hits: [{id, i}], explosion: {x,y,i}|null, error }
  function simulateShot({ fn, mode, shooter, team, soldiers, mask }) {
    const s = team === 2 ? -1 : 1;
    const X0 = s * shooter.x, Y0 = shooter.y;
    const points = [[shooter.x, shooter.y]];
    const hits = [];
    let explosion = null;
    const hitSet = new Set();
    const MAX_DY = 0.05, BASE_H = 0.02, MIN_H = 1e-7;

    let step; // (X, state, h) -> new state [Y, Y'] or null
    let state;
    const f = (X, Y, Yp) => fn(X, Y, Yp);
    if (mode === 'y') {
      const off = f(X0, 0, 0);
      if (!isFinite(off)) return { points, hits, explosion, error: 'Function is undefined at the soldier' };
      state = [Y0, 0];
      step = (X, st, h) => [f(X + h, 0, 0) - off + Y0, 0];
    } else if (mode === 'dy') {
      state = [Y0, 0];
      step = (X, st, h) => {
        const y = st[0];
        const k1 = f(X, y), k2 = f(X + h / 2, y + h * k1 / 2), k3 = f(X + h / 2, y + h * k2 / 2), k4 = f(X + h, y + h * k3);
        return [y + h * (k1 + 2 * k2 + 2 * k3 + k4) / 6, 0];
      };
    } else {
      state = [Y0, 0];
      step = (X, st, h) => {
        const [y, v] = st;
        const a1 = f(X, y, v);
        const y2 = y + h * v / 2, v2 = v + h * a1 / 2, a2 = f(X + h / 2, y2, v2);
        const y3 = y + h * v2 / 2, v3 = v + h * a2 / 2, a3 = f(X + h / 2, y3, v3);
        const y4 = y + h * v3, v4 = v + h * a3, a4 = f(X + h, y4, v4);
        return [y + h * (v + 2 * v2 + 2 * v3 + v4) / 6, v + h * (a1 + 2 * a2 + 2 * a3 + a4) / 6];
      };
    }

    let X = X0;
    let lastRecorded = [shooter.x, shooter.y];
    let iter = 0;
    while (iter++ < 400000) {
      let h = BASE_H, next;
      for (;;) {
        next = step(X, state, h);
        if (!isFinite(next[0]) || !isFinite(next[1])) { next = null; if (h <= MIN_H) break; h /= 4; continue; }
        if (Math.abs(next[0] - state[0]) > MAX_DY && h > MIN_H) { h /= 2; continue; }
        break;
      }
      if (!next) break; // undefined: the shot fizzles here
      if (Math.abs(next[0] - state[0]) > MAX_DY * 4) break; // discontinuity
      X += h;
      state = next;
      const wx = s * X, wy = state[0];
      if (wx < PLANE.XMIN || wx > PLANE.XMAX || wy < PLANE.YMIN || wy > PLANE.YMAX) break;

      const dxr = wx - lastRecorded[0], dyr = wy - lastRecorded[1];
      if (dxr * dxr + dyr * dyr > 0.0016) { points.push([wx, wy]); lastRecorded = [wx, wy]; }

      for (const so of soldiers) {
        if (!so.alive || so.id === shooter.id || hitSet.has(so.id)) continue;
        const ddx = so.x - wx, ddy = so.y - wy;
        if (ddx * ddx + ddy * ddy <= PLANE.SOLDIER_R * PLANE.SOLDIER_R) {
          hitSet.add(so.id);
          if (points[points.length - 1][0] !== wx) points.push([wx, wy]);
          hits.push({ id: so.id, i: points.length - 1 });
        }
      }
      if (maskAt(mask, wx, wy)) {
        if (points[points.length - 1][0] !== wx) points.push([wx, wy]);
        explosion = { x: wx, y: wy, i: points.length - 1 };
        break;
      }
    }
    return { points, hits, explosion, error: null };
  }

  const GW = { PLANE, MODES, parse, compileFunction, newMask, paintCircle, maskAt, circleFree, simulateShot };
  if (typeof module !== 'undefined' && module.exports) module.exports = GW;
  else root.GW = GW;
})(typeof window !== 'undefined' ? window : globalThis);
