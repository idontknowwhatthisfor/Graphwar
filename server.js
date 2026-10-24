#!/usr/bin/env node
// Graphwar LAN server: serves the browser client and runs rooms over WebSocket.
// No dependencies: `node server.js [port]`.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const GW = require('./public/shared.js');
const { PLANE } = GW;

const PORT = parseInt(process.argv[2] || process.env.PORT || '8080', 10);
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.wav': 'audio/wav', '.svg': 'image/svg+xml',
};

// ---- HTTP ---------------------------------------------------------------------
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const file = path.join(PUBLIC, path.normalize(p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---- Minimal WebSocket (RFC 6455, text frames) ---------------------------------
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') return socket.destroy();
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  const conn = new Conn(socket);
  onConnect(conn);
});

class Conn {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frag = [];
    this.open = true;
    this.onmessage = () => {};
    this.onclose = () => {};
    socket.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.read(); });
    socket.on('close', () => this.closed());
    socket.on('error', () => this.closed());
  }
  read() {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = b[0] & 0x80, op = b[0] & 0x0f, masked = b[1] & 0x80;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (len > 1 << 20) return this.close();
      const maskOff = off;
      if (masked) off += 4;
      if (b.length < off + len) return;
      const payload = Buffer.from(b.subarray(off, off + len));
      if (masked) for (let i = 0; i < len; i++) payload[i] ^= b[maskOff + (i & 3)];
      this.buf = b.subarray(off + len);
      if (op === 8) return this.close();
      if (op === 9) { this.frame(10, payload); continue; }
      if (op === 10) continue;
      this.frag.push(payload);
      if (fin) {
        const msg = Buffer.concat(this.frag).toString('utf8');
        this.frag = [];
        try { this.onmessage(JSON.parse(msg)); } catch (e) { console.error('bad message', e.message); }
      }
    }
  }
  frame(op, payload) {
    if (!this.open) return;
    const n = payload.length;
    let head;
    if (n < 126) head = Buffer.from([0x80 | op, n]);
    else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(n, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
    this.socket.write(Buffer.concat([head, payload]));
  }
  send(obj) { this.frame(1, Buffer.from(JSON.stringify(obj))); }
  close() { if (this.open) { try { this.frame(8, Buffer.alloc(0)); } catch (e) {} this.socket.end(); } this.closed(); }
  closed() { if (!this.open) return; this.open = false; this.onclose(); }
}

// ---- Game state ------------------------------------------------------------------
const players = new Map(); // token -> player
const rooms = new Map();   // id -> room
let nextId = 1;
const id = () => String(nextId++);
const rnd = (a, b) => a + Math.random() * (b - a);
const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);
const TEAM_COLORS = { 1: '#ff6b6b', 2: '#5fb8ff' };
const TURN_TIMES = [30, 60, 120, 180, 300, 0];
const BOT_NAMES = ['Euler', 'Gauss', 'Newton', 'Leibniz', 'Riemann', 'Noether', 'Fourier', 'Cauchy', 'Lagrange', 'Hilbert', 'Turing', 'Lovelace'];

function onConnect(conn) {
  let me = null;
  conn.onmessage = (m) => {
    if (m.t === 'hello') {
      const name = clean(m.name, 20) || 'Player';
      const existing = m.token && players.get(m.token);
      if (existing && !existing.isBot) {
        if (existing.conn && existing.conn !== conn) { existing.conn.onclose = () => {}; existing.conn.close(); }
        me = existing;
        clearTimeout(me.dropTimer);
        me.name = name;
      } else {
        me = { id: id(), token: crypto.randomBytes(12).toString('hex'), name, roomId: null, team: 0, soldierCount: 2 };
        players.set(me.token, me);
      }
      me.conn = conn;
      conn.send({ t: 'welcome', id: me.id, token: me.token });
      const room = me.roomId && rooms.get(me.roomId);
      if (room) { broadcastRoom(room); if (room.game) conn.send(gameSnapshot(room)); }
      else { me.roomId = null; sendRooms(conn); }
      return;
    }
    if (!me) return;
    try { handle(me, m); } catch (e) { console.error(e); conn.send({ t: 'error', msg: 'Server error: ' + e.message }); }
  };
  conn.onclose = () => {
    if (!me || me.conn !== conn) return;
    me.conn = null;
    const room = me.roomId && rooms.get(me.roomId);
    if (room) {
      broadcastRoom(room);
      if (room.game && room.game.turn && room.game.turn.playerId === me.id && !room.options.turnTime) scheduleSkip(room, 5000);
    }
    // keep the seat for a while so phones that sleep/refresh can come back
    me.dropTimer = setTimeout(() => { leaveRoom(me); players.delete(me.token); }, 60000);
  };
}

