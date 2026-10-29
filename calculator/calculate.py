#!/usr/bin/env python3
"""
calculate.py - find a Graphwar shot.

Give it your soldier, one or more targets and the circular obstacles. It finds a curve
that goes from your soldier through as many targets as possible (all of them when it
can) without touching any circle, turns that curve
into a function you can type into the game, and then checks the function with a
Python port of the game's own parser and shot simulator (public/shared.js).

Coordinates: use the ones on YOUR screen (the hover readout in the game). Every player
fires to the right in their own view, so targets must be to the right of the shooter.

Exit code: 0 = every target hit, 2 = some targets hit, 1 = none hit or friendly fire.

Examples
  python3 calculate.py --shooter -20,3 --target 15,-4 --circle -5,0,3 --circle 6,-2,2.5
  python3 calculate.py --mode d2y --shooter -18,-6 --target 12,2 --circle 0,-3,4 --plot shot.png
  python3 calculate.py --shooter -20,3 --target 2,1 --target 15,-4 --circle -5,2,3   (two targets)
  python3 calculate.py --friend -15,5 --enemy 18,0 ...   (avoid teammates / report bonus hits)
  python3 calculate.py --check "0.3*x" --shooter -20,3 --target 15,-4 --circle -5,0,3
  python3 calculate.py            # asks for everything interactively
  python3 calculate.py --serve    # web page at http://localhost:8000 (--serve 9000 for another port)

Modes: y   -> type into  y   = ...
       dy  -> type into  y'  = ...
       d2y -> type into  y'' = ...

Needs numpy. matplotlib is optional (only for --plot).
"""
import argparse
import math
import re
import sys

try:
    import numpy as np
except ImportError:
    sys.exit("calculate.py needs numpy:  pip3 install numpy")

INF, NAN = float("inf"), float("nan")
sys.setrecursionlimit(max(sys.getrecursionlimit(), 20000))   # unlimited-length functions nest deeply

# ---- Plane (same numbers as shared.js) ------------------------------------------------
XMIN, XMAX, YMIN, YMAX = -25.0, 25.0, -15.0, 15.0
PX_W, PX_H = 770, 450
SCALE = PX_W / (XMAX - XMIN)
SOLDIER_R = 0.5
YLIM = 14.8          # the planner keeps the path a little inside the top/bottom edge
MAX_LEN = 300        # the game rejects longer functions (unless its server runs --unlimited)
UNLIMITED = math.inf # pass as max_len to allow any length


# =========================================================================================
# 1. Port of the game's expression parser (JS number semantics: no exceptions, inf/nan)
# =========================================================================================
def _sqrt(a):
    return NAN if a < 0 else math.sqrt(a)


def _exp(a):
    try:
        return math.exp(a)
    except OverflowError:
        return INF


def _logf(f):
    def g(a):
        if a != a or a < 0:
            return NAN
        if a == 0:
            return -INF
        return f(a)
    return g


def _trig(f):
    def g(a):
        try:
            return f(a)
        except ValueError:
            return NAN
    return g


def _sinh(a):
    try:
        return math.sinh(a)
    except OverflowError:
        return math.copysign(INF, a)


def _cosh(a):
    try:
        return math.cosh(a)
    except OverflowError:
        return INF


def _sign(a):
    if a != a:
        return NAN
    return 1.0 if a > 0 else -1.0 if a < 0 else 0.0


def _floor(a):
    return float(math.floor(a)) if math.isfinite(a) else a


FUNCS = {
    "sqrt": _sqrt, "abs": abs, "exp": _exp, "ln": _logf(math.log), "log": _logf(math.log10),
    "sin": _trig(math.sin), "cos": _trig(math.cos), "tan": _trig(math.tan),
    "asin": _trig(math.asin), "acos": _trig(math.acos), "atan": math.atan,
    "sinh": _sinh, "cosh": _cosh, "tanh": math.tanh, "sign": _sign, "floor": _floor,
}
CONSTS = {"pi": math.pi, "e": math.e}
NAMES = sorted(list(FUNCS) + list(CONSTS) + ["x", "y''", "y'", "y"], key=len, reverse=True)
MODES = {"y": ("y =", ["x"]), "dy": ("y' =", ["x", "y"]), "d2y": ("y'' =", ["x", "y", "y'"])}
NUM_RE = re.compile(r"(\d+\.?\d*|\.\d+)(e[+-]?\d+)?")


def _div(a, b):
    try:
        return a / b
    except ZeroDivisionError:
        if a != a or a == 0:
            return NAN
        return math.copysign(INF, a) * math.copysign(1.0, b)


def _pow(a, b):
    if b == 2.0:
        return a * a                    # the d2y bumps square every term
    if abs(a) == 1 and math.isinf(b):
        return NAN                      # JS: Math.pow(1, Infinity) is NaN
    try:
        return math.pow(a, b)
    except OverflowError:
        if a < 0 and b == int(b) and int(b) % 2:
            return -INF
        return INF
    except ValueError:
        return INF if a == 0 else NAN


def tokenize(src):
    s = re.sub("[’´`]", "'", src).lower()
    out, i = [], 0
    while i < len(s):
        c = s[i]
        if c in " \t":
            i += 1
            continue
        if c.isdigit() or c == ".":
            m = NUM_RE.match(s, i)
            if not m:
                raise ValueError("Bad number at %d" % (i + 1))
            out.append(("num", float(m.group(0))))
            i = m.end()
            continue
        if c in "+-*/^(),":
            out.append((c, None))
            i += 1
            continue
        if re.match(r"[a-z']", c):
            name = next((n for n in NAMES if s.startswith(n, i)), None)
            if not name:
                raise ValueError('Unknown symbol "%s"' % re.match(r"[a-z']+", s[i:]).group(0))
            if name in FUNCS:
                out.append(("fn", name))
            elif name in CONSTS:
                out.append(("num", CONSTS[name]))
            else:
                out.append(("var", name))
            i += len(name)
            continue
        raise ValueError('Unexpected "%s"' % c)
    return out


