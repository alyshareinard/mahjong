# Mahjong

A web version of Chinese (Hong Kong-style) Mahjong for four players, built with SvelteKit, Tailwind CSS, and Socket.IO for realtime play. Works in any browser, so Apple and Android friends can play together.

## Rules implemented

- Standard 144-tile set: characters (萬), bamboo (索), dots (筒), winds (東南西北), dragons (中發白), and 8 flower/season tiles.
- Deal, draw, discard, and claim (chi/pong/kong/win) with correct priority (win > pong/kong > chi).
- Concealed kongs, promoted (added) kongs, and kong replacement draws (including winning off a replacement tile).
- Win detection for standard 4-sets-plus-pair hands, Seven Pairs, and Thirteen Orphans.
- A simplified Hong Kong-style fan scoring system — see the in-game "?" button for the full list of fan values and how points are settled between players.
- Dealer rotates unless the dealer wins or the hand is a draw (wall exhausted). Round wind is fixed at East for simplicity — this is a casual "East round only" variant.
- Flowers are exposed immediately and always drawn as replacements, matching real play.

This is a simplified ruleset built for a casual friend group, not tournament (MCR) rules — a few rare edge cases (robbing a kong, noten payments on a draw) are intentionally left out.

## Developing

Install dependencies and start a dev server:

```sh
npm install
npm run dev

# or start the server and open the app in a new browser tab
npm run dev -- --open
```

## Building

To create a production version of the app:

```sh
npm run build
```

You can preview the production build locally with:

```sh
npm run build && npm start
```

## Deploying to Railway

This project uses `@sveltejs/adapter-node`, so it builds to a standalone Node server (`server.js`) that also wires up the Socket.IO realtime layer — no separate adapter config needed for Railway.

1. Push this project to a GitHub repo.
2. In Railway, create a new project → **Deploy from GitHub repo** → select this repo.
3. Railway auto-detects Node from `package.json` and will run `npm install`, then `npm run build` (build script), then `npm start` (start script) — no extra configuration required.
4. Railway sets `PORT` automatically; `server.js` already reads `process.env.PORT`.
5. Once deployed, share the Railway URL with your group — each person opens it, enters a name, and either creates a table (share the room code) or joins one. Mahjong needs exactly 4 players to start.

Reconnection: if someone's connection drops mid-game, rejoining with the same name/browser (their name + player id are saved in local storage) reconnects them to their seat and hand automatically.