function handle(me, m) {
  const room = me.roomId && rooms.get(me.roomId);
  const isHost = room && room.hostId === me.id;
  switch (m.t) {
    case 'listRooms': return sendRooms(me.conn);
    case 'createRoom': {
      leaveRoom(me);
      const r = {
        id: id(), name: clean(m.name, 30) || me.name + "'s game", hostId: me.id, players: [],
        options: { mode: 'y', turnTime: 60, soldiers: 2 }, game: null, chat: [],
      };
      rooms.set(r.id, r);
      joinRoom(me, r);
      return broadcastRoomList();
    }
    case 'joinRoom': {
      const r = rooms.get(m.id);
      if (!r) return me.conn.send({ t: 'error', msg: 'That room no longer exists' });
      if (r.players.length >= 12) return me.conn.send({ t: 'error', msg: 'Room is full' });
      leaveRoom(me);
      joinRoom(me, r);
      return broadcastRoomList();
    }
    case 'leaveRoom': leaveRoom(me); sendRooms(me.conn); return broadcastRoomList();
    case 'chat': {
      if (!room) return;
      const text = clean(m.text, 200);
      if (text) pushChat(room, { from: me.name, team: me.team, text });
      return;
    }
    case 'setTeam': {
      if (!room || room.game) return;
      me.team = [0, 1, 2].includes(m.team) ? m.team : 0;
      return broadcastRoom(room);
    }
    case 'setOptions': {
      if (!isHost || room.game) return;
      const o = room.options;
      if (GW.MODES[m.mode]) o.mode = m.mode;
      if (TURN_TIMES.includes(m.turnTime)) o.turnTime = m.turnTime;
      if (m.soldiers >= 1 && m.soldiers <= 4) o.soldiers = m.soldiers | 0;
      if (m.name) room.name = clean(m.name, 30) || room.name;
      broadcastRoom(room);
      return broadcastRoomList();
    }
    case 'addBot': {
      if (!isHost || room.game || room.players.length >= 12) return;
      const used = new Set(room.players.map((p) => p.name));
      const bot = {
        id: id(), token: 'bot' + nextId, isBot: true, name: BOT_NAMES.find((n) => !used.has(n)) || 'Bot',
        roomId: room.id, team: m.team === 2 ? 2 : 1, level: [1, 2, 3].includes(m.level) ? m.level : 2, conn: null,
      };
      room.players.push(bot);
      broadcastRoom(room);
      return broadcastRoomList();
    }
    case 'kick': {
      if (!isHost) return;
      const p = room.players.find((x) => x.id === m.id);
      if (!p || p === me) return;
      if (p.isBot) { room.players = room.players.filter((x) => x !== p); if (room.game) killPlayer(room, p); }
      else { leaveRoom(p); if (p.conn) { p.conn.send({ t: 'error', msg: 'You have been kicked.' }); sendRooms(p.conn); } }
      broadcastRoom(room);
      return broadcastRoomList();
    }
    case 'start': {
      if (!isHost || room.game) return;
      const t1 = room.players.filter((p) => p.team === 1), t2 = room.players.filter((p) => p.team === 2);
      if (!t1.length || !t2.length) return me.conn.send({ t: 'error', msg: 'Both teams need at least one player' });
      startGame(room);
      return broadcastRoomList();
    }
    case 'fire': {
      if (!room || !room.game) return;
      return fire(room, me, String(m.expr || ''));
    }
    case 'endGame': {
      if (!isHost || !room.game) return;
      endGame(room, 0);
      return;
    }
  }
}

function joinRoom(p, r) {
  p.roomId = r.id;
  if (!r.game) {
    const n1 = r.players.filter((x) => x.team === 1).length, n2 = r.players.filter((x) => x.team === 2).length;
    p.team = n1 <= n2 ? 1 : 2;
  } else p.team = 0; // spectate running game
  r.players.push(p);
  broadcastRoom(r);
  pushChat(r, { system: true, text: p.name + ' joined' });
  if (r.game && p.conn) p.conn.send(gameSnapshot(r));
}