def parse(src, allowed, max_len=MAX_LEN):
    if not isinstance(src, str) or not src.strip():
        raise ValueError("Empty function")
    if len(src) > max_len:
        raise ValueError("Function too long (max %d characters)" % max_len)
    toks = tokenize(src)
    st = {"p": 0, "depth": 0}

    def peek():
        return toks[st["p"]] if st["p"] < len(toks) else None

    def eat(k):
        t = peek()
        if not t or t[0] != k:
            raise ValueError('Expected "%s"' % k)
        st["p"] += 1

    def starts_primary(t):
        return t is not None and t[0] in ("num", "var", "fn", "(")

    def expr():
        st["depth"] += 1
        if st["depth"] > 60:
            raise ValueError("Function too deeply nested")
        a = term()
        while peek() and peek()[0] in "+-":
            op = peek()[0]
            st["p"] += 1
            a = (op, a, term())
        st["depth"] -= 1
        return a

    def term():
        a = unary()
        while True:
            t = peek()
            if t and t[0] in ("*", "/"):
                st["p"] += 1
                a = (t[0], a, unary())
            elif starts_primary(t):
                a = ("*", a, power())          # implicit multiplication
            else:
                return a

    def unary():
        t = peek()
        if t and t[0] == "-":
            st["p"] += 1
            return ("neg", unary())
        if t and t[0] == "+":
            st["p"] += 1
            return unary()
        return power()

    def power():
        base = primary()
        if peek() and peek()[0] == "^":
            st["p"] += 1
            return ("^", base, unary())
        return base

    def primary():
        t = peek()
        if not t:
            raise ValueError("Unexpected end of function")
        st["p"] += 1
        if t[0] == "num":
            return ("n", t[1])
        if t[0] == "var":
            if t[1] not in allowed:
                raise ValueError('"%s" is not allowed in this mode' % t[1])
            return ("v", t[1])
        if t[0] == "(":
            e = expr()
            eat(")")
            return e
        if t[0] == "fn":
            if peek() and peek()[0] == "(":
                st["p"] += 1
                e = expr()
                eat(")")
                return ("f", t[1], e)
            return ("f", t[1], power())
        raise ValueError('Unexpected "%s"' % t[0])

    ast = expr()
    if st["p"] < len(toks):
        raise ValueError('Unexpected "%s"' % (toks[st["p"]][1] or toks[st["p"]][0]))
    return ast


def compile_ast(a):
    k = a[0]
    if k == "n":
        v = a[1]
        return lambda x, y, yp: v
    if k == "v":
        return {"x": lambda x, y, yp: x, "y": lambda x, y, yp: y}.get(a[1], lambda x, y, yp: yp)
    if k == "neg":
        f = compile_ast(a[1])
        return lambda x, y, yp: -f(x, y, yp)
    if k == "f":
        fn, f = FUNCS[a[1]], compile_ast(a[2])
        return lambda x, y, yp: fn(f(x, y, yp))
    f, g = compile_ast(a[1]), compile_ast(a[2])
    if k == "+":
        return lambda x, y, yp: f(x, y, yp) + g(x, y, yp)
    if k == "-":
        return lambda x, y, yp: f(x, y, yp) - g(x, y, yp)
    if k == "*":
        return lambda x, y, yp: f(x, y, yp) * g(x, y, yp)
    if k == "/":
        return lambda x, y, yp: _div(f(x, y, yp), g(x, y, yp))
    return lambda x, y, yp: _pow(f(x, y, yp), g(x, y, yp))


_EVAL_NS = dict({"f_" + k: v for k, v in FUNCS.items()}, _div=_div, _pow=_pow)


def ast_source(a):
    """The AST as one Python expression with the same JS number semantics as compile_ast
    (Python's float + - * already give inf/nan instead of raising)."""
    return _src(a)[0]


def _src(a):
    """-> (source, precedence): 1 for + -, 2 for *, 3 for atoms. Only the parentheses the
    evaluation order needs are written, so long a + b + c ... chains stay flat (Python's
    parser refuses ~200 nested parentheses)."""
    k = a[0]
    if k == "n":
        return repr(float(a[1])), 3
    if k == "v":
        return {"x": "x", "y": "y"}.get(a[1], "yp"), 3
    if k == "neg":
        s, p = _src(a[1])
        return ("(-%s)" if p == 3 else "(-(%s))") % s, 3
    if k == "f":
        return "f_%s(%s)" % (a[1], _src(a[2])[0]), 3
    (l, lp), (r, rp) = _src(a[1]), _src(a[2])
    if k in ("+", "-", "*"):
        p = 2 if k == "*" else 1
        l = l if lp >= p else "(%s)" % l          # left-assoc: same level needs no parens
        r = r if rp > p else "(%s)" % r           # a - (b + c), a*(b*c) keep theirs
        return "%s %s %s" % (l, k, r), p
    return "%s(%s, %s)" % ("_div" if k == "/" else "_pow", l, r), 3


def compile_function(src, mode, max_len=MAX_LEN):
    ast = parse(src, MODES[mode][1], max_len)
    try:   # one flat function is ~5x faster than the closure tree in the simulator loop
        return eval("lambda x, y, yp: " + ast_source(ast), dict(_EVAL_NS))
    except (SyntaxError, RecursionError, MemoryError):
        return compile_ast(ast)


# =========================================================================================
# 2. Port of the obstacle mask and shot simulator (shooter's own view = team 1)
# =========================================================================================
def make_mask(circles):
    mask = np.zeros((PX_H, PX_W), dtype=np.uint8)
    for (x, y, r) in circles:
        cx, cy, rp = (x - XMIN) * SCALE, (YMAX - y) * SCALE, r * SCALE
        x0, x1 = max(0, math.floor(cx - rp)), min(PX_W - 1, math.ceil(cx + rp))
        y0, y1 = max(0, math.floor(cy - rp)), min(PX_H - 1, math.ceil(cy + rp))
        if x0 > x1 or y0 > y1:
            continue
        py, px = np.mgrid[y0:y1 + 1, x0:x1 + 1]
        inside = (px + 0.5 - cx) ** 2 + (py + 0.5 - cy) ** 2 <= rp * rp
        mask[y0:y1 + 1, x0:x1 + 1][inside] = 1
    return mask


