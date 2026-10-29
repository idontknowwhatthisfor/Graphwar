'use strict';
(function () {
  const { PLANE, MODES } = GW;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const TEAM_COLOR = { 0: '#c8d2e6', 1: '#ff6b81', 2: '#4fc3f7' };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  };
  // per-tab seat token: survives refresh/sleep, but a second tab is a second player
  const seat = {
    get() { try { return sessionStorage.getItem('gw-token'); } catch (e) { return null; } },
    set(v) { try { sessionStorage.setItem('gw-token', v); } catch (e) {} },
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const S = {
    ws: null, myId: null, token: seat.get(), rooms: [], room: null, game: null,
    botLevel: 2, showNames: store.get('gw-names') !== '0', muted: store.get('gw-muted') === '1',
    clockOffset: 0, unread: false,
  };

  // ---- Connection ---------------------------------------------------------------
  let retry = 0;
  function connect() {
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    S.ws = ws;
    ws.onopen = () => {
      retry = 0;
      $('#conn-banner').classList.add('hidden');
      send({ t: 'hello', name: myName(), token: S.token });
    };
    ws.onmessage = (e) => onMessage(JSON.parse(e.data));
    ws.onclose = () => {
      $('#conn-banner').textContent = 'Disconnected — reconnecting…';
      $('#conn-banner').classList.remove('hidden');
      setTimeout(connect, Math.min(5000, 500 * ++retry));
    };
  }
  function send(m) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(m)); }
  function myName() { return ($('#name-input').value || store.get('gw-name') || '').trim() || 'Player'; }

  function onMessage(m) {
    switch (m.t) {
      case 'welcome':
        S.myId = m.id; S.token = m.token; seat.set(m.token);
        GW.setMaxLen(m.maxLen ?? 300);
        if (GW.getMaxLen()) $('#fn-input').maxLength = GW.getMaxLen(); else $('#fn-input').removeAttribute('maxlength');
        break;
      case 'rooms':
        S.rooms = m.rooms; S.room = null; S.game = null;
        renderRooms(); show('home');
        break;
      case 'room': {
        const wasPlaying = S.room && S.room.playing;
        S.room = m.room;
        renderRoom();
        if (!m.room.playing && !S.game) show('room');
        if (wasPlaying && !m.room.playing && !S.gameOver) { S.game = null; show('room'); }
        break;
      }
      case 'chat':
        if (S.room) { S.room.chat.push(m.msg); renderChat(); }
        if (S.game && $('#game-chat').classList.contains('collapsed') && !m.msg.system) { S.unread = true; $('#chat-dot').classList.remove('hidden'); }
        break;
      case 'game': startGame(m); break;
      case 'turn': onTurn(m.turn, m.serverNow); break;
      case 'shot': onShot(m.shot); break;
      case 'removed':
        if (S.game) for (const id of m.ids) { const s = soldierById(id); if (s) s.alive = false; }
        break;
      case 'fireError':
        $('#fn-error').textContent = m.msg;
        $('#fire-btn').disabled = false;
        break;
      case 'gameOver': onGameOver(m.winner); break;
      case 'error': toast(m.msg); break;
    }
  }

  function show(name) {
    for (const s of ['home', 'room', 'game']) $('#screen-' + s).classList.toggle('hidden', s !== name);
    S.screen = name;
    if (name === 'game') resizeBoard();
  }
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
  }

  // ---- Home ---------------------------------------------------------------------------
  $('#name-input').value = store.get('gw-name') || '';
  $('#name-input').addEventListener('change', () => { store.set('gw-name', myName()); send({ t: 'hello', name: myName(), token: S.token }); });
  $('#create-btn').onclick = () => { store.set('gw-name', myName()); send({ t: 'createRoom', name: myName() + "'s game" }); };
  $('#refresh-btn').onclick = () => send({ t: 'listRooms' });

  function renderRooms() {
    const ul = $('#room-list');
    if (!S.rooms.length) { ul.innerHTML = '<li class="empty">No games yet — create one!</li>'; return; }
    ul.innerHTML = S.rooms.map((r) => `<li>
      <span class="rname">${esc(r.name)}</span>
      <span class="rmeta">${MODES[r.mode].label.replace(' =', '')} · ${r.players} player${r.players === 1 ? '' : 's'}${r.bots ? ' + ' + r.bots + ' bot' + (r.bots > 1 ? 's' : '') : ''}${r.playing ? ' · playing' : ''}</span>
      <button class="btn small" data-join="${r.id}">${r.playing ? 'Watch' : 'Join'}</button></li>`).join('');
    $$('[data-join]', ul).forEach((b) => (b.onclick = () => { store.set('gw-name', myName()); send({ t: 'hello', name: myName(), token: S.token }); send({ t: 'joinRoom', id: b.dataset.join }); }));
  }

  // ---- Room -----------------------------------------------------------------------------
  const isHost = () => S.room && S.room.hostId === S.myId;
  const me = () => S.room && S.room.players.find((p) => p.id === S.myId);

  function renderRoom() {
    const r = S.room;
    document.body.classList.toggle('is-host', isHost());
    const rn = $('#room-name');
    if (document.activeElement !== rn) rn.value = r.name;
    rn.disabled = !isHost();
    const host = r.players.find((p) => p.id === r.hostId);
    $('#room-host-badge').textContent = isHost() ? 'you are host' : host ? 'host: ' + host.name : '';
    setSeg('#opt-mode', r.options.mode);
    setSeg('#opt-time', String(r.options.turnTime));
    setSeg('#opt-soldiers', String(r.options.soldiers));
    $$('.options .seg').forEach((s) => s.classList.toggle('locked', !isHost()));
    for (const team of [0, 1, 2]) {
      const box = $(`.team[data-team="${team}"]`);
      const list = r.players.filter((p) => p.team === team);
      $('.plist', box).innerHTML = list.map((p) => `<li class="${p.id === S.myId ? 'me' : ''} ${p.online ? '' : 'offline'}">
        <span class="pn">${esc(p.name)}</span>
        ${p.isBot ? `<span class="tag">bot · ${['', 'easy', 'normal', 'hard'][p.level]}</span>` : ''}
        ${p.id === r.hostId ? '<span class="tag">host</span>' : ''}
        ${!p.online ? '<span class="tag">offline</span>' : ''}
        ${isHost() && p.id !== S.myId ? `<button class="kick" data-kick="${p.id}" title="Remove">×</button>` : ''}
      </li>`).join('');
      $('.join-team', box).classList.toggle('hidden', me() && me().team === team);
    }
    $$('[data-kick]').forEach((b) => (b.onclick = () => send({ t: 'kick', id: b.dataset.kick })));
    const n1 = r.players.filter((p) => p.team === 1).length, n2 = r.players.filter((p) => p.team === 2).length;
    $('#start-btn').classList.toggle('hidden', !isHost());
    $('#start-btn').disabled = !n1 || !n2;
    $('#opt-note').textContent = r.playing ? 'A game is in progress.' : !n1 || !n2 ? 'Each team needs at least one player or bot.'
      : isHost() ? '' : 'Waiting for the host to start…';
    renderChat();
  }
  function setSeg(sel, v) { $$(sel + ' button').forEach((b) => b.classList.toggle('on', b.dataset.v === v)); }

  $('#opt-mode').onclick = (e) => { if (e.target.dataset.v && isHost()) send({ t: 'setOptions', mode: e.target.dataset.v }); };
  $('#opt-time').onclick = (e) => { if (e.target.dataset.v && isHost()) send({ t: 'setOptions', turnTime: +e.target.dataset.v }); };
  $('#opt-soldiers').onclick = (e) => { if (e.target.dataset.v && isHost()) send({ t: 'setOptions', soldiers: +e.target.dataset.v }); };
  $('#bot-level').onclick = (e) => { if (e.target.dataset.v) { S.botLevel = +e.target.dataset.v; setSeg('#bot-level', e.target.dataset.v); } };
  $('#room-name').addEventListener('change', (e) => send({ t: 'setOptions', name: e.target.value }));
  $$('.join-team').forEach((b) => (b.onclick = () => send({ t: 'setTeam', team: +b.dataset.team })));
  $$('.add-bot').forEach((b) => (b.onclick = () => send({ t: 'addBot', team: +b.dataset.team, level: S.botLevel })));
  $('#start-btn').onclick = () => send({ t: 'start' });
  $('#leave-room-btn').onclick = () => send({ t: 'leaveRoom' });

  function renderChat() {
    const html = S.room.chat.slice(-60).map((c) => c.system
      ? `<div class="sys">${esc(c.text)}</div>`
      : `<div><b style="color:${TEAM_COLOR[c.team] || TEAM_COLOR[0]}">${esc(c.from)}:</b> ${esc(c.text)}</div>`).join('');
    for (const log of [$('#room-chat'), $('#game-chat-log')]) {
      const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
      log.innerHTML = html;
      if (atBottom) log.scrollTop = log.scrollHeight;
    }
  }
  $$('[data-chat]').forEach((f) => (f.onsubmit = (e) => {
    e.preventDefault();
    const i = $('input', f);
    if (i.value.trim()) send({ t: 'chat', text: i.value });
    i.value = '';
  }));

  // ---- Game -----------------------------------------------------------------------------
  const canvas = $('#board'), ctx = canvas.getContext('2d');
  const obsLayer = document.createElement('canvas'), obsCtx = obsLayer.getContext('2d');
  let W = 770, H = 450, dpr = 1;

  function myTeam() { const p = me(); return p ? p.team : 0; }
  function viewSign() { return myTeam() === 2 ? -1 : 1; }
  const toCx = (x) => ((viewSign() * x - PLANE.XMIN) / (PLANE.XMAX - PLANE.XMIN)) * W;
  const toCy = (y) => ((PLANE.YMAX - y) / (PLANE.YMAX - PLANE.YMIN)) * H;
  const unit = () => W / (PLANE.XMAX - PLANE.XMIN);
  function soldierById(id) { return S.game && S.game.soldiers.find((s) => s.id === id); }
  function playerById(id) { return S.room && S.room.players.find((p) => p.id === id); }

  // Console helper: type circles() in the browser console to list every obstacle in
  // YOUR view (same coordinates as the hover readout), ready for calculate.py.
  // r is rounded up so the circle is never under-sized.
  window.circles = function () {
    if (!S.game) { console.log('No game running.'); return; }
    const list = S.game.obstacles
      .map((o) => ({ x: +(viewSign() * o.x).toFixed(2), y: +o.y.toFixed(2), r: Math.ceil(o.r * 100) / 100 }))
      .sort((a, b) => a.x - b.x);
    console.table(list);
    console.log(list.map((c) => `--circle ${c.x},${c.y},${c.r}`).join(' '));
  };

  // Console helper: type targets() to list every living enemy soldier in YOUR view,
  // ready for calculate.py (--target x,y ...).
  window.targets = function () {
    if (!S.game) { console.log('No game running.'); return; }
    const team = myTeam();
    if (!team) { console.log('You are spectating - join a team to have enemies.'); return; }
    const list = S.game.soldiers
      .filter((s) => s.alive && s.team !== team)
      .map((s) => {
        const p = playerById(s.playerId);
        return { player: p ? p.name : '?', x: +(viewSign() * s.x).toFixed(2), y: +s.y.toFixed(2) };
      })
      .sort((a, b) => a.x - b.x);
    if (!list.length) { console.log('No enemies left.'); return; }
    console.table(list);
    console.log(list.map((t) => `--target ${t.x},${t.y}`).join(' '));
  };

  function startGame(m) {
    S.gameOver = false;
    S.game = {
      mode: m.mode, obstacles: m.obstacles, explosions: m.explosions.slice(), soldiers: m.soldiers,
      shots: m.shots.map((s) => ({ ...s, start: 0, done: true })), turn: null, fx: [],
    };
    $('#gameover').classList.add('hidden');
    $('#fn-prefix').textContent = MODES[m.mode].label;
    $('#fn-input').value = '';
    $('#fn-error').textContent = '';
    buildKeypad(m.mode);
    show('game');
    renderObstacles();
    if (m.turn) onTurn(m.turn, m.serverNow);
    else setTurnUI();
  }

  function onTurn(turn, serverNow) {
    if (!S.game) return;
    S.clockOffset = serverNow - Date.now();
    S.game.turn = turn;
    setTurnUI();
    if (turn.playerId === S.myId) {
      $('#fn-input').focus({ preventScroll: true });
      flashMsg('Your turn!');
    }
  }

  function setTurnUI() {
    const g = S.game, t = g.turn;
    const label = $('#turn-label');
    const mine = t && t.playerId === S.myId;
    if (!t) label.innerHTML = 'Get ready…';
    else {
      const p = playerById(t.playerId);
      label.innerHTML = mine ? '<span style="color:var(--accent)">Your turn</span>'
        : `<span style="color:${TEAM_COLOR[t.team]}">${esc(p ? p.name : '?')}</span> is aiming…`;
    }
    $('#fire-btn').disabled = !mine || g.busy;
    $('#fn-input').placeholder = mine ? 'type a function, e.g. 0.5x' : myTeam() ? 'wait for your turn…' : 'spectating';
  }

  $('#fire-form').onsubmit = (e) => {
    e.preventDefault();
    const t = S.game.turn;
    if (!t || t.playerId !== S.myId || S.game.busy) { $('#fn-error').textContent = 'Wait for your turn'; return; }
    const expr = $('#fn-input').value;
    try { GW.compileFunction(expr, S.game.mode); }
    catch (err) { $('#fn-error').textContent = err.message; return; }
    $('#fn-error').textContent = '';
    $('#fire-btn').disabled = true;
    send({ t: 'fire', expr });
  };
  $('#fn-input').addEventListener('input', () => {
    const v = $('#fn-input').value;
    if (!v.trim()) { $('#fn-error').textContent = ''; return; }
    try { GW.compileFunction(v, S.game.mode); $('#fn-error').textContent = ''; }
    catch (err) { $('#fn-error').textContent = err.message; }
  });

  function buildKeypad(mode) {
    const keys = ['x', ...(mode !== 'y' ? ['y'] : []), ...(mode === 'd2y' ? ["y'"] : []),
      '(', ')', '^', '+', '-', '*', '/', 'sin(', 'cos(', 'tan(', 'sqrt(', 'exp(', 'ln(', 'abs(', 'pi', '⌫'];
    const kp = $('#keypad');
    kp.innerHTML = keys.map((k) => `<button type="button" data-k="${esc(k)}">${esc(k)}</button>`).join('');
    $$('button', kp).forEach((b) => b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const inp = $('#fn-input'), k = b.dataset.k;
      const a = inp.selectionStart ?? inp.value.length, z = inp.selectionEnd ?? a;
      if (k === '⌫') {
        const from = a === z ? Math.max(0, a - 1) : a;
        inp.value = inp.value.slice(0, from) + inp.value.slice(z);
        inp.setSelectionRange(from, from);
      } else {
        inp.value = inp.value.slice(0, a) + k + inp.value.slice(z);
        inp.setSelectionRange(a + k.length, a + k.length);
      }
      inp.dispatchEvent(new Event('input'));
    }));
  }

  function onShot(shot) {
    const g = S.game;
    if (!g) return;
    g.busy = true;
    shot.start = performance.now();
    shot.firedHits = 0;
    shot.exploded = false;
    g.shots.push(shot);
    if (g.shots.length > 12) g.shots.shift();
    $('#fire-btn').disabled = true;
    if (shot.playerId === S.myId) $('#fn-input').value = '';
    playHumm(shot.duration);
  }

  function onGameOver(winner) {
    S.gameOver = true;
    const t = myTeam();
    $('#gameover-title').textContent = !winner ? 'Game ended' : !t ? `Team ${winner} wins!` : winner === t ? 'Victory!' : 'Defeat';
    setTimeout(() => $('#gameover').classList.remove('hidden'), 1500);
  }
  $('#gameover-btn').onclick = () => { S.game = null; S.gameOver = false; $('#gameover').classList.add('hidden'); show('room'); renderRoom(); };
  $('#game-leave-btn').onclick = () => {
    if (isHost() && S.room.playing) {
      if (confirm('End the game for everyone?')) send({ t: 'endGame' });
    } else if (confirm('Leave this game?')) send({ t: 'leaveRoom' });
  };
  $('#toggle-names').onclick = () => { S.showNames = !S.showNames; store.set('gw-names', S.showNames ? '1' : '0'); };
  $('#mute-btn').onclick = () => { S.muted = !S.muted; store.set('gw-muted', S.muted ? '1' : '0'); updateMute(); };
  function updateMute() { $('#mute-btn').style.opacity = S.muted ? 0.4 : 1; }
  updateMute();
  $('#chat-toggle').onclick = () => {
    const c = $('#game-chat');
    c.classList.toggle('collapsed');
    S.unread = false; $('#chat-dot').classList.add('hidden');
    resizeBoard();
  };
  if (innerWidth <= 760) $('#game-chat').classList.add('collapsed');

  let msgTimer;
  function flashMsg(text) {
    const m = $('#board-msg');
    m.textContent = text; m.classList.remove('hidden');
    clearTimeout(msgTimer); msgTimer = setTimeout(() => m.classList.add('hidden'), 1400);
  }

  // ---- Rendering --------------------------------------------------------------------------
  function resizeBoard() {
    const box = $('#board-box');
    const bw = box.clientWidth, bh = box.clientHeight;
    if (!bw || !bh) return;
    const ratio = (PLANE.XMAX - PLANE.XMIN) / (PLANE.YMAX - PLANE.YMIN);
    W = Math.floor(Math.min(bw, bh * ratio)); H = Math.floor(W / ratio);
    dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    canvas.width = W * dpr; canvas.height = H * dpr;
    obsLayer.width = W * dpr; obsLayer.height = H * dpr;
    renderObstacles();
  }
  window.addEventListener('resize', resizeBoard);
  new ResizeObserver(resizeBoard).observe($('#board-box'));

  function renderObstacles() {
    const g = S.game;
    if (!g) return;
    obsCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    obsCtx.clearRect(0, 0, W, H);
    obsCtx.globalCompositeOperation = 'source-over';
    const u = unit();
    for (const o of g.obstacles) {
      const grd = obsCtx.createRadialGradient(toCx(o.x) - o.r * u * 0.3, toCy(o.y) - o.r * u * 0.3, 0, toCx(o.x), toCy(o.y), o.r * u);
      grd.addColorStop(0, '#4a5263');
      grd.addColorStop(1, '#343a47');
      obsCtx.fillStyle = grd;
      obsCtx.beginPath(); obsCtx.arc(toCx(o.x), toCy(o.y), o.r * u, 0, Math.PI * 2); obsCtx.fill();
    }
    obsCtx.globalCompositeOperation = 'destination-out';
    for (const e of g.explosions) { obsCtx.beginPath(); obsCtx.arc(toCx(e.x), toCy(e.y), e.r * u, 0, Math.PI * 2); obsCtx.fill(); }
    obsCtx.globalCompositeOperation = 'source-over';
    // centre dot + radius label (helps reading circles for calculate.py)
    obsCtx.font = `${Math.max(9, u * 0.55)}px ui-monospace, Menlo, monospace`;
    obsCtx.textAlign = 'center'; obsCtx.textBaseline = 'top';
    for (const o of g.obstacles) {
      const cx = toCx(o.x), cy = toCy(o.y);
      obsCtx.fillStyle = 'rgba(220,228,240,.85)';
      obsCtx.beginPath(); obsCtx.arc(cx, cy, Math.max(1.5, u * 0.09), 0, Math.PI * 2); obsCtx.fill();
      obsCtx.fillStyle = 'rgba(220,228,240,.6)';
      obsCtx.fillText('r=' + o.r.toFixed(2), cx, cy + Math.max(3, u * 0.2));
    }
  }


  function drawGrid() {
    ctx.fillStyle = '#12151c';
    ctx.fillRect(0, 0, W, H);
    ctx.lineWidth = 1;
    for (let x = PLANE.XMIN; x <= PLANE.XMAX; x++) {
      ctx.strokeStyle = x === 0 ? 'rgba(200,210,230,.5)' : x % 5 === 0 ? 'rgba(200,210,230,.13)' : 'rgba(200,210,230,.04)';
      const cx = Math.round(toCx(x)) + 0.5;
      ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, H); ctx.stroke();
    }
    for (let y = PLANE.YMIN; y <= PLANE.YMAX; y++) {
      ctx.strokeStyle = y === 0 ? 'rgba(200,210,230,.5)' : y % 5 === 0 ? 'rgba(200,210,230,.13)' : 'rgba(200,210,230,.04)';
      const cy = Math.round(toCy(y)) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(W, cy); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(200,210,230,.4)';
    ctx.font = `${Math.max(9, W / 70)}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let v = -20; v <= 20; v += 5) if (v) ctx.fillText(String(v), (v - PLANE.XMIN) / 50 * W, toCy(0) + 3);
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (let v = -10; v <= 10; v += 5) if (v) ctx.fillText(String(v), W / 2 + 4, toCy(v));
  }

  function shotProgress(shot, now) {
    if (shot.done) return 1;
    return Math.min(1, (now - shot.start) / shot.duration);
  }

  function drawShot(shot, now, alpha) {
    const pts = shot.points, n = pts.length;
    const prog = shotProgress(shot, now);
    const upto = Math.max(1, Math.floor(prog * (n - 1)));
    ctx.strokeStyle = TEAM_COLOR[shot.team];
    ctx.globalAlpha = alpha;
    ctx.lineWidth = Math.max(1.5, unit() * 0.14);
    ctx.lineJoin = ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(toCx(pts[0][0]), toCy(pts[0][1]));
    for (let i = 1; i <= upto && i < n; i++) ctx.lineTo(toCx(pts[i][0]), toCy(pts[i][1]));
    ctx.stroke();
    ctx.globalAlpha = 1;
    if (!shot.done) {
      const head = pts[Math.min(upto, n - 1)];
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(toCx(head[0]), toCy(head[1]), Math.max(2.5, unit() * 0.2), 0, Math.PI * 2); ctx.fill();
      // trigger events as the head passes them
      for (const h of shot.hits) {
        if (!h.fired && upto >= h.i) {
          h.fired = true;
          const s = soldierById(h.id);
          if (s) { s.alive = false; S.game.fx.push({ kind: 'death', x: s.x, y: s.y, t: now, color: TEAM_COLOR[s.team] }); playBoom(0.5); }
        }
      }
      if (prog >= 1) {
        shot.done = true;
        if (shot.explosion) {
          S.game.explosions.push({ x: shot.explosion.x, y: shot.explosion.y, r: PLANE.EXPLOSION_R });
          S.game.fx.push({ kind: 'boom', x: shot.explosion.x, y: shot.explosion.y, t: now });
          renderObstacles();
          playBoom(1);
        }
        S.game.busy = false;
        setTurnUI();
      }
    }
  }

  function drawSoldiers(now) {
    const g = S.game, u = unit(), r = PLANE.SOLDIER_R * u;
    const t = g.turn;
    for (const s of g.soldiers) {
      const cx = toCx(s.x), cy = toCy(s.y);
      const facing = (s.team === 2 ? -1 : 1) * viewSign();
      if (!s.alive) {
        ctx.strokeStyle = 'rgba(200,210,230,.35)'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(cx - r * .7, cy - r * .7); ctx.lineTo(cx + r * .7, cy + r * .7);
        ctx.moveTo(cx + r * .7, cy - r * .7); ctx.lineTo(cx - r * .7, cy + r * .7); ctx.stroke();
        continue;
      }
      const active = t && t.soldierId === s.id && !g.busy;
      if (active) {
        const pulse = 1.6 + Math.sin(now / 180) * 0.35;
        ctx.strokeStyle = TEAM_COLOR[s.team]; ctx.globalAlpha = 0.7; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx, cy, r * pulse + 3, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 1;
      }
      // plain disc with a dot showing which way the soldier fires
      ctx.fillStyle = TEAM_COLOR[s.team];
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#0d0f14';
      ctx.beginPath(); ctx.arc(cx + facing * r * 0.4, cy - r * 0.15, Math.max(1, r * 0.22), 0, Math.PI * 2); ctx.fill();
      if (S.showNames || active) {
        const p = playerById(s.playerId);
        if (p) {
          ctx.font = `${Math.max(11, u * 0.75)}px system-ui, sans-serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'top';
          ctx.fillStyle = s.playerId === S.myId ? '#8ab4ff' : 'rgba(200,210,230,.85)';
          ctx.fillText(p.name, cx, cy + r + 2);
        }
      }
    }
  }

  function drawFx(now) {
    const g = S.game, u = unit();
    g.fx = g.fx.filter((f) => now - f.t < 700);
    for (const f of g.fx) {
      const k = (now - f.t) / 700;
      ctx.globalAlpha = 1 - k;
      if (f.kind === 'boom') {
        ctx.fillStyle = '#ffb454';
        ctx.beginPath(); ctx.arc(toCx(f.x), toCy(f.y), PLANE.EXPLOSION_R * u * (0.5 + k * 1.2), 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.strokeStyle = f.color; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(toCx(f.x), toCy(f.y), PLANE.SOLDIER_R * u * (1 + k * 3), 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (S.screen !== 'game' || !S.game) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawGrid();
    ctx.drawImage(obsLayer, 0, 0, W, H);
    const shots = S.game.shots;
    shots.forEach((s, i) => { if (s.done && i < shots.length - 1) drawShot(s, now, 0.12 + 0.25 * (i / shots.length)); });
    const last = shots[shots.length - 1];
    if (last) drawShot(last, now, last.done ? 0.55 : 1);
    drawSoldiers(now);
    drawFx(now);
    // timer
    const t = S.game.turn, timer = $('#timer');
    if (t && t.endsAt && !S.game.busy) {
      const left = Math.max(0, Math.ceil((t.endsAt - (Date.now() + S.clockOffset)) / 1000));
      const txt = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
      if (timer.textContent !== txt) timer.textContent = txt;
      timer.classList.toggle('low', left <= 10);
    } else if (timer.textContent) timer.textContent = t && !t.endsAt ? '∞' : '';
  }
  requestAnimationFrame(frame);

  // coordinates readout (in the viewer's own frame, matching what they type)
  function showCoords(e) {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    if (px < 0 || py < 0 || px > rect.width || py > rect.height) return hideCoords();
    const X = PLANE.XMIN + (px / rect.width) * 50, Y = PLANE.YMAX - (py / rect.height) * 30;
    const c = $('#coords');
    c.textContent = `(${X.toFixed(1)}, ${Y.toFixed(1)})`;
    const box = $('#board-box').getBoundingClientRect();
    c.style.display = 'block';
    c.style.left = Math.min(e.clientX - box.left + 12, box.width - 90) + 'px';
    c.style.top = Math.max(e.clientY - box.top - 26, 0) + 'px';
  }
  function hideCoords() { $('#coords').style.display = 'none'; }
  canvas.addEventListener('pointermove', showCoords);
  canvas.addEventListener('pointerdown', showCoords);
  canvas.addEventListener('pointerleave', hideCoords);

  // ---- Sound ------------------------------------------------------------------------------
  let actx = null;
  function audio() {
    if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; } }
    if (actx.state === 'suspended') actx.resume();
    return actx;
  }
  document.addEventListener('pointerdown', () => audio(), { once: true });
  function playHumm(ms) {
    if (S.muted) return;
    const a = audio();
    if (!a) return;
    // soft synthesized hum for the duration of the shot
    const osc = a.createOscillator(), g = a.createGain(), end = a.currentTime + ms / 1000;
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(220, a.currentTime);
    osc.frequency.linearRampToValueAtTime(330, end);
    g.gain.setValueAtTime(0.0001, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.06, a.currentTime + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(g); g.connect(a.destination); osc.start(); osc.stop(end + 0.05);
  }
  function playBoom(vol) {
    if (S.muted) return;
    const a = audio();
    if (!a) return;
    const len = a.sampleRate * 0.45, buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    const src = a.createBufferSource(), g = a.createGain(), f = a.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 900;
    g.gain.value = 0.6 * vol;
    src.buffer = buf; src.connect(f); f.connect(g); g.connect(a.destination); src.start();
  }

  connect();
})();
