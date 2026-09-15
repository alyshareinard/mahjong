// @ts-nocheck
import { Server } from 'socket.io';

const SUITS_NUM = ['characters', 'bamboo', 'dots'];
const WIND_RANKS = ['E', 'S', 'W', 'N'];
const DRAGON_RANKS = ['red', 'green', 'white'];
const CLAIM_WINDOW_MS = 20000;
const DUMMY_DELAY_MS = 700;
const OWN_FLOWER_RANK = { E: 1, S: 2, W: 3, N: 4 };
const SUIT_RANK_ORDER = { characters: 0, bamboo: 1, dots: 2, wind: 3, dragon: 4 };
const WIND_SEQ = { E: 0, S: 1, W: 2, N: 3 };
const DRAGON_SEQ = { red: 0, green: 1, white: 2 };
const LIMIT = 1000;

// ---------- tiles & wall ----------

function shuffle(array) {
	const a = [...array];
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

function buildWall() {
	const tiles = [];
	let counter = 0;
	for (const suit of SUITS_NUM) {
		for (let rank = 1; rank <= 9; rank++) {
			for (let i = 0; i < 4; i++) tiles.push({ id: `${suit}-${rank}-${counter++}`, suit, rank });
		}
	}
	for (const rank of WIND_RANKS) {
		for (let i = 0; i < 4; i++) tiles.push({ id: `wind-${rank}-${counter++}`, suit: 'wind', rank });
	}
	for (const rank of DRAGON_RANKS) {
		for (let i = 0; i < 4; i++) tiles.push({ id: `dragon-${rank}-${counter++}`, suit: 'dragon', rank });
	}
	for (let n = 1; n <= 4; n++) {
		tiles.push({ id: `flower-flower-${n}-${counter++}`, suit: 'flower', rank: n, kind: 'flower' });
		tiles.push({ id: `flower-season-${n}-${counter++}`, suit: 'flower', rank: n, kind: 'season' });
	}
	return shuffle(tiles);
}

function tileKeyOf(tile) {
	return `${tile.suit}-${tile.rank}`;
}

function describeTile(tile) {
	if (tile.suit === 'wind') return `${{ E: 'East', S: 'South', W: 'West', N: 'North' }[tile.rank]} Wind`;
	if (tile.suit === 'dragon') return `${{ red: 'Red', green: 'Green', white: 'White' }[tile.rank]} Dragon`;
	if (tile.suit === 'flower') return `${tile.kind === 'season' ? 'Season' : 'Flower'} ${tile.rank}`;
	const suitName = { characters: 'Characters', bamboo: 'Bamboo', dots: 'Dots' }[tile.suit];
	return `${tile.rank} ${suitName}`;
}

function tallyCounts(tiles) {
	const counts = {};
	for (const t of tiles) {
		const k = tileKeyOf(t);
		counts[k] = (counts[k] || 0) + 1;
	}
	return counts;
}

function cloneCounts(counts) {
	return { ...counts };
}

function keyOrder(key) {
	const [suit, rankRaw] = key.split('-');
	const suitOrd = SUIT_RANK_ORDER[suit] ?? 9;
	let rankOrd;
	if (suit === 'wind') rankOrd = WIND_SEQ[rankRaw];
	else if (suit === 'dragon') rankOrd = DRAGON_SEQ[rankRaw];
	else rankOrd = parseInt(rankRaw, 10);
	return suitOrd * 100 + rankOrd;
}

// ---------- winning-hand decomposition ----------

function findAllMeldDecompositions(counts, meldsNeeded) {
	if (meldsNeeded === 0) {
		for (const k in counts) if (counts[k] > 0) return [];
		return [[]];
	}
	const keys = Object.keys(counts).filter((k) => counts[k] > 0).sort((a, b) => keyOrder(a) - keyOrder(b));
	if (keys.length === 0) return [];
	const smallest = keys[0];
	const results = [];

	if (counts[smallest] >= 3) {
		const next = cloneCounts(counts);
		next[smallest] -= 3;
		for (const sub of findAllMeldDecompositions(next, meldsNeeded - 1)) {
			results.push([{ type: 'pung', keys: [smallest, smallest, smallest] }, ...sub]);
		}
	}

	const [suit, rankRaw] = smallest.split('-');
	if (suit === 'characters' || suit === 'bamboo' || suit === 'dots') {
		const rank = parseInt(rankRaw, 10);
		if (rank <= 7) {
			const k2 = `${suit}-${rank + 1}`;
			const k3 = `${suit}-${rank + 2}`;
			if ((counts[k2] || 0) >= 1 && (counts[k3] || 0) >= 1) {
				const next = cloneCounts(counts);
				next[smallest] -= 1;
				next[k2] -= 1;
				next[k3] -= 1;
				for (const sub of findAllMeldDecompositions(next, meldsNeeded - 1)) {
					results.push([{ type: 'chow', keys: [smallest, k2, k3] }, ...sub]);
				}
			}
		}
	}

	return results;
}

function findWinCandidates(concealedTiles, meldsNeeded) {
	const counts = tallyCounts(concealedTiles);
	const pairKeys = Object.keys(counts).filter((k) => counts[k] >= 2);
	const candidates = [];
	for (const pairKey of pairKeys) {
		const remaining = cloneCounts(counts);
		remaining[pairKey] -= 2;
		for (const melds of findAllMeldDecompositions(remaining, meldsNeeded)) {
			candidates.push({ pairKey, melds });
		}
	}
	return candidates;
}

// ---------- basic scoring (The Mah Jong Player's Companion, pp.22-25) ----------
// Every hand (winning or not) is scored on its own pungs/kongs/pairs, doubled for
// certain conditions, capped at LIMIT. The winner then collects their full score
// from each opponent; non-winners settle the difference between their own scores.
// East Wind always pays and receives double. "Fishing"/calling-hand bonuses,
// robbing-the-kong, and the ~150-hand named-pattern list are intentionally not
// implemented yet — see conversation history for why.

function isMajorTile(tile) {
	if (tile.suit === 'wind' || tile.suit === 'dragon') return true;
	if (tile.suit === 'characters' || tile.suit === 'bamboo' || tile.suit === 'dots') {
		return tile.rank === 1 || tile.rank === 9;
	}
	return false;
}

function meldPoints(meld) {
	if (meld.type === 'chow') return 0;
	const major = isMajorTile(meld.tiles[0]);
	if (meld.type === 'pung') return meld.concealed ? (major ? 8 : 4) : major ? 4 : 2;
	return meld.concealed ? (major ? 32 : 16) : major ? 16 : 8; // kong
}

function pairBonusPoints(pairKey, player, game) {
	const [suit, rank] = pairKey.split('-');
	if (suit === 'dragon') return 2;
	if (suit === 'wind') {
		let pts = 0;
		if (rank === player.seatWind) pts += 2;
		if (rank === game.roundWind) pts += 2;
		return pts;
	}
	return 0;
}

// Best-effort decomposition of a (possibly incomplete) concealed hand into
// pungs/kongs + one bonus-worthy pair, for scoring non-winning hands at hand-end.
function extractMeldsForScoring(hand) {
	const counts = tallyCounts(hand);
	const melds = [];
	const usedIds = new Set();
	function takeN(key, n) {
		const tiles = hand.filter((t) => !usedIds.has(t.id) && tileKeyOf(t) === key).slice(0, n);
		for (const t of tiles) usedIds.add(t.id);
		return tiles;
	}
	const sortedKeys = Object.keys(counts).sort((a, b) => keyOrder(a) - keyOrder(b));
	for (const key of sortedKeys) {
		if (counts[key] >= 4) {
			melds.push({ type: 'kong', concealed: true, tiles: takeN(key, 4) });
			counts[key] -= 4;
		}
	}
	for (const key of sortedKeys) {
		if (counts[key] >= 3) {
			melds.push({ type: 'pung', concealed: true, tiles: takeN(key, 3) });
			counts[key] -= 3;
		}
	}
	let pairKey = null;
	for (const key of sortedKeys) {
		if (counts[key] >= 2) {
			if (!pairKey) pairKey = key;
			if (key.startsWith('dragon-') || key.startsWith('wind-')) {
				pairKey = key;
				break;
			}
		}
	}
	return { melds, pairKey };
}

function computeHandScore(game, player, opts) {
	const { isWinner, selfDraw, wonWithLastWallTile, wonWithFinalDiscard, winningMelds, winningPairKey } = opts;
	const detail = [];
	let basic = 0;
	function addBasic(name, value) {
		if (value) {
			basic += value;
			detail.push({ name, value });
		}
	}
	const doubleDetail = [];
	let doubles = 0;
	function addDouble(name, count = 1) {
		doubles += count;
		doubleDetail.push({ name, count });
	}

	let melds, pairKey;
	if (isWinner) {
		melds = winningMelds;
		pairKey = winningPairKey;
	} else {
		const extracted = extractMeldsForScoring(player.hand);
		melds = [...player.melds.map((m) => ({ type: m.type, concealed: m.concealed, tiles: m.tiles })), ...extracted.melds];
		pairKey = extracted.pairKey;
	}

	for (const m of melds) {
		const pts = meldPoints(m);
		if (pts > 0) addBasic(`${m.concealed ? 'Concealed' : 'Exposed'} ${m.type} of ${describeTile(m.tiles[0])}`, pts);
	}
	if (pairKey) {
		const [pSuit, pRank] = pairKey.split('-');
		const pts = pairBonusPoints(pairKey, player, game);
		if (pts > 0) addBasic(`Pair of ${describeTile({ suit: pSuit, rank: pSuit === 'wind' || pSuit === 'dragon' ? pRank : parseInt(pRank, 10) })}`, pts);
	}
	if (player.flowers.length > 0) addBasic(`Flowers/Seasons x${player.flowers.length}`, player.flowers.length * 4);
	if (isWinner) {
		addBasic('Going Mah-Jong', 20);
		if (selfDraw) addBasic('Drew winning tile from wall', 2);
	}

	for (const m of melds) {
		if (m.type === 'chow') continue;
		const key = tileKeyOf(m.tiles[0]);
		if (key.startsWith('dragon-')) addDouble(`Dragon ${m.type}`);
		if (key.startsWith('wind-')) {
			const w = key.split('-')[1];
			if (w === player.seatWind) addDouble(`Own wind ${m.type}`);
			if (w === game.roundWind) addDouble(`Round wind ${m.type}`);
		}
	}
	const ownFlowerRank = OWN_FLOWER_RANK[player.seatWind];
	if (player.flowers.some((f) => f.kind === 'flower' && f.rank === ownFlowerRank)) addDouble('Holding own Flower');
	if (player.flowers.some((f) => f.kind === 'season' && f.rank === ownFlowerRank)) addDouble('Holding own Season');
	if ([1, 2, 3, 4].every((n) => player.flowers.some((f) => f.kind === 'flower' && f.rank === n))) addDouble('Complete set of Flowers', 2);
	if ([1, 2, 3, 4].every((n) => player.flowers.some((f) => f.kind === 'season' && f.rank === n))) addDouble('Complete set of Seasons', 2);

	if (isWinner) {
		if (melds.every((m) => m.type !== 'chow')) addDouble('No chows');
		const allKeys = [...melds.flatMap((m) => m.tiles.map(tileKeyOf)), pairKey];
		const suits = new Set(allKeys.map((k) => k.split('-')[0]).filter((s) => s !== 'wind' && s !== 'dragon'));
		if (suits.size === 1) addDouble('All one suit with Winds/Dragons');
		const allTerminalOrHonor = allKeys.every((k) => {
			const [s, r] = k.split('-');
			return s === 'wind' || s === 'dragon' || r === '1' || r === '9';
		});
		if (allTerminalOrHonor) addDouble('All 1s and 9s with Winds/Dragons');
		if (melds.every((m) => m.concealed)) addDouble('Fully concealed hand');
		if (wonWithLastWallTile) addDouble('Won with last tile from wall');
		if (wonWithFinalDiscard) addDouble('Won with final discard');
	}

	const rawScore = Math.round(basic * Math.pow(2, doubles));
	const cappedScore = Math.min(rawScore, LIMIT);
	return { basic, doubles, detail, doubleDetail, rawScore, cappedScore };
}

// Settle a hand: winner receives their full score from each opponent; non-winners
// settle the difference between their own scores. Any transaction involving East
// Wind (paying or receiving) is doubled. Works for the no-winner (draw) case too,
// since every pair then just falls through to the "settle the difference" branch.
function settleHand(game, scores, winnerId) {
	const payments = {};
	for (const p of game.players) payments[p.id] = 0;
	for (let i = 0; i < game.players.length; i++) {
		for (let j = i + 1; j < game.players.length; j++) {
			const a = game.players[i];
			const b = game.players[j];
			const multiplier = a.seatWind === 'E' || b.seatWind === 'E' ? 2 : 1;
			let amount;
			let aGains;
			if (winnerId === a.id) {
				amount = scores[a.id];
				aGains = true;
			} else if (winnerId === b.id) {
				amount = scores[b.id];
				aGains = false;
			} else if (scores[a.id] >= scores[b.id]) {
				amount = scores[a.id] - scores[b.id];
				aGains = true;
			} else {
				amount = scores[b.id] - scores[a.id];
				aGains = false;
			}
			amount *= multiplier;
			if (aGains) {
				payments[a.id] += amount;
				payments[b.id] -= amount;
			} else {
				payments[b.id] += amount;
				payments[a.id] -= amount;
			}
		}
	}
	return payments;
}

// ---------- ordinary-hand win detection (Four P/K + Pr, any suits) ----------

function resolveWinShape(concealedTiles, pairKey, keyMelds) {
	const pool = [...concealedTiles];
	function takeByKey(key) {
		const idx = pool.findIndex((t) => tileKeyOf(t) === key);
		const [t] = pool.splice(idx, 1);
		return t;
	}
	const melds = keyMelds.map((m) => ({ type: m.type, concealed: true, tiles: m.keys.map(takeByKey) }));
	takeByKey(pairKey);
	takeByKey(pairKey);
	return melds;
}

function findAllOrdinaryWinShapes(player, extraTile) {
	const concealed = extraTile ? [...player.hand, extraTile] : player.hand.slice();
	const meldsNeeded = 4 - player.melds.length;
	if (concealed.length !== meldsNeeded * 3 + 2) return [];
	const exposed = player.melds.map((m) => ({ type: m.type, concealed: m.concealed, tiles: m.tiles }));
	const candidates = findWinCandidates(concealed, meldsNeeded);
	return candidates.map((c) => ({
		melds: [...exposed, ...resolveWinShape(concealed, c.pairKey, c.melds)],
		pairKey: c.pairKey
	}));
}

function bestOrdinaryWinScore(game, player, extraTile, scoreContext) {
	const shapes = findAllOrdinaryWinShapes(player, extraTile);
	if (shapes.length === 0) return null;
	let best = null;
	for (const shape of shapes) {
		const result = computeHandScore(game, player, {
			...scoreContext,
			isWinner: true,
			winningMelds: shape.melds,
			winningPairKey: shape.pairKey
		});
		if (!best || result.rawScore > best.rawScore) best = result;
	}
	return best;
}

function findTileInHand(hand, suit, rank) {
	return hand.find((t) => t.suit === suit && t.rank === rank);
}

function getChiOptions(hand, tile) {
	if (!SUITS_NUM.includes(tile.suit)) return [];
	const options = [];
	const r = tile.rank;
	for (const [a, b] of [[r - 2, r - 1], [r - 1, r + 1], [r + 1, r + 2]]) {
		if (a < 1 || b > 9) continue;
		const ta = findTileInHand(hand, tile.suit, a);
		const tb = findTileInHand(hand, tile.suit, b);
		if (ta && tb) options.push([ta.id, tb.id]);
	}
	return options;
}

function getConcealedKongOptions(player) {
	const counts = tallyCounts(player.hand);
	const options = [];
	for (const key in counts) {
		if (counts[key] >= 4) {
			const [suit, rankRaw] = key.split('-');
			const rank = suit === 'wind' || suit === 'dragon' ? rankRaw : parseInt(rankRaw, 10);
			options.push({ suit, rank });
		}
	}
	return options;
}

function getPromotedKongOptions(player) {
	const options = [];
	player.melds.forEach((meld, index) => {
		if (meld.type === 'pung') {
			const ref = meld.tiles[0];
			if (player.hand.some((t) => t.suit === ref.suit && t.rank === ref.rank)) {
				options.push({ meldIndex: index, suit: ref.suit, rank: ref.rank });
			}
		}
	});
	return options;
}

// ---------- game state ----------

const games = new Map();
const socketRoom = new Map();

function getOrCreateGame(roomId) {
	if (!games.has(roomId)) {
		games.set(roomId, {
			id: roomId,
			status: 'waiting',
			players: [],
			wall: [],
			discards: [],
			dealerIndex: 0,
			currentPlayerIndex: 0,
			turnPhase: 'awaitingDraw',
			turnEntrySource: 'draw',
			lastDrawnTileId: null,
			dummyTimer: null,
			pendingClaim: null,
			roundWind: 'E',
			handNumber: 0,
			totalScores: {},
			result: null,
			dealerRetained: false,
			log: [],
			chat: []
		});
	}
	return games.get(roomId);
}

function log(game, message) {
	game.log.push(message);
	if (game.log.length > 30) game.log.shift();
}

function escapeHtml(text) {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

function currentPlayer(game) {
	return game.players[game.currentPlayerIndex];
}

function nextIndex(idx) {
	return (idx + 1) % 4;
}

function broadcastState(game) {
	for (const player of game.players) {
		if (player.isDummy) continue;
		player.socket.emit('state', getStateForPlayer(game, player.id));
	}
	scheduleDummyTurnIfNeeded(game);
}

// ---------- practice seats (fill empty seats for 1-3 player games) ----------
// A practice seat gets a real dealt hand like anyone else, but every turn it
// just draws a tile and immediately discards that exact tile back — its own
// dealt hand never changes. That keeps seat winds, the round wind, and all
// scoring math fully intact while giving real players genuine discards to
// react to (including claiming pong/kong/chi/hu off them), without pretending
// to be a strategic opponent.

function scheduleDummyTurnIfNeeded(game) {
	if (game.status !== 'playing') return;
	if (game.turnPhase !== 'awaitingDraw' && game.turnPhase !== 'awaitingDiscard') return;
	const player = currentPlayer(game);
	if (!player?.isDummy) return;
	if (game.dummyTimer) return;
	game.dummyTimer = setTimeout(() => {
		game.dummyTimer = null;
		runDummyTurn(game);
	}, DUMMY_DELAY_MS);
}

function runDummyTurn(game) {
	if (game.status !== 'playing') return;
	const player = currentPlayer(game);
	if (!player?.isDummy) return;
	if (game.turnPhase === 'awaitingDraw') {
		const drew = drawTileForPlayer(game, player);
		if (!drew) return endHandDraw(game);
		game.turnPhase = 'awaitingDiscard';
		game.turnEntrySource = 'draw';
		game.lastDrawnTileId = drew.id;
		log(game, `${player.name} drew a tile`);
		broadcastState(game);
	} else if (game.turnPhase === 'awaitingDiscard') {
		performDiscard(game, player, game.lastDrawnTileId);
	}
}

function getStateForPlayer(game, playerId) {
	const player = game.players.find((p) => p.id === playerId);
	if (!player) return null;
	const pc = game.pendingClaim;
	const isMyTurn = game.status === 'playing' && currentPlayer(game)?.id === playerId;
	const canWin =
		isMyTurn && game.turnPhase === 'awaitingDiscard' && game.turnEntrySource === 'draw'
			? findAllOrdinaryWinShapes(player, null).length > 0
			: false;

	return {
		id: game.id,
		status: game.status,
		myPlayerId: playerId,
		myHand: player.hand,
		myMelds: player.melds,
		myFlowers: player.flowers,
		mySeatWind: player.seatWind,
		myAssistMode: player.assistMode,
		myLastDrawnTileId: isMyTurn && game.turnEntrySource === 'draw' ? (game.lastDrawnTileId ?? null) : null,
		isMyTurn,
		turnPhase: game.turnPhase,
		canDeclareSelfDrawWin: canWin,
		availableConcealedKongs:
			isMyTurn && game.turnPhase === 'awaitingDiscard' ? getConcealedKongOptions(player) : [],
		availablePromotedKongs:
			isMyTurn && game.turnPhase === 'awaitingDiscard' ? getPromotedKongOptions(player) : [],
		pendingClaim: pc
			? {
					discardTile: pc.discardTile,
					discarderName: game.players.find((p) => p.id === pc.discarderId)?.name ?? '',
					myOptions: pc.eligiblePlayerIds.includes(playerId) && !pc.responses[playerId] ? pc.optionsByPlayer[playerId] : null,
					responded: pc.eligiblePlayerIds.includes(playerId) ? !!pc.responses[playerId] : null,
					waitingOn: pc.eligiblePlayerIds
						.filter((id) => !pc.responses[id])
						.map((id) => game.players.find((p) => p.id === id)?.name)
				}
			: null,
		players: game.players.map((p) => ({
			id: p.id,
			name: p.name,
			seatWind: p.seatWind,
			handCount: p.hand.length,
			melds: p.melds,
			flowers: p.flowers,
			assistMode: p.assistMode,
			isDealer: game.players[game.dealerIndex]?.id === p.id,
			isCurrent: game.status === 'playing' && currentPlayer(game)?.id === p.id,
			disconnected: p.disconnected ?? false,
			isDummy: p.isDummy ?? false,
			totalScore: game.totalScores[p.id] ?? 0
		})),
		dealerPlayerId: game.players[game.dealerIndex]?.id ?? null,
		roundWind: game.roundWind,
		handNumber: game.handNumber,
		wallCount: game.wall.length,
		discards: game.discards,
		result: game.result,
		log: game.log,
		chat: game.chat
	};
}

function reconnectPlayer(game, socket, existing, newName) {
	const oldId = existing.id;
	socketRoom.delete(oldId);
	existing.id = socket.id;
	existing.name = newName;
	existing.socket = socket;
	existing.disconnected = false;
	if (game.totalScores[socket.id] === undefined && game.totalScores[oldId] !== undefined) {
		game.totalScores[socket.id] = game.totalScores[oldId];
		delete game.totalScores[oldId];
	}
	socket.join(game.id);
	socketRoom.set(socket.id, game.id);
	broadcastState(game);
}

function addPlayer(game, socket, playerName, playerId) {
	if (game.players.find((p) => p.id === socket.id)) return;
	const name = playerName || `Player ${game.players.length + 1}`;

	if (playerId) {
		const existing = game.players.find((p) => p.playerId === playerId);
		if (existing) {
			reconnectPlayer(game, socket, existing, name);
			return;
		}
	}

	if (game.status !== 'waiting') {
		const existing = game.players.find((p) => p.name === name);
		if (existing) {
			reconnectPlayer(game, socket, existing, name);
			return;
		}
		socket.emit('error', 'Game already started — use the same name/device to reconnect');
		return;
	}

	if (game.players.length >= 4) {
		socket.emit('error', 'Game is full (4 players max)');
		return;
	}

	if (game.players.find((p) => p.name === name)) {
		socket.emit('nameTaken', { name });
		return;
	}

	game.players.push({
		id: socket.id,
		playerId: playerId || null,
		name,
		hand: [],
		melds: [],
		flowers: [],
		seatWind: null,
		assistMode: 'regular',
		disconnected: false,
		isDummy: false,
		socket
	});
	if (game.totalScores[socket.id] === undefined) game.totalScores[socket.id] = 0;
	socket.join(game.id);
	socketRoom.set(socket.id, game.id);
	broadcastState(game);
}

function removePlayer(game, socket, targetPlayerId) {
	if (game.status !== 'waiting') {
		socket.emit('error', 'Cannot remove players once the game has started');
		return;
	}
	const remover = game.players.find((p) => p.id === socket.id);
	if (!remover) return;
	const targetIndex = game.players.findIndex((p) => p.id === targetPlayerId);
	if (targetIndex === -1) {
		socket.emit('error', 'Player not found');
		return;
	}
	const target = game.players[targetIndex];
	socketRoom.delete(target.id);
	delete game.totalScores[target.id];
	game.players.splice(targetIndex, 1);
	if (game.players.length === 0) {
		games.delete(game.id);
		return;
	}
	log(game, `${remover.name} removed ${target.name} from the game`);
	broadcastState(game);
}

function removeSocketFromGame(socket) {
	const roomId = socketRoom.get(socket.id);
	if (!roomId) return;
	const game = games.get(roomId);
	if (!game) return;
	socketRoom.delete(socket.id);
	socket.leave(roomId);
	if (game.status === 'waiting') {
		game.players = game.players.filter((p) => p.id !== socket.id);
		if (game.players.length === 0) games.delete(roomId);
		else broadcastState(game);
	} else {
		const player = game.players.find((p) => p.id === socket.id);
		if (player) {
			player.disconnected = true;
			log(game, `${player.name} disconnected (hand preserved)`);
			broadcastState(game);
		}
	}
}

function chatMessage(game, playerId, text) {
	const player = game.players.find((p) => p.id === playerId);
	if (!player || !text || typeof text !== 'string') return;
	const trimmed = text.trim();
	if (trimmed.length === 0 || trimmed.length > 200) return;
	game.chat.push({ playerId: player.id, name: player.name, text: escapeHtml(trimmed), timestamp: Date.now() });
	if (game.chat.length > 100) game.chat.shift();
	broadcastState(game);
}

const ASSIST_MODES = ['regular', 'hint', 'learning'];

function setAssistMode(game, socket, mode) {
	const player = game.players.find((p) => p.id === socket.id);
	if (!player) return;
	if (!ASSIST_MODES.includes(mode)) return socket.emit('error', 'Unknown assist mode');
	player.assistMode = mode;
	broadcastState(game);
}

// ---------- dealing & turn flow ----------

function drawTileForPlayer(game, player) {
	while (true) {
		if (game.wall.length === 0) return null;
		const tile = game.wall.pop();
		if (tile.suit === 'flower') {
			player.flowers.push(tile);
			continue;
		}
		player.hand.push(tile);
		return tile;
	}
}

function dealHand(game) {
	game.wall = buildWall();
	game.discards = [];
	game.pendingClaim = null;
	game.result = null;
	game.dealerRetained = false;
	for (let i = 0; i < 4; i++) {
		const p = game.players[i];
		p.hand = [];
		p.melds = [];
		p.flowers = [];
		p.seatWind = WIND_RANKS[(i - game.dealerIndex + 4) % 4];
	}
	for (let round = 0; round < 13; round++) {
		for (const p of game.players) drawTileForPlayer(game, p);
	}
	const dealerLastTile = drawTileForPlayer(game, game.players[game.dealerIndex]);
	game.currentPlayerIndex = game.dealerIndex;
	game.turnPhase = 'awaitingDiscard';
	game.turnEntrySource = 'draw';
	game.lastDrawnTileId = dealerLastTile?.id ?? null;
	game.status = 'playing';
}

function addDummyPlayers(game) {
	let dummyCount = 0;
	while (game.players.length < 4) {
		dummyCount += 1;
		const label = game.players.filter((p) => p.isDummy).length + 1;
		game.players.push({
			id: `dummy-${game.id}-${label}`,
			playerId: null,
			name: `Practice Seat ${label}`,
			hand: [],
			melds: [],
			flowers: [],
			seatWind: null,
			assistMode: 'regular',
			disconnected: false,
			isDummy: true,
			socket: null
		});
	}
	return dummyCount;
}

function startGame(game, socket, fillEmptySeats) {
	if (game.status !== 'waiting') {
		socket.emit('error', 'Game already started');
		return;
	}
	if (game.players.length < 1) {
		socket.emit('error', 'Need at least 1 player');
		return;
	}
	if (game.players.length !== 4) {
		if (!fillEmptySeats) {
			socket.emit('error', 'Mahjong needs exactly 4 players (or turn on practice seats)');
			return;
		}
		const added = addDummyPlayers(game);
		log(game, `Filled ${added} empty seat${added === 1 ? '' : 's'} with practice partners.`);
	}
	game.dealerIndex = 0;
	game.handNumber = 1;
	dealHand(game);
	log(game, `Hand 1: ${game.players[game.dealerIndex].name} deals.`);
	broadcastState(game);
}

function startNextHand(game, socket) {
	if (game.status !== 'roundOver') {
		socket.emit('error', 'Current hand is still in progress');
		return;
	}
	if (!game.dealerRetained) game.dealerIndex = nextIndex(game.dealerIndex);
	game.handNumber += 1;
	dealHand(game);
	log(game, `Hand ${game.handNumber}: ${game.players[game.dealerIndex].name} deals.`);
	broadcastState(game);
}

function advanceTurnAfterPass(game, fromIdx) {
	game.pendingClaim = null;
	game.currentPlayerIndex = nextIndex(fromIdx);
	game.turnPhase = 'awaitingDraw';
	broadcastState(game);
}

function handleDraw(game, socket) {
	const player = currentPlayer(game);
	if (!player || player.id !== socket.id) return socket.emit('error', 'Not your turn');
	if (game.turnPhase !== 'awaitingDraw') return socket.emit('error', 'Cannot draw now');
	const drew = drawTileForPlayer(game, player);
	if (!drew) return endHandDraw(game);
	game.turnPhase = 'awaitingDiscard';
	game.turnEntrySource = 'draw';
	game.lastDrawnTileId = drew.id;
	log(game, `${player.name} drew a tile`);
	broadcastState(game);
}

function performDiscard(game, player, tileId) {
	const idx = player.hand.findIndex((t) => t.id === tileId);
	if (idx === -1) return;
	const [tile] = player.hand.splice(idx, 1);
	game.discards.push({ tile, playerId: player.id });
	log(game, `${player.name} discarded ${describeTile(tile)}`);
	openClaimWindow(game, tile, player.id);
}

function discardTile(game, socket, tileId) {
	const player = currentPlayer(game);
	if (!player || player.id !== socket.id) return socket.emit('error', 'Not your turn');
	if (game.turnPhase !== 'awaitingDiscard') return socket.emit('error', 'Not time to discard');
	if (!player.hand.some((t) => t.id === tileId)) return socket.emit('error', 'Tile not in hand');
	performDiscard(game, player, tileId);
}

function computeClaimOptions(game, player, discardTile, isImmediateNext) {
	const matching = player.hand.filter((t) => t.suit === discardTile.suit && t.rank === discardTile.rank);
	return {
		canHu: findAllOrdinaryWinShapes(player, discardTile).length > 0,
		canPong: matching.length >= 2,
		canKong: matching.length >= 3,
		chiOptions: isImmediateNext ? getChiOptions(player.hand, discardTile) : []
	};
}

function openClaimWindow(game, discardTile, discarderId) {
	const discarderIdx = game.players.findIndex((p) => p.id === discarderId);
	const eligible = [];
	const optionsByPlayer = {};
	for (let offset = 1; offset <= 3; offset++) {
		const idx = (discarderIdx + offset) % 4;
		const p = game.players[idx];
		if (p.disconnected || p.isDummy) continue;
		const opts = computeClaimOptions(game, p, discardTile, offset === 1);
		if (opts.canHu || opts.canPong || opts.canKong || opts.chiOptions.length > 0) {
			eligible.push(p.id);
			optionsByPlayer[p.id] = opts;
		}
	}
	game.turnPhase = 'awaitingClaims';
	if (eligible.length === 0) {
		advanceTurnAfterPass(game, discarderIdx);
		return;
	}
	game.pendingClaim = {
		discardTile,
		discarderId,
		discarderIdx,
		eligiblePlayerIds: eligible,
		optionsByPlayer,
		responses: {},
		timer: setTimeout(() => resolveClaims(game), CLAIM_WINDOW_MS)
	};
	broadcastState(game);
}

function handleRespondClaim(game, socket, response) {
	const pc = game.pendingClaim;
	if (!pc) return socket.emit('error', 'No claim to respond to');
	if (!pc.eligiblePlayerIds.includes(socket.id)) return socket.emit('error', 'Not eligible to claim');
	if (pc.responses[socket.id]) return socket.emit('error', 'Already responded');
	const opts = pc.optionsByPlayer[socket.id];
	const type = response?.type || 'pass';
	if (type === 'pass') {
		pc.responses[socket.id] = { type: 'pass' };
	} else if (type === 'hu' && opts.canHu) {
		pc.responses[socket.id] = { type: 'hu' };
	} else if (type === 'pong' && opts.canPong) {
		pc.responses[socket.id] = { type: 'pong' };
	} else if (type === 'kong' && opts.canKong) {
		pc.responses[socket.id] = { type: 'kong' };
	} else if (type === 'chi' && opts.chiOptions.length > 0) {
		const chosen = response.tileIds || [];
		const valid = opts.chiOptions.some((pair) => [...pair].sort().join() === [...chosen].sort().join());
		if (!valid) return socket.emit('error', 'Invalid chi selection');
		pc.responses[socket.id] = { type: 'chi', tileIds: chosen };
	} else {
		return socket.emit('error', 'Action not available');
	}
	broadcastState(game);
	if (pc.eligiblePlayerIds.every((id) => pc.responses[id])) {
		clearTimeout(pc.timer);
		resolveClaims(game);
	}
}

function resolveClaims(game) {
	const pc = game.pendingClaim;
	if (!pc) return;
	clearTimeout(pc.timer);
	for (const id of pc.eligiblePlayerIds) if (!pc.responses[id]) pc.responses[id] = { type: 'pass' };

	const huIds = pc.eligiblePlayerIds.filter((id) => pc.responses[id].type === 'hu');
	if (huIds.length > 0) {
		// This settlement system assumes a single winner per hand; if more than one
		// player could win off the same discard, priority goes to whoever is closest
		// to the discarder in turn order (same tie-break as pong/kong).
		let winnerId = null;
		for (let offset = 1; offset <= 3; offset++) {
			const candidate = game.players[(pc.discarderIdx + offset) % 4].id;
			if (huIds.includes(candidate)) {
				winnerId = candidate;
				break;
			}
		}
		return endHandWithDiscardWin(game, pc, winnerId);
	}

	const pongKongIds = pc.eligiblePlayerIds.filter((id) => ['pong', 'kong'].includes(pc.responses[id].type));
	if (pongKongIds.length > 0) {
		let winnerId = null;
		for (let offset = 1; offset <= 3; offset++) {
			const candidate = game.players[(pc.discarderIdx + offset) % 4].id;
			if (pongKongIds.includes(candidate)) {
				winnerId = candidate;
				break;
			}
		}
		return executePongKongClaim(game, pc, winnerId);
	}

	const chiId = pc.eligiblePlayerIds.find((id) => pc.responses[id].type === 'chi');
	if (chiId) return executeChiClaim(game, pc, chiId);

	advanceTurnAfterPass(game, pc.discarderIdx);
}

function executePongKongClaim(game, pc, winnerId) {
	const player = game.players.find((p) => p.id === winnerId);
	const response = pc.responses[winnerId];
	const discard = pc.discardTile;
	const count = response.type === 'kong' ? 3 : 2;
	const matches = player.hand.filter((t) => t.suit === discard.suit && t.rank === discard.rank).slice(0, count);
	for (const m of matches) {
		const idx = player.hand.findIndex((t) => t.id === m.id);
		player.hand.splice(idx, 1);
	}
	player.melds.push({
		type: response.type === 'kong' ? 'kong' : 'pung',
		tiles: [...matches, discard],
		concealed: false,
		claimedFrom: pc.discarderId
	});
	log(game, `${player.name} claimed ${response.type === 'kong' ? 'kong' : 'pong'} on ${describeTile(discard)}`);
	game.pendingClaim = null;
	game.currentPlayerIndex = game.players.findIndex((p) => p.id === winnerId);
	if (response.type === 'kong') {
		const drew = drawTileForPlayer(game, player);
		if (!drew) return endHandDraw(game);
		game.turnEntrySource = 'draw';
		game.lastDrawnTileId = drew.id;
		log(game, `${player.name} drew a replacement tile`);
	} else {
		game.turnEntrySource = 'claim';
		game.lastDrawnTileId = null;
	}
	game.turnPhase = 'awaitingDiscard';
	broadcastState(game);
}

function executeChiClaim(game, pc, playerId) {
	const player = game.players.find((p) => p.id === playerId);
	const response = pc.responses[playerId];
	const discard = pc.discardTile;
	const usedTiles = [];
	for (const tid of response.tileIds) {
		const idx = player.hand.findIndex((t) => t.id === tid);
		usedTiles.push(player.hand[idx]);
		player.hand.splice(idx, 1);
	}
	const meldTiles = [...usedTiles, discard].sort((a, b) => a.rank - b.rank);
	player.melds.push({ type: 'chow', tiles: meldTiles, concealed: false, claimedFrom: pc.discarderId });
	log(game, `${player.name} chi'd ${describeTile(discard)}`);
	game.pendingClaim = null;
	game.currentPlayerIndex = game.players.findIndex((p) => p.id === playerId);
	game.turnPhase = 'awaitingDiscard';
	game.turnEntrySource = 'claim';
	game.lastDrawnTileId = null;
	broadcastState(game);
}

function handleDeclareConcealedKong(game, socket, suit, rank) {
	const player = currentPlayer(game);
	if (!player || player.id !== socket.id) return socket.emit('error', 'Not your turn');
	if (game.turnPhase !== 'awaitingDiscard') return socket.emit('error', 'Cannot kong now');
	const matches = player.hand.filter((t) => t.suit === suit && String(t.rank) === String(rank));
	if (matches.length < 4) return socket.emit('error', 'You do not have 4 of that tile');
	const used = matches.slice(0, 4);
	for (const t of used) {
		const idx = player.hand.findIndex((h) => h.id === t.id);
		player.hand.splice(idx, 1);
	}
	player.melds.push({ type: 'kong', tiles: used, concealed: true, claimedFrom: null });
	log(game, `${player.name} declared a concealed kong`);
	const drew = drawTileForPlayer(game, player);
	if (!drew) return endHandDraw(game);
	game.turnEntrySource = 'draw';
	game.lastDrawnTileId = drew.id;
	broadcastState(game);
}

function handleDeclarePromotedKong(game, socket, meldIndex) {
	const player = currentPlayer(game);
	if (!player || player.id !== socket.id) return socket.emit('error', 'Not your turn');
	if (game.turnPhase !== 'awaitingDiscard') return socket.emit('error', 'Cannot kong now');
	const meld = player.melds[meldIndex];
	if (!meld || meld.type !== 'pung') return socket.emit('error', 'Invalid meld for promotion');
	const ref = meld.tiles[0];
	const idx = player.hand.findIndex((t) => t.suit === ref.suit && t.rank === ref.rank);
	if (idx === -1) return socket.emit('error', 'You do not have the matching tile');
	const [tile] = player.hand.splice(idx, 1);
	meld.tiles.push(tile);
	meld.type = 'kong';
	meld.promoted = true;
	log(game, `${player.name} promoted a pung to a kong`);
	const drew = drawTileForPlayer(game, player);
	if (!drew) return endHandDraw(game);
	game.turnEntrySource = 'draw';
	game.lastDrawnTileId = drew.id;
	broadcastState(game);
}

function handleWinSelfDraw(game, socket) {
	const player = currentPlayer(game);
	if (!player || player.id !== socket.id) return socket.emit('error', 'Not your turn');
	if (game.turnPhase !== 'awaitingDiscard' || game.turnEntrySource !== 'draw') {
		return socket.emit('error', 'Cannot declare win now');
	}
	const wonWithLastWallTile = game.wall.length === 0;
	const result = bestOrdinaryWinScore(game, player, null, { selfDraw: true, wonWithLastWallTile, wonWithFinalDiscard: false });
	if (!result) return socket.emit('error', 'Not a winning hand');
	endHand(game, { winnerId: player.id, winnerResult: result, selfDraw: true, discarderId: null, winningTile: null });
}

function revealedHands(game) {
	return game.players.map((p) => ({ id: p.id, name: p.name, hand: p.hand, melds: p.melds, flowers: p.flowers }));
}

function endHandWithDiscardWin(game, pc, winnerId) {
	const discard = pc.discardTile;
	const discarder = game.players.find((p) => p.id === pc.discarderId);
	const player = game.players.find((p) => p.id === winnerId);
	const wonWithFinalDiscard = game.wall.length === 0;
	const result = bestOrdinaryWinScore(game, player, discard, { selfDraw: false, wonWithLastWallTile: false, wonWithFinalDiscard });
	if (!result) {
		// Defensive: canHu was already validated before this claim was accepted, so
		// this shouldn't happen. If it somehow does, treat it as if everyone passed.
		return advanceTurnAfterPass(game, pc.discarderIdx);
	}
	endHand(game, { winnerId, winnerResult: result, selfDraw: false, discarderId: discarder.id, winningTile: discard });
}

function endHandDraw(game) {
	endHand(game, { winnerId: null, winnerResult: null, selfDraw: false, discarderId: null, winningTile: null });
}

// Scores every player's hand, settles the hand (winner collects full score from
// each opponent; non-winners settle their difference; East doubles), and updates
// running totals. Handles the no-winner (wall exhausted) case too, since every
// pairwise settlement then falls through to the "settle the difference" branch.
function endHand(game, { winnerId, winnerResult, selfDraw, discarderId, winningTile }) {
	if (game.dummyTimer) {
		clearTimeout(game.dummyTimer);
		game.dummyTimer = null;
	}
	const scores = {};
	const scoreResults = {};
	for (const p of game.players) {
		const result = p.id === winnerId ? winnerResult : computeHandScore(game, p, { isWinner: false });
		scores[p.id] = result.cappedScore;
		scoreResults[p.id] = result;
	}
	const payments = settleHand(game, scores, winnerId);
	for (const p of game.players) {
		game.totalScores[p.id] = (game.totalScores[p.id] || 0) + payments[p.id];
	}
	game.status = 'roundOver';
	game.pendingClaim = null;
	const winner = winnerId ? game.players.find((p) => p.id === winnerId) : null;
	game.dealerRetained = winnerId ? winnerId === game.players[game.dealerIndex].id : true;
	const discarderName = discarderId ? game.players.find((p) => p.id === discarderId)?.name : null;
	game.result = {
		draw: !winnerId,
		winnerId: winnerId ?? null,
		winnerName: winner?.name ?? null,
		selfDraw: !!selfDraw,
		discarderId: discarderId ?? null,
		discarderName,
		winningTile: winningTile ?? null,
		handNumber: game.handNumber,
		scores: game.players.map((p) => ({
			playerId: p.id,
			name: p.name,
			score: scores[p.id],
			basic: scoreResults[p.id].basic,
			doubles: scoreResults[p.id].doubles,
			rawScore: scoreResults[p.id].rawScore,
			detail: scoreResults[p.id].detail,
			doubleDetail: scoreResults[p.id].doubleDetail,
			payment: payments[p.id]
		})),
		revealedHands: revealedHands(game)
	};
	if (winnerId) {
		log(game, `${winner.name} wins${selfDraw ? ' by self-draw' : ` off ${discarderName}'s discard`}! (${scores[winnerId]} points)`);
	} else {
		log(game, 'Wall exhausted — hand is a draw');
	}
	broadcastState(game);
}

// ---------- wiring ----------

export default function injectSocketIO(server) {
	const io = new Server(server);
	io.on('connection', (socket) => {
		socket.on('join', ({ roomId, playerName, playerId }) => {
			const game = getOrCreateGame(roomId);
			addPlayer(game, socket, playerName, playerId);
		});
		socket.on('removePlayer', ({ targetPlayerId }) => {
			const roomId = socketRoom.get(socket.id);
			const game = roomId && games.get(roomId);
			if (game) removePlayer(game, socket, targetPlayerId);
		});
		socket.on('start', ({ fillEmptySeats } = {}) => {
			const roomId = socketRoom.get(socket.id);
			const game = roomId && games.get(roomId);
			if (game) startGame(game, socket, !!fillEmptySeats);
		});
		socket.on('draw', () => {
			const roomId = socketRoom.get(socket.id);
			const game = roomId && games.get(roomId);
			if (game) handleDraw(game, socket);
		});
		socket.on('discard', ({ tileId }) => {
			const roomId = socketRoom.get(socket.id);
			const game = roomId && games.get(roomId);
			if (game) discardTile(game, socket, tileId);
		});
		socket.on('respondClaim', (response) => {
			const roomId = socketRoom.get(socket.id);
			const game = roomId && games.get(roomId);
			if (game) handleRespondClaim(game, socket, response);
		});
		socket.on('declareConcealedKong', ({ suit, rank }) => {
			const roomId = socketRoom.get(socket.id);
			const game = roomId && games.get(roomId);
			if (game) handleDeclareConcealedKong(game, socket, suit, rank);
		});
		socket.on('declarePromotedKong', ({ meldIndex }) => {
			const roomId = socketRoom.get(socket.id);
			const game = roomId && games.get(roomId);
			if (game) handleDeclarePromotedKong(game, socket, meldIndex);
		});
		socket.on('winSelfDraw', () => {
			const roomId = socketRoom.get(socket.id);
			const game = roomId && games.get(roomId);
			if (game) handleWinSelfDraw(game, socket);
		});
		socket.on('setAssistMode', ({ mode }) => {
			const roomId = socketRoom.get(socket.id);
			const game = roomId && games.get(roomId);
			if (game) setAssistMode(game, socket, mode);
		});
		socket.on('chatMessage', ({ text }) => {
			const roomId = socketRoom.get(socket.id);
			const game = roomId && games.get(roomId);
			if (game) chatMessage(game, socket.id, text);
		});
		socket.on('nextHand', () => {
			const roomId = socketRoom.get(socket.id);
			const game = roomId && games.get(roomId);
			if (game) startNextHand(game, socket);
		});
		socket.on('leave', () => removeSocketFromGame(socket));
		socket.on('disconnect', () => removeSocketFromGame(socket));
	});
}