def mask_at(mask, x, y):
    ix, iy = math.floor((x - XMIN) * SCALE), math.floor((YMAX - y) * SCALE)
    if ix < 0 or iy < 0 or ix >= PX_W or iy >= PX_H:
        return 0
    return mask[iy, ix]


def simulate(fn, mode, X0, Y0, soldiers, mask):
    """soldiers: list of (id, x, y). Returns dict(points, hits, explosion, end)."""
    fin = math.isfinite
    points, hits, hitset = [(X0, Y0)], [], set()
    explosion, end = None, "ran out of steps"
    MAX_DY, BASE_H, MIN_H = 0.05, 0.02, 1e-7

    if mode == "y":
        off = fn(X0, 0.0, 0.0)
        if not fin(off):
            return {"points": points, "hits": hits, "explosion": None,
                    "end": "function is undefined at the soldier"}

        def step(X, s, h):
            return (fn(X + h, 0.0, 0.0) - off + Y0, 0.0)
    elif mode == "dy":
        def step(X, s, h):
            y = s[0]
            k1 = fn(X, y, 0.0)
            k2 = fn(X + h / 2, y + h * k1 / 2, 0.0)
            k3 = fn(X + h / 2, y + h * k2 / 2, 0.0)
            k4 = fn(X + h, y + h * k3, 0.0)
            return (y + h * (k1 + 2 * k2 + 2 * k3 + k4) / 6, 0.0)
    else:
        def step(X, s, h):
            y, v = s
            a1 = fn(X, y, v)
            y2, v2 = y + h * v / 2, v + h * a1 / 2
            a2 = fn(X + h / 2, y2, v2)
            y3, v3 = y + h * v2 / 2, v + h * a2 / 2
            a3 = fn(X + h / 2, y3, v3)
            y4, v4 = y + h * v3, v + h * a3
            a4 = fn(X + h, y4, v4)
            return (y + h * (v + 2 * v2 + 2 * v3 + v4) / 6, v + h * (a1 + 2 * a2 + 2 * a3 + a4) / 6)

    # mask lookup inlined: this loop runs up to 400k times per check
    floor, mrows = math.floor, mask.tolist()
    X, state, last, it = X0, (Y0, 0.0), (X0, Y0), 0
    while it < 400000:
        it += 1
        h = BASE_H
        while True:
            nxt = step(X, state, h)
            if not (fin(nxt[0]) and fin(nxt[1])):
                nxt = None
                if h <= MIN_H:
                    break
                h /= 4
                continue
            if abs(nxt[0] - state[0]) > MAX_DY and h > MIN_H:
                h /= 2
                continue
            break
        if nxt is None:
            end = "fizzled (function undefined at x=%.2f)" % X
            break
        if abs(nxt[0] - state[0]) > MAX_DY * 4:
            end = "stopped at a discontinuity (x=%.2f)" % X
            break
        X += h
        state = nxt
        wx, wy = X, state[0]
        if wx < XMIN or wx > XMAX or wy < YMIN or wy > YMAX:
            end = "left the board"
            break
        if (wx - last[0]) ** 2 + (wy - last[1]) ** 2 > 0.0016:
            points.append((wx, wy))
            last = (wx, wy)
        for (sid, sx, sy) in soldiers:
            if sid in hitset:
                continue
            if (sx - wx) ** 2 + (sy - wy) ** 2 <= SOLDIER_R * SOLDIER_R:
                hitset.add(sid)
                if points[-1][0] != wx:
                    points.append((wx, wy))
                hits.append((sid, len(points) - 1))
        ix, iy = floor((wx - XMIN) * SCALE), floor((YMAX - wy) * SCALE)
        if 0 <= ix < PX_W and 0 <= iy < PX_H and mrows[iy][ix]:
            if points[-1][0] != wx:
                points.append((wx, wy))
            explosion = (wx, wy)
            end = "hit an obstacle at (%.2f, %.2f)" % (wx, wy)
            break
    return {"points": points, "hits": hits, "explosion": explosion, "end": end}


# =========================================================================================
# 3. Path planner: shortest x-monotone polyline that keeps `margin` away from every circle
# =========================================================================================
RES = 0.025                                   # clearance raster cell size
_GX = np.arange(XMIN, XMAX + RES / 2, RES)
_GY = np.arange(YMIN, YMAX + RES / 2, RES)
_dist_cache = {}


def _circle_dist(circles):
    """Distance from every raster cell to the nearest circle edge (cached per obstacle set)."""
    key = tuple(tuple(c) for c in circles)
    if key not in _dist_cache:
        D = np.full((len(_GY), len(_GX)), INF, np.float32)
        for (x, y, r) in circles:
            np.minimum(D, np.hypot(_GX[None, :] - x, _GY[:, None] - y) - r, out=D)
        if len(_dist_cache) > 8:
            _dist_cache.clear()
        _dist_cache[key] = D
    return _dist_cache[key]


def make_clear(circles, margin, relax_pts):
    """Vectorised test: is (X, Y) at least `margin` from every circle and inside the board?
    Near the shooter/target the margin shrinks, so a soldier standing next to a rock
    can still be reached. The answer is precomputed on a RES raster, so a test is a lookup."""
    D = _circle_dist(circles)
    req = np.full(D.shape, margin, np.float32)
    w = int(2 * margin / RES) + 2                 # beyond 2*margin the relaxation does nothing
    for (px, py) in relax_pts:
        i0, j0 = int(round((px - XMIN) / RES)), int(round((py - YMIN) / RES))
        si, sj = slice(max(0, i0 - w), max(0, i0 + w + 1)), slice(max(0, j0 - w), max(0, j0 + w + 1))
        d = np.hypot(_GX[None, si] - px, _GY[sj, None] - py)
        np.minimum(req[sj, si], np.maximum(0.06, 0.5 * d), out=req[sj, si])
    ok = (D >= req) & (np.abs(_GY) <= YLIM + 0.1)[:, None]
    nx, ny = len(_GX) - 1, len(_GY) - 1

    def clear(X, Y):
        X, Y = np.asarray(X, float), np.asarray(Y, float)
        ix = np.clip(np.rint((X - XMIN) / RES), 0, nx).astype(np.intp)
        iy = np.clip(np.rint((Y - YMIN) / RES), 0, ny).astype(np.intp)
        return ok[iy, ix] & (np.abs(Y) <= YLIM + 0.1)
    clear.ok = ok
    return clear