function leaveRoom(p) {
  const r = p.roomId && rooms.get(p.roomId);
  p.roomId = null;
  if (!r) return;
  r.players = r.players.filter((x) => x !== p);
  if (r.game) killPlayer(r, p);
  const humans = r.players.filter((x) => !x.isBot);
  if (!humans.length) {
    if (r.game) clearTimeout(r.game.timer);
    rooms.delete(r.id);
    return broadcastRoomList();
  }
  if (r.hostId === p.id) r.hostId = humans[0].id;
  pushChat(r, { system: true, text: p.name + ' left' });
  broadcastRoom(r);
  broadcastRoomList();
}

function pushChat(r, msg) {
  msg.time = Date.now();
  r.chat.push(msg);
  if (r.chat.length > 100) r.chat.shift();
  roomSend(r, { t: 'chat', msg });
}

function roomSend(r, obj) {
  const data = JSON.stringify(obj);
  for (const p of r.players) if (p.conn && p.conn.open) p.conn.frame(1, Buffer.from(data));
}

function roomInfo(r) {
  return {
    id: r.id, name: r.name, hostId: r.hostId, options: r.options, playing: !!r.game,
    players: r.players.map((p) => ({ id: p.id, name: p.name, team: p.team, isBot: !!p.isBot, level: p.level, online: p.isBot || !!p.conn })),
    chat: r.chat.slice(-40),
  };
}
function broadcastRoom(r) { roomSend(r, { t: 'room', room: roomInfo(r) }); }

function roomList() {
  return [...rooms.values()].map((r) => ({
    id: r.id, name: r.name, players: r.players.filter((p) => !p.isBot).length, bots: r.players.filter((p) => p.isBot).length,
    playing: !!r.game, mode: r.options.mode,
  }));
}
function sendRooms(conn) { if (conn) conn.send({ t: 'rooms', rooms: roomList() }); }
function broadcastRoomList() {
  const list = roomList();
  for (const p of players.values()) if (!p.roomId && p.conn) p.conn.send({ t: 'rooms', rooms: list });
}

// ---- Gameplay ------------------------------------------------------------------------
function startGame(r) {
  const mask = GW.newMask();
  const obstacles = [];
  const nObs = Math.floor(rnd(10, 22));
  for (let i = 0; i < nObs; i++) {
    const o = { x: rnd(-22, 22), y: rnd(-13, 13), r: Math.pow(Math.random(), 1.6) * 4 + 1 };
    obstacles.push(o);
    GW.paintCircle(mask, o.x, o.y, o.r, 1);
  }
  const soldiers = [];
  for (const p of r.players) {
    if (p.team !== 1 && p.team !== 2) continue;
    for (let k = 0; k < r.options.soldiers; k++) {
      let pos = null;
      for (let tries = 0; tries < 2000 && !pos; tries++) {
        const sx = (p.team === 1 ? -1 : 1) * rnd(3, 24), sy = rnd(-14, 14);
        const clearance = tries < 1500 ? 1.2 : PLANE.SOLDIER_R + 0.1;
        if (!GW.circleFree(mask, sx, sy, clearance)) continue;
        if (soldiers.some((s) => Math.hypot(s.x - sx, s.y - sy) < 2)) continue;
        pos = { x: sx, y: sy };
      }
      if (!pos) { // carve a spot if the map is crowded
        pos = { x: (p.team === 1 ? -1 : 1) * rnd(3, 24), y: rnd(-14, 14) };
        GW.paintCircle(mask, pos.x, pos.y, 1.2, 0);
      }
      soldiers.push({ id: id(), playerId: p.id, team: p.team, x: +pos.x.toFixed(3), y: +pos.y.toFixed(3), alive: true });
    }
  }
  r.game = {
    obstacles, explosions: [], mask, soldiers, shots: [], turn: null, timer: null, busy: false,
    order: { 1: 0, 2: 0 }, nextTeam: Math.random() < 0.5 ? 1 : 2, soldierIdx: {}, turnNo: 0,
  };
  roomSend(r, gameSnapshot(r));
  broadcastRoom(r);
  r.game.timer = setTimeout(() => nextTurn(r), 1500);
}

function gameSnapshot(r) {
  const g = r.game;
  return {
    t: 'game', mode: r.options.mode, turnTime: r.options.turnTime,
    obstacles: g.obstacles, explosions: g.explosions,
    soldiers: g.soldiers.map(({ id, playerId, team, x, y, alive }) => ({ id, playerId, team, x, y, alive })),
    shots: g.shots.slice(-12), turn: g.turn, serverNow: Date.now(),
  };
}

