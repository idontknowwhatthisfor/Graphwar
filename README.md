# Graphwar LAN — basic dark version

A plain, dark-themed browser version of Graphwar playable over your local network.
It uses no art, sounds or fonts from the game: soldiers are drawn as discs, sounds are
synthesized, and text uses the system font. Nothing is loaded from the internet.

## Run

```
node server.js          # or: node server.js 3000
```

Needs Node 16+, no `npm install`. The server prints addresses such as
`http://192.168.1.20:8080`; open that on every device on the same Wi‑Fi.
On macOS, allow incoming connections for `node` if the firewall asks.

## Play

- Create a game, pick teams, add bots (easy / normal / hard), choose the function mode
  (`y =`, `y' =`, `y'' =`), turn time and soldiers per player, then start.
- On your turn, type a function and fire. The shot follows its graph from your soldier,
  kills every soldier it touches and stops at an obstacle (blasting a hole) or the edge.
- Each side sees the board from its own side, so you always fire to the right.
  For `y = f(x)` the curve is shifted to pass through your soldier; the ODE modes
  start at your soldier with `y' = 0`.
- Others can join a running game as spectators. Refreshing or a phone going to sleep
  keeps your seat for 60 seconds.

## Files

- `server.js` — HTTP + WebSocket server, rooms, turns, bots (authoritative simulation)
- `public/shared.js` — expression parser and shot simulator (used by server and browser)
- `public/client.js`, `index.html`, `style.css` — the browser client
- `calculate.py` — shot calculator: finds a function from your soldier to a target around the
  obstacles and checks it with the game's own simulator. See [CALCULATE.md](CALCULATE.md).