def _cell(v, lo):
    return np.clip(np.rint((np.asarray(v, float) - lo) / RES), 0, None).astype(np.intp)


HIT_BONUS = 1000.0   # one more target always beats any amount of extra path length
HIT_TOL = 0.15       # the planned path passes within this height of a target's centre


def plan(S, targets, clear, max_slope, dx_target=0.25, dy=0.1, reach_only=False):
    """Shortest x-monotone path from S that passes through as many targets as possible.

    Columns are placed so that every target's x is exactly a column. Passing a target
    (within HIT_TOL vertically) earns a large bonus, so the dynamic programme first
    maximises the number of targets and then minimises length.
    Returns (path, anchors, hit) - anchors are indices in `path` that sit on a target,
    hit the target indices - or None if no target can be reached.
    With reach_only, returns the set of targets some clear path can get to."""
    Sx, Sy = S
    grid = np.round(np.arange(-YLIM, YLIM + 1e-9, dy), 6)
    M = len(grid)
    cols = np.arange(M)

    reach = [i for i, t in enumerate(targets) if t[0] > Sx + 0.05]
    if not reach:
        return set() if reach_only else None
    xs = [Sx]
    for bx in sorted(targets[i][0] for i in reach):
        if bx - xs[-1] < 0.02:
            continue
        n = max(1, math.ceil((bx - xs[-1]) / dx_target))
        xs += [float(v) for v in np.linspace(xs[-1], bx, n + 1)[1:]]
    N = len(xs) - 1

    # which targets sit on which column, and which grid nodes count as passing them
    col_targets = {}
    for i in reach:
        j = min(range(1, N + 1), key=lambda c: abs(xs[c] - targets[i][0]))
        col_targets.setdefault(j, []).append(i)

    def near(i):
        return np.abs(grid - min(YLIM, max(-YLIM, targets[i][1]))) <= HIT_TOL + 1e-9

    def seg_ok(x0, y0, x1, y1):
        """Is each segment (x0, y0[i]) -> (x1, y1[i]) clear? First an O(1) test on the raster
        strip between x0 and x1: clear if every row it spans is clear across the strip,
        blocked if an inner row is blocked across the strip. Only the rest are sampled
        every ~0.05 units, grouped by sample count so each group is one lookup."""
        y0, y1 = np.broadcast_arrays(np.asarray(y0, float), np.asarray(y1, float))
        strip = clear.ok[:, int(_cell(min(x0, x1), XMIN)):int(_cell(max(x0, x1), XMIN)) + 1]
        pc = np.concatenate(([0], np.cumsum(~strip.all(axis=1))))
        pb = np.concatenate(([0], np.cumsum(~strip.any(axis=1))))
        r0 = np.minimum(_cell(np.minimum(y0, y1), YMIN), len(_GY) - 1)
        r1 = np.minimum(_cell(np.maximum(y0, y1), YMIN), len(_GY) - 1)
        out = pc[r1 + 1] == pc[r0]
        todo = ~out & ~((r1 - r0 >= 2) & (pb[r1] > pb[r0 + 1]))
        if not todo.any():
            return out
        a, b = y0[todo], y1[todo]
        n = np.ceil(np.hypot(x1 - x0, b - a) / 0.05)
        n = np.maximum(4, 2 ** np.ceil(np.log2(np.maximum(n, 1)))).astype(int)
        res = np.empty(a.shape, bool)
        for k in np.unique(n):
            sel = n == k
            t = (np.arange(1, k + 1) / (k + 1))[:, None]
            res[sel] = clear(x0 + (x1 - x0) * t, a[sel][None, :] + (b - a)[sel][None, :] * t).all(axis=0)
        out[todo] = res
        return out

    costs, backs = [np.array([0.0])], [None]
    for j in range(1, N + 1):
        x0, x1 = xs[j - 1], xs[j]
        dx = x1 - x0
        node_ok = clear(x1, grid)
        new, bk = np.full(M, INF), np.full(M, -1)
        prev = costs[-1]
        if j == 1:
            dyv = grid - Sy
            ok = node_ok & (np.abs(dyv) <= max_slope * dx + 1e-9) & seg_ok(x0, Sy, x1, grid)
            new = np.where(ok, np.hypot(dx, dyv), INF)
            bk[:] = 0
        else:
            # every (offset, node) candidate at once, cheapest first; segments are checked in
            # growing batches of ranks until each node has its cheapest clear incoming edge
            D = min(M - 1, int(max_slope * dx / dy + 1e-9))
            offs = np.arange(-D, D + 1)
            src = cols[None, :] - offs[:, None]
            C = np.where((src >= 0) & (src < M),
                         prev[np.clip(src, 0, M - 1)] + np.hypot(dx, offs * dy)[:, None], INF)
            C[:, ~node_ok] = INF
            k0 = C.argmin(axis=0)
            c0, s0 = C[k0, cols], src[k0, cols]
            fin0 = np.isfinite(c0)
            good0 = np.zeros(M, bool)
            good0[fin0] = seg_ok(x0, grid[s0[fin0]], x1, grid[fin0])
            new[good0], bk[good0] = c0[good0], s0[good0]
            # nodes whose cheapest edge is blocked: sort just their candidates
            uu = np.nonzero(fin0 & ~good0)[0]
            Cu = C[:, uu]
            order = np.argsort(Cu, axis=0, kind="stable")
            Cs = np.take_along_axis(Cu, order, axis=0)
            open_ = np.ones(len(uu), bool)
            lo, size = 1, 2
            while open_.any() and lo < len(offs):
                hi = min(len(offs), lo + size)
                ui = np.nonzero(open_)[0]
                u = uu[ui]
                bc = Cs[lo:hi, ui]
                bs = src[order[lo:hi, ui], u[None, :]]
                fin = np.isfinite(bc)
                good = np.zeros(bc.shape, bool)
                mm = np.broadcast_to(u, bc.shape)
                good[fin] = seg_ok(x0, grid[bs[fin]], x1, grid[mm[fin]])
                got = good.any(axis=0)
                first = good.argmax(axis=0)[got]
                new[u[got]] = bc[first, got]
                bk[u[got]] = bs[first, got]
                open_[ui[got | ~fin[-1]]] = False
                lo, size = hi, size * 2
        for i in col_targets.get(j, []):
            new = np.where(near(i) & np.isfinite(new), new - HIT_BONUS, new)
        costs.append(new)
        backs.append(bk)

    if reach_only:
        return {i for j, ids in col_targets.items() for i in ids if np.isfinite(costs[j][near(i)]).any()}

    # the path may end at any target column (later columns may be walled off)
    best_j, best_m, best_c = None, None, INF
    for j in col_targets:
        m = int(np.argmin(costs[j]))
        if not math.isfinite(costs[j][m]):
            continue
        if costs[j][m] < best_c - 1e-9 or (abs(costs[j][m] - best_c) <= 1e-9 and j > best_j):
            best_j, best_m, best_c = j, m, costs[j][m]
    if best_j is None or best_c > -HIT_BONUS / 2:
        return None

    nodes, m = [], best_m
    for j in range(best_j, 0, -1):
        nodes.append((j, m))
        m = int(backs[j][m])
    nodes.reverse()
    path, anchors, hit = [S], [0], []
    for j, m in nodes:
        y = float(grid[m])
        on = [i for i in col_targets.get(j, []) if near(i)[m]]
        if on:
            y = targets[on[0]][1] if len(on) == 1 else y   # snap onto the target's centre
            hit += on
            anchors.append(len(path))
        path.append((xs[j], y))
    return path, anchors, sorted(hit)