function aliveTeams(g) {
  return new Set(g.soldiers.filter((s) => s.alive).map((s) => s.team));
}

function nextTurn(r) {
  const g = r.game;
  if (!g) return;
  clearTimeout(g.timer);
  const alive = aliveTeams(g);
  if (alive.size < 2) return endGame(r, alive.size === 1 ? [...alive][0] : 0);

  // alternate teams; within a team rotate players, within a player rotate soldiers
  let team = g.nextTeam;
  if (!alive.has(team)) team = team === 1 ? 2 : 1;
  g.nextTeam = team === 1 ? 2 : 1;
  const teamPlayers = r.players.filter((p) => p.team === team && g.soldiers.some((s) => s.alive && s.playerId === p.id));
  const player = teamPlayers[g.order[team]++ % teamPlayers.length];
  const mine = g.soldiers.filter((s) => s.alive && s.playerId === player.id);
  const idx = (g.soldierIdx[player.id] || 0) % mine.length;
  g.soldierIdx[player.id] = idx + 1;
  const soldier = mine[idx];

  g.turnNo++;
  g.turn = { no: g.turnNo, playerId: player.id, soldierId: soldier.id, team, endsAt: r.options.turnTime ? Date.now() + r.options.turnTime * 1000 : 0 };
  g.busy = false;
  roomSend(r, { t: 'turn', turn: g.turn, serverNow: Date.now() });
  if (player.isBot) {
    g.timer = setTimeout(() => botPlay(r, player), 1200 + Math.random() * 1500);
  } else if (!player.conn && !r.options.turnTime) {
    scheduleSkip(r, 5000);
  } else if (r.options.turnTime) {
    g.timer = setTimeout(() => {
      pushChat(r, { system: true, text: player.name + ' ran out of time' });
      nextTurn(r);
    }, r.options.turnTime * 1000 + 500);
  }
}

function scheduleSkip(r, ms) {
  const g = r.game;
  clearTimeout(g.timer);
  const turnNo = g.turn.no;
  g.timer = setTimeout(() => { if (r.game === g && g.turn.no === turnNo && !g.busy) nextTurn(r); }, ms);
}

function fire(r, p, expr) {
  const g = r.game;
  if (!g.turn || g.busy || g.turn.playerId !== p.id) return;
  let fn;
  try { fn = GW.compileFunction(expr, r.options.mode); }
  catch (e) { return p.conn && p.conn.send({ t: 'fireError', msg: e.message }); }
  g.busy = true;
  clearTimeout(g.timer);
  const shooter = g.soldiers.find((s) => s.id === g.turn.soldierId);
  const res = GW.simulateShot({ fn, mode: r.options.mode, shooter, team: g.turn.team, soldiers: g.soldiers, mask: g.mask });
  for (const h of res.hits) g.soldiers.find((s) => s.id === h.id).alive = false;
  if (res.explosion) {
    GW.paintCircle(g.mask, res.explosion.x, res.explosion.y, PLANE.EXPLOSION_R, 0);
    g.explosions.push({ x: +res.explosion.x.toFixed(3), y: +res.explosion.y.toFixed(3), r: PLANE.EXPLOSION_R });
  }
  const points = res.points.map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]);
  let len = 0;
  for (let i = 1; i < points.length; i++) len += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  const duration = Math.min(6000, Math.max(1200, len * 70));
  const shot = { expr, mode: r.options.mode, playerId: p.id, soldierId: shooter.id, team: g.turn.team, points, hits: res.hits, explosion: res.explosion, duration };
  g.shots.push(shot);
  if (g.shots.length > 30) g.shots.shift();
  roomSend(r, { t: 'shot', shot });
  if (res.hits.length) {
    const names = res.hits.map((h) => {
      const s = g.soldiers.find((x) => x.id === h.id);
      const owner = r.players.find((x) => x.id === s.playerId);
      return (owner ? owner.name : '?') + (s.team === shooter.team ? ' (friendly fire!)' : '');
    });
    setTimeout(() => pushChat(r, { system: true, text: p.name + ' hit ' + names.join(', ') }), duration);
  }
  g.timer = setTimeout(() => nextTurn(r), duration + 1300);
}