def segment_clear(clear, a, b):
    L = math.hypot(b[0] - a[0], b[1] - a[1])
    t = np.linspace(0, 1, max(3, int(L / 0.03) + 2))
    return bool(clear(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t).all())


def simplify(path, clear, anchors=None):
    """Greedy: from each knot jump as far along the path as a straight line stays clear.
    Anchors (the targets) are always kept as knots."""
    anchors = sorted(set(anchors or []) | {0, len(path) - 1})
    out = [path[0]]
    for a, b in zip(anchors, anchors[1:]):
        i = a
        while i < b:
            j = i + 1
            while j + 1 <= b and segment_clear(clear, path[i], path[j + 1]):
                j += 1
            out.append(path[j])
            i = j
    return out


# =========================================================================================
# 4. Polyline -> function text
# =========================================================================================
def fmt(v, nd):
    s = ("%." + str(nd) + "f") % v
    s = s.rstrip("0").rstrip(".") if "." in s else s
    return "0" if s in ("-0", "", "-") else s


def join_terms(terms, nd):
    """terms: list of (coef, body or None). Builds 'a*body + b*body - ...'."""
    out = ""
    for coef, body in terms:
        c = fmt(abs(coef), nd)
        if c == "0":
            continue
        piece = c if body is None else (body if c == "1" else c + "*" + body)
        if not out:
            out = ("-" if coef < 0 else "") + piece
        else:
            out += (" - " if coef < 0 else " + ") + piece
    return out or "0"


def shifted(c, nd):
    v = fmt(abs(c), nd)
    if v == "0":
        return "x"
    return "x - " + v if c > 0 else "x + " + v


def slopes_of(knots):
    return [(b[1] - a[1]) / (b[0] - a[0]) for a, b in zip(knots, knots[1:])]


def build_expr(mode, knots, nd, k=None):
    """knots: polyline from the shooter to the target (for d2y it starts flat)."""
    s = slopes_of(knots)
    xs = [p[0] for p in knots]
    if mode in ("y", "dy"):
        B = (s[0] + s[-1]) / 2
        body = "abs(%s)" if mode == "y" else "sign(%s)"
        terms = [(B, "x" if mode == "y" else None)]
        for i in range(1, len(s)):
            terms.append(((s[i] - s[i - 1]) / 2, body % shifted(xs[i], nd)))
        return join_terms(terms, nd)
    # d2y: each corner is a smooth bump of curvature, (k/2)/cosh(k(x-c))^2, which bends the
    # slope by exactly 1. The centre is moved back by ln2/(2k) so the bent line ends up
    # exactly on the planned one.
    delta = math.log(2) / (2 * k)
    terms = []
    for i in range(1, len(s)):
        a = (s[i] - s[i - 1]) * k / 2
        terms.append((a, "/cosh(%s*(%s))^2" % (fmt(k, 3), shifted(xs[i] - delta, nd))))
    out = ""
    for a, body in terms:
        c = fmt(abs(a), nd)
        if c == "0":
            continue
        out += ("-" if a < 0 else "") + c + body if not out else (" - " if a < 0 else " + ") + c + body
    return out or "0"


# =========================================================================================
# 5. Checking a function
# =========================================================================================
def check(expr, mode, shooter, targets, circles, friends, enemies, mask, max_len=MAX_LEN):
    fn = compile_function(expr, mode, max_len)
    sold = [("T%d" % (i + 1), x, y) for i, (x, y) in enumerate(targets)]
    sold += [("enemy%d" % (i + 1), x, y) for i, (x, y) in enumerate(enemies)]
    sold += [("friend%d" % (i + 1), x, y) for i, (x, y) in enumerate(friends)]
    res = simulate(fn, mode, shooter[0], shooter[1], sold, mask)
    hit_at = dict(res["hits"])
    res["targets_hit"] = [i for i in range(len(targets)) if "T%d" % (i + 1) in hit_at]
    res["friendly_fire"] = [h for h in hit_at if h.startswith("friend")]
    res["bonus"] = [h for h in hit_at if h.startswith("enemy")]
    res["ok"] = len(res["targets_hit"]) == len(targets) and not res["friendly_fire"]
    # closest approach to an obstacle up to the last target hit
    pts = res["points"]
    if res["targets_hit"]:
        pts = pts[: max(hit_at["T%d" % (i + 1)] for i in res["targets_hit"]) + 1]
    C = np.array(circles, float).reshape(-1, 3)
    P = np.array(pts, float)
    if len(C) and len(P):
        res["clearance"] = float(np.min(np.hypot(P[:, None, 0] - C[:, 0], P[:, None, 1] - C[:, 1]) - C[:, 2]))
    else:
        res["clearance"] = None
    return res