function killPlayer(r, p) {
  const g = r.game;
  if (!g) return;
  const killed = g.soldiers.filter((s) => s.playerId === p.id && s.alive);
  killed.forEach((s) => { s.alive = false; });
  if (killed.length) roomSend(r, { t: 'removed', ids: killed.map((s) => s.id) });
  if (g.turn && g.turn.playerId === p.id && !g.busy) nextTurn(r);
  else if (aliveTeams(g).size < 2 && !g.busy) nextTurn(r);
}

function endGame(r, winner) {
  if (!r.game) return;
  clearTimeout(r.game.timer);
  r.game = null;
  roomSend(r, { t: 'gameOver', winner });
  broadcastRoom(r);
  broadcastRoomList();
}

// ---- Bots -----------------------------------------------------------------------------
// Bots sample parametric function families, simulate each candidate against the real
// map and pick the best scoring one. Higher levels try more candidates and aim better.
function botPlay(r, bot) {
  const g = r.game;
  if (!g || !g.turn || g.turn.playerId !== bot.id) return;
  const mode = r.options.mode;
  const shooter = g.soldiers.find((s) => s.id === g.turn.soldierId);
  const team = g.turn.team, sgn = team === 2 ? -1 : 1;
  const X0 = sgn * shooter.x, Y0 = shooter.y;
  const enemies = g.soldiers.filter((s) => s.alive && s.team !== team);
  const tries = [0, 60, 250, 700][bot.level];
  const f2 = (v) => (Math.round(v * 100) / 100).toString();
  const sig = (v) => (v < 0 ? ' - ' + f2(-v) : ' + ' + f2(v));

  function candidate() {
    const tgt = enemies[Math.floor(Math.random() * enemies.length)];
    const TX = sgn * tgt.x + rnd(-0.3, 0.3), TY = tgt.y + rnd(-0.3, 0.3);
    const dx = Math.max(0.5, TX - X0), m = (TY - Y0) / dx;
    const c = X0 + rnd(0.2, 0.9) * dx, k = rnd(1.5, 8), h = TY - Y0;
    const kind = Math.random();
    if (mode === 'y') {
      if (kind < 0.3) return f2(m) + '*x';
      if (kind < 0.75) return f2(h) + '/(1+exp(' + f2(-k) + '*(x' + sig(-c) + ')))'; // step over obstacles
      const a = rnd(-4, 4), b = rnd(0.2, 1.5);
      return f2(m) + '*x' + sig(a) + '*sin(' + f2(b) + '*x)';
    }
    if (mode === 'dy') {
      if (kind < 0.3) return f2(m);
      if (kind < 0.75) return f2(h * k) + '*exp(' + f2(-k) + '*(x' + sig(-c) + '))/(1+exp(' + f2(-k) + '*(x' + sig(-c) + ')))^2';
      const a = rnd(-1.5, 1.5);
      return f2(m - a * (X0 + dx / 2)) + sig(a) + '*x';
    }
    // y'' (y'(X0) = 0): a constant gives a parabola through the target
    if (kind < 0.5) return f2(2 * (TY - Y0) / (dx * dx));
    const a = 2 * (TY - Y0) / (dx * dx);
    const b = rnd(-0.3, 0.3);
    return f2(a - b * (X0 + dx / 2)) + sig(b) + '*x';
  }

  let best = null, bestScore = -Infinity;
  for (let i = 0; i < tries; i++) {
    const expr = candidate();
    let fn;
    try { fn = GW.compileFunction(expr, mode); } catch (e) { continue; }
    const res = GW.simulateShot({ fn, mode, shooter, team, soldiers: g.soldiers, mask: g.mask });
    let score = Math.random() * 0.5;
    for (const h of res.hits) score += g.soldiers.find((s) => s.id === h.id).team === team ? -15 : 10;
    if (!res.hits.length && res.points.length) {
      // reward getting close to an enemy
      let d = Infinity;
      for (const pt of res.points) for (const e of enemies) d = Math.min(d, Math.hypot(pt[0] - e.x, pt[1] - e.y));
      score -= d;
    }
    if (score > bestScore) { bestScore = score; best = expr; }
  }
  if (!best) best = mode === 'y' ? '0' : '0';
  fire(r, bot, best);
}

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log('Graphwar LAN server running. Open on any device on your network:');
  for (const ip of ips) console.log('  http://' + ip + ':' + PORT);
  console.log('  http://localhost:' + PORT + ' (this machine)');
});