def _score(res):
    """Higher is better: no friendly fire first, then number of targets hit."""
    return (0 if res["friendly_fire"] else 1, len(res["targets_hit"]))


def solve(mode, shooter, targets, circles, friends, enemies, margin, max_slope, max_len=MAX_LEN):
    """Find a function that hits as many `targets` as possible (all of them if it can).
    Returns the best checked result, or None if no target can be reached at all."""
    targets = [tuple(t) for t in targets]
    mask = make_mask(circles)
    avoid = list(circles) + [(x, y, SOLDIER_R) for (x, y) in friends]

    def attempt(m):
        """Plan at margin m, write the function, simulate. Returns (result, planned) or None."""
        if mode == "d2y":
            k0 = 12.0
            lead = (shooter[0] + 3 / k0 + math.log(2) / (2 * k0), shooter[1])
            start, relax = lead, [shooter, lead] + targets
        else:
            start, relax = shooter, [shooter] + targets
        clear = make_clear(avoid, m, relax)
        r = plan(start, targets, clear, max_slope)
        if r is None:
            return None
        out = realize(r[0], r[1], r[2], clear, m)
        if out:
            return out
        # every function for this plan is over max_len: plan through fewer targets, keeping
        # the first k along the path, and binary-search the largest k that still fits
        order = sorted(r[2], key=lambda i: targets[i][0])
        lo, hi, found = 1, len(order) - 1, None
        while lo <= hi:
            k = (lo + hi) // 2
            sub = order[:k]
            rk = plan(start, [targets[i] for i in sub], clear, max_slope)
            out_k = rk and realize(rk[0], rk[1], [sub[i] for i in rk[2]], clear, m)
            if out_k:
                found, lo = out_k, k + 1
            else:
                hi = k - 1
        if found:
            found[0]["too_long"] = [i for i in order if i not in found[0]["targets_hit"]]
        return found

    def realize(path, anchors, planned, clear, m):
        """Turn a planned path into a function and check it. Returns (result, planned) or
        None when every version of the function is longer than the game allows."""
        base = simplify(path, clear, anchors)
        best = None
        for k in ([12.0, 8.0, 20.0] if mode == "d2y" else [None]):
            knots = base
            if mode == "d2y":   # the flat lead-in length depends on k
                knots = [shooter, (shooter[0] + 3 / k + math.log(2) / (2 * k), shooter[1])] + base[1:]
            for nd in (4, 3, 2):
                expr = build_expr(mode, knots, nd, k)
                if len(expr) > max_len:
                    continue
                res = check(expr, mode, shooter, targets, circles, friends, enemies, mask, max_len)
                res.update(expr=expr, knots=knots, margin=m, planned=planned)
                if best is None or _score(res) > _score(best):
                    best = res
                if not res["friendly_fire"] and set(planned) <= set(res["targets_hit"]):
                    return best, planned
        return (best, planned) if best else None

    best = None

    def keep(r):
        nonlocal best
        if r and (best is None or _score(r[0]) > _score(best)):
            best = r[0]

    r = attempt(margin)
    keep(r)
    if best and best["ok"]:
        return best
    # the plan was right but the shot didn't follow it: give the obstacles more room
    if r is None or not set(r[1]) <= set(r[0]["targets_hit"]):
        for m in (margin + 0.2, margin + 0.4):
            r2 = attempt(m)
            keep(r2)
            if best and best["ok"]:
                return best
            if r2 and set(r2[1]) <= set(r2[0]["targets_hit"]):
                break
    # some targets are out of reach at this margin: squeeze through narrower gaps
    for m in (max(0.15, margin * 0.5), 0.08):
        if m >= margin:
            continue
        r2 = attempt(m)
        if r2 and best and _score(r2[0]) <= _score(best):
            continue
        keep(r2)
        if best and best["ok"]:
            return best
    if best:
        # tell apart "walled off" from "only clashes with the targets that were chosen"
        start = shooter if mode != "d2y" else (shooter[0] + 0.3, shooter[1])
        clear = make_clear(avoid, 0.08, [shooter, start] + targets)
        reached = plan(start, targets, clear, max_slope, reach_only=True)
        best["blocked"] = [i for i in range(len(targets))
                           if i not in best["targets_hit"] and targets[i][0] > shooter[0] + 0.3
                           and i not in reached]
    return best


# =========================================================================================
# 6. CLI
# =========================================================================================
def point(s):
    v = [float(t) for t in s.replace(" ", "").strip("()").split(",")]
    if len(v) != 2:
        raise argparse.ArgumentTypeError("expected x,y")
    return tuple(v)


def circle(s):
    v = [float(t) for t in s.replace(" ", "").strip("()").split(",")]
    if len(v) != 3 or v[2] <= 0:
        raise argparse.ArgumentTypeError("expected x,y,r")
    return tuple(v)


def ask(prompt, conv, default=None):
    while True:
        raw = input(prompt).strip()
        if not raw and default is not None:
            return default
        try:
            return conv(raw)
        except Exception as e:  # noqa
            print("  ? " + str(e))


def ask_list(title, prompt, conv, hint):
    print(title)
    out = []
    while True:
        raw = input(prompt).strip()
        if not raw:
            return out
        try:
            out.append(conv(raw))
        except Exception:
            print("  ? expected " + hint)


def interactive(a):
    print("Graphwar shot calculator - use the coordinates shown on your own screen.\n")
    a.mode = ask("Mode [y / dy / d2y] (default y): ",
                 lambda s: s if s in MODES else (_ for _ in ()).throw(ValueError("y, dy or d2y")), "y")
    if a.shooter is None:
        a.shooter = ask("Your soldier x,y: ", point)
    if not a.target:
        while not a.target:
            a.target = ask_list("Targets as x,y - one per line, empty line to finish:", "  target: ", point, "x,y")
    if not a.circle:
        a.circle = ask_list("Obstacles as x,y,r - one per line, empty line to finish:", "  circle: ", circle, "x,y,r")
    if not a.friend:
        a.friend = ask_list("Teammates to avoid as x,y (optional, empty line to finish):", "  friend: ", point, "x,y")
    return a


def lim(n):
    return "unlimited" if math.isinf(n) else "%d" % n


def report(res, mode, a):
    label = MODES[mode][0]
    if res.get("expr"):
        print("\n  %s %s\n" % (label, res["expr"]))
        print("  path   : " + "  ->  ".join("(%.2f, %.2f)" % p for p in res["knots"]))
        print("  length : %d / %s characters" % (len(res["expr"]), lim(a.max_len)))
    n, got = len(a.target), set(res["targets_hit"])
    print("  targets: %d of %d hit" % (len(got), n))
    for i, (x, y) in enumerate(a.target):
        if i in got:
            why = "HIT"
        elif x <= a.shooter[0] + 0.3:
            why = "missed - it is not to the right of your soldier"
        elif i in res.get("blocked", []):
            why = "missed - obstacles block every path to it"
        elif i in res.get("too_long", []):
            why = "missed - adding it makes the function longer than %d characters" % a.max_len
        elif res.get("planned") is not None and i not in res["planned"]:
            why = "missed - can't be hit on the same curve as the others"
        else:
            why = "missed"
        print("    T%d (%.2f, %.2f): %s" % (i + 1, x, y, why))
    if res.get("too_long"):
        print("  note   : a curve through more targets exists, but its function would be over the "
              "%d-character limit" % a.max_len)
    if res["friendly_fire"]:
        print("  WARNING: friendly fire on " + ", ".join(res["friendly_fire"]))
    if res["bonus"]:
        print("  bonus  : also hits " + ", ".join(res["bonus"]))
    if res["clearance"] is not None:
        print("  closest: %.2f units from an obstacle on the way" % res["clearance"])
    print("  after  : shot " + res["end"])
    if res.get("margin") is not None and res["margin"] < a.margin:
        print("  note   : had to squeeze to a %.2f margin (asked for %.2f) - aim carefully" % (res["margin"], a.margin))


def plot(res, a, path):
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        print("  (matplotlib not installed - skipping the plot)")
        return
    fig, ax = plt.subplots(figsize=(10, 6))
    ax.set_facecolor("#12151c")
    for (x, y, r) in a.circle:
        ax.add_patch(plt.Circle((x, y), r, color="#4a5263"))
        ax.add_patch(plt.Circle((x, y), r + a.margin, fill=False, ls="--", color="#6b7385", lw=0.8))
    P = np.array(res["points"])
    ax.plot(P[:, 0], P[:, 1], color="#ff6b6b", lw=2, label="simulated shot")
    if res.get("knots"):
        K = np.array(res["knots"])
        ax.plot(K[:, 0], K[:, 1], "o:", color="#ffd166", ms=3, lw=1, label="planned path")
    ax.add_patch(plt.Circle(a.shooter, SOLDIER_R, color="#ff6b6b"))
    for i, t in enumerate(a.target):
        hit = i in res["targets_hit"]
        ax.add_patch(plt.Circle(t, SOLDIER_R, color="#5fb8ff", alpha=1 if hit else 0.45))
        ax.annotate("T%d" % (i + 1), t, xytext=(0, 9), textcoords="offset points",
                    ha="center", color="#cfe8ff" if hit else "#7a8799", fontsize=8)
    for f in a.friend:
        ax.add_patch(plt.Circle(f, SOLDIER_R, color="#ff6b6b", alpha=0.5))
    for e in a.enemy:
        ax.add_patch(plt.Circle(e, SOLDIER_R, color="#5fb8ff", alpha=0.5))
    ax.set_xlim(XMIN, XMAX)
    ax.set_ylim(YMIN, YMAX)
    ax.set_aspect("equal")
    ax.grid(color="#2a2f3a", lw=0.5)
    ax.set_title("%s %s" % (MODES[a.mode][0], res.get("expr", a.check)), fontsize=8)
    ax.legend(loc="lower right", fontsize=8)
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    print("  plot   : saved to " + path)


# =========================================================================================
# 7. Web page: python3 calculate.py --serve  ->  http://localhost:8000
# =========================================================================================
def parse_list(text, conv):
    """'1,2,3 --circle 1,6,4' or one per line -> [conv('1,2,3'), conv('1,6,4')]."""
    text = re.sub(r"--[a-z-]+", " ", text or "")
    text = re.sub(r"\s*,\s*", ",", text.replace("(", " ").replace(")", " "))
    return [conv(t) for t in re.split(r"[\s;]+", text) if t]


def web_solve(q):
    """q: dict of strings from the page. Returns a JSON-ready dict."""
    def one(name, conv):
        v = parse_list(q.get(name, ""), conv)
        if len(v) != 1:
            raise ValueError("%s: enter exactly one value" % name)
        return v[0]

    mode = q.get("mode") or "y"
    if mode not in MODES:
        raise ValueError("mode must be y, dy or d2y")
    shooter = one("shooter", point)
    targets = parse_list(q.get("target"), point)
    circles = parse_list(q.get("circle"), circle)
    friends = parse_list(q.get("friend"), point)
    enemies = parse_list(q.get("enemy"), point)
    margin = float(q.get("margin") or 0.4)
    max_slope = float(q.get("max_slope") or 8.0)
    max_len = UNLIMITED if q.get("unlimited") else MAX_LEN
    expr = (q.get("check") or "").strip()
    if not targets:
        raise ValueError("target: enter at least one x,y")
    for name, (x, y) in [("shooter", shooter)] + [("T%d" % (i + 1), t) for i, t in enumerate(targets)]:
        if not (XMIN <= x <= XMAX and YMIN <= y <= YMAX):
            raise ValueError("%s is off the board (x in -25..25, y in -15..15)" % name)

    if expr:
        res = check(expr, mode, shooter, targets, circles, friends, enemies, make_mask(circles), max_len)
        res["expr"] = expr
    else:
        res = solve(mode, shooter, targets, circles, friends, enemies, margin, max_slope, max_len)
        if res is None:
            raise ValueError("No path found: the obstacles wall off every target.")

    status = []
    for i, (x, y) in enumerate(targets):
        if i in res["targets_hit"]:
            why = "HIT"
        elif x <= shooter[0] + 0.3:
            why = "missed - not to the right of your soldier"
        elif i in res.get("blocked", []):
            why = "missed - obstacles block every path to it"
        elif i in res.get("too_long", []):
            why = "missed - function would be over %d characters" % max_len
        else:
            why = "missed"
        status.append("T%d (%g, %g): %s" % (i + 1, x, y, why))
    return {
        "label": MODES[mode][0], "expr": res.get("expr"), "ok": res["ok"],
        "max_len": None if math.isinf(max_len) else max_len,
        "targets": status, "friendly_fire": res["friendly_fire"], "bonus": res["bonus"],
        "clearance": res["clearance"], "end": res["end"], "margin": res.get("margin"),
        "points": res["points"][::max(1, len(res["points"]) // 600)] + res["points"][-1:],
        "knots": res.get("knots"),
        "board": {"shooter": shooter, "targets": targets, "circles": circles,
                  "friends": friends, "enemies": enemies},
    }


def serve(port):
    import json
    import os
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    page = os.path.join(os.path.dirname(os.path.abspath(__file__)), "calculate.html")

    class Handler(BaseHTTPRequestHandler):
        def send(self, code, body, ctype):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path.split("?")[0] not in ("/", "/index.html"):
                return self.send(404, b"not found", "text/plain")
            with open(page, "rb") as f:
                self.send(200, f.read(), "text/html; charset=utf-8")

        def do_POST(self):
            if self.path != "/solve":
                return self.send(404, b"not found", "text/plain")
            try:
                q = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
                out = web_solve(q)
            except Exception as e:  # noqa - report any bad input back to the page
                out = {"error": str(e)}
            self.send(200, json.dumps(out).encode(), "application/json")

        def log_message(self, *args):
            pass

    print("Graphwar calculator: http://localhost:%d  (Ctrl+C to stop)" % port)
    try:
        ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
    except KeyboardInterrupt:
        pass


def main():
    if "--serve" in sys.argv:
        i = sys.argv.index("--serve")
        nxt = sys.argv[i + 1] if i + 1 < len(sys.argv) else ""
        return serve(int(nxt) if nxt.isdigit() else 8000)
    p = argparse.ArgumentParser(description="Find a Graphwar function from your soldier through one or more targets.",
                                formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    p.add_argument("--mode", choices=list(MODES), default="y", help="y (y=), dy (y'=) or d2y (y''=)")
    p.add_argument("--shooter", type=point, help="your soldier, x,y")
    p.add_argument("--target", type=point, action="append", default=[],
                   help="enemy soldier to hit, x,y (repeat for several targets)")
    p.add_argument("--circle", type=circle, action="append", default=[], help="obstacle x,y,r (repeat)")
    p.add_argument("--friend", type=point, action="append", default=[], help="teammate to avoid, x,y (repeat)")
    p.add_argument("--enemy", type=point, action="append", default=[], help="other enemy, only reported, x,y")
    p.add_argument("--margin", type=float, default=0.4, help="distance to keep from obstacles (default 0.4)")
    p.add_argument("--max-slope", type=float, default=8.0, help="steepest allowed segment (default 8)")
    p.add_argument("--max-len", type=int, default=MAX_LEN,
                   help="longest function to write (default %d, 0 = unlimited, for a server run with --unlimited)" % MAX_LEN)
    p.add_argument("--check", metavar="EXPR", help="only simulate this function and report what it hits")
    p.add_argument("--plot", metavar="FILE.png", help="save a picture of the shot (needs matplotlib)")
    # let "--shooter -20,3" work (argparse would read "-20,3" as an option)
    argv, i = [], 0
    raw = sys.argv[1:]
    while i < len(raw):
        if raw[i] in ("--shooter", "--target", "--circle", "--friend", "--enemy", "--check") \
                and i + 1 < len(raw) and raw[i + 1].startswith("-"):
            argv.append(raw[i] + "=" + raw[i + 1])
            i += 2
        else:
            argv.append(raw[i])
            i += 1
    a = p.parse_args(argv)
    a.max_len = UNLIMITED if a.max_len <= 0 else a.max_len

    if a.shooter is None or not a.target:
        interactive(a)

    for name, (x, y) in [("shooter", a.shooter)] + [("target T%d" % (i + 1), t) for i, t in enumerate(a.target)]:
        if not (XMIN <= x <= XMAX and YMIN <= y <= YMAX):
            sys.exit("The %s is off the board (x in -25..25, y in -15..15)." % name)
    if all(t[0] <= a.shooter[0] + 0.3 for t in a.target):
        sys.exit("Shots only travel to the right on your screen, so a target needs a larger x than "
                 "your soldier. Use the coordinates from your own view.")

    if a.check:
        try:
            res = check(a.check, a.mode, a.shooter, a.target, a.circle, a.friend, a.enemy, make_mask(a.circle), a.max_len)
        except ValueError as e:
            sys.exit("The game would reject this function: " + str(e))
        print("\n  %s %s\n" % (MODES[a.mode][0], a.check))
        report(res, a.mode, a)
    else:
        res = solve(a.mode, a.shooter, a.target, a.circle, a.friend, a.enemy, a.margin, a.max_slope, a.max_len)
        if res is None:
            sys.exit("No path found: the obstacles wall off every target (the shot can only move rightwards). "
                     "Try another soldier, or check the circle sizes.")
        if not res["targets_hit"] or res["friendly_fire"]:
            print("\n  Best attempt did NOT pass the check:")
        report(res, a.mode, a)
    if a.plot:
        plot(res, a, a.plot)
    if res["friendly_fire"] or not res["targets_hit"]:
        sys.exit(1)
    sys.exit(0 if res["ok"] else 2)


if __name__ == "__main__":
    main()
