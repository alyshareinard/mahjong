// @ts-nocheck
import { Server } from 'socket.io';

const SUITS_NUM = ['characters', 'bamboo', 'dots'];
const WIND_RANKS = ['E', 'S', 'W', 'N'];
const DRAGON_RANKS = ['red', 'green', 'white'];
const MIN_CORE_FAN = 1;
const CLAIM_WINDOW_MS = 20000;
const FLOWER_SEAT_BY_RANK = { 1: 'E', 2: 'S', 3: 'W', 4: 'N' };
const SUIT_RANK_ORDER = { characters: 0, bamboo: 1, dots: 2, wind: 3, dragon: 4 };
const WIND_SEQ = { E: 0, S: 1, W: 2, N: 3 };
const DRAGON_SEQ = { red: 0, green: 1, white: 2 };
const ORPHAN_KEYS = [
	'characters-1', 'characters-9', 'bamboo-1', 'bamboo-9', 'dots-1', 'dots-9',
	'wind-E', 'wind-S', 'wind-W', 'wind-N', 'dragon-red', 'dragon-green', 'dragon-white'
];

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

function isSevenPairs(tiles) {
	if (tiles.length !== 14) return false;
	const counts = tallyCounts(tiles);
	const values = Object.values(counts);
	return values.length === 7 && values.every((c) => c === 2);
}

function isThirteenOrphans(tiles) {
	if (tiles.length !== 14) return false;
	const counts = tallyCounts(tiles);
	const keys = Object.keys(counts);
	if (keys.length !== 13) return false;
	for (const k of keys) if (!ORPHAN_KEYS.includes(k)) return false;
	for (const k of ORPHAN_KEYS) if (!counts[k]) return false;
	return true;
}

function calculateFan(melds, pairKey, context) {
	if (context.method === 'thirteenOrphans') {
		return { fan: 13, detail: [{ name: 'Thirteen Orphans', value: 13 }] };
	}

	const detail = [];
	let fan = 0;
	function add(name, value) {
		fan += value;
		detail.push({ name, value });
	}

	if (context.method === 'sevenPairs') {
		add('Seven Pairs', 4);
	} else {
		const allChow = melds.every((m) => m.type === 'chow');
		const allPungKong = melds.every((m) => m.type === 'pung' || m.type === 'kong');
		if (allChow) add('All Chow', 1);
		if (allPungKong) add('All Pungs', 3);
	}

	const suitedSuits = new Set();
	let hasHonor = false;
	for (const key of [...melds.flatMap((m) => m.keys), pairKey]) {
		const suit = key.split('-')[0];
		if (suit === 'wind' || suit === 'dragon') hasHonor = true;
		else suitedSuits.add(suit);
	}
	if (suitedSuits.size === 0 && hasHonor) add('All Honors', 10);
	else if (suitedSuits.size === 1 && !hasHonor) add('Pure One Suit', 7);
	else if (suitedSuits.size === 1 && hasHonor) add('Mixed One Suit', 3);

	const dragonSets = melds.filter((m) => (m.type === 'pung' || m.type === 'kong') && m.keys[0].startsWith('dragon-'));
	for (const d of dragonSets) add(`Dragon Pung (${d.keys[0].split('-')[1]})`, 1);
	if (dragonSets.length === 3) add('Great Dragons', 8);
	else if (dragonSets.length === 2 && pairKey.startsWith('dragon-')) add('Small Dragons', 5);

	const windSets = melds.filter((m) => (m.type === 'pung' || m.type === 'kong') && m.keys[0].startsWith('wind-'));
	for (const w of windSets) {
		const wind = w.keys[0].split('-')[1];
		if (wind === context.seatWind) add('Seat Wind Pung', 1);
		if (wind === context.roundWind) add('Round Wind Pung', 1);
	}
	if (windSets.length === 4) add('Great Winds', 13);
	else if (windSets.length === 3 && pairKey.startsWith('wind-')) add('Small Winds', 6);

	if (context.selfDraw) add('Self-Draw', 1);
	if (context.fullyConcealed) add('Fully Concealed Hand', 1);

	const flowerCount = context.flowers.length;
	if (flowerCount > 0) add(`Flower Bonus x${flowerCount}`, flowerCount);
	const ownFlowerCount = context.flowers.filter((f) => f.own).length;
	if (ownFlowerCount > 0) add('Own-Seat Flower Bonus', ownFlowerCount);

	return { fan, detail };
}

function annotateFlowers(player) {
	return player.flowers.map((f) => ({ own: FLOWER_SEAT_BY_RANK[f.rank] === player.seatWind }));
}

function findBestWin(player, extraTile, context) {
	const concealed = extraTile ? [...player.hand, extraTile] : player.hand.slice();
	const meldsNeeded = 4 - player.melds.length;
	const exposed = player.melds.map((m) => ({ type: m.type, keys: m.tiles.map(tileKeyOf) }));
	const candidates = [];

	if (concealed.length === meldsNeeded * 3 + 2) {
		for (const c of findWinCandidates(concealed, meldsNeeded)) {
			candidates.push({ method: 'standard', melds: [...exposed, ...c.melds], pair: c.pairKey });
		}
	}
	if (player.melds.length === 0 && concealed.length === 14) {
		if (isSevenPairs(concealed)) {
			const keys = Object.keys(tallyCounts(concealed));
			candidates.push({ method: 'sevenPairs', melds: keys.map((k) => ({ type: 'pair', keys: [k, k] })), pair: keys[0] });
		}
		if (isThirteenOrphans(concealed)) {
			candidates.push({ method: 'thirteenOrphans', melds: [], pair: '' });
		}
	}
	if (candidates.length === 0) return null;

	let best = null;
	for (const c of candidates) {
		const fanResult = calculateFan(c.melds, c.pair, { ...context, method: c.method });
		const flowerFan = context.flowers.length + context.flowers.filter((f) => f.own).length;
		const coreFan = fanResult.fan - flowerFan;
		if (c.method !== 'thirteenOrphans' && coreFan < MIN_CORE_FAN) continue;
		if (!best || fanResult.fan > best.fan) best = { fan: fanResult.fan, detail: fanResult.detail, method: c.method };
	}
	return best;
}

function fanToPoints(fan) {
	if (fan >= 13) return 64;
	if (fan < 1) return 0;
	return Math.min(Math.pow(2, fan - 1), 32);
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
		player.socket.emit('state', getStateForPlayer(game, player.id));
	}
}

function getStateForPlayer(game, playerId) {
	const player = game.players.find((p) => p.id === playerId);
	if (!player) return null;
	const pc = game.pendingClaim;
	const isMyTurn = game.status === 'playing' && currentPlayer(game)?.id === playerId;
	const canWin =
		isMyTurn && game.turnPhase === 'awaitingDiscard' && game.turnEntrySource === 'draw'
			? !!findBestWin(player, null, {
					selfDraw: true,
					seatWind: player.seatWind,
					roundWind: game.roundWind,
					fullyConcealed: player.melds.length === 0,
					flowers: annotateFlowers(player)
				})
			: false;

	return {
		id: game.id,
		status: game.status,
		myPlayerId: playerId,
		myHand: player.hand,
		myMelds: player.melds,
		myFlowers: player.flowers,
		mySeatWind: player.seatWind,
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
			isDealer: game.players[game.dealerIndex]?.id === p.id,
			isCurrent: game.status === 'playing' && currentPlayer(game)?.id === p.id,
			disconnected: p.disconnected ?? false,
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
		disconnected: false,
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

// ---------- dealing & turn flow ----------

function drawTileForPlayer(game, player) {
	while (true) {
		if (game.wall.length === 0) return false;
		const tile = game.wall.pop();
		if (tile.suit === 'flower') {
			player.flowers.push(tile);
			continue;
		}
		player.hand.push(tile);
		return true;
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
	drawTileForPlayer(game, game.players[game.dealerIndex]);
	game.currentPlayerIndex = game.dealerIndex;
	game.turnPhase = 'awaitingDiscard';
	game.turnEntrySource = 'draw';
	game.status = 'playing';
}

function startGame(game, socket) {
	if (game.status !== 'waiting') {
		socket.emit('error', 'Game already started');
		return;
	}
	if (game.players.length !== 4) {
		socket.emit('error', 'Mahjong needs exactly 4 players');
		return;
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
	log(game, `${player.name} drew a tile`);
	broadcastState(game);
}

function discardTile(game, socket, tileId) {
	const player = currentPlayer(game);
	if (!player || player.id !== socket.id) return socket.emit('error', 'Not your turn');
	if (game.turnPhase !== 'awaitingDiscard') return socket.emit('error', 'Not time to discard');
	const idx = player.hand.findIndex((t) => t.id === tileId);
	if (idx === -1) return socket.emit('error', 'Tile not in hand');
	const [tile] = player.hand.splice(idx, 1);
	game.discards.push({ tile, playerId: player.id });
	log(game, `${player.name} discarded ${describeTile(tile)}`);
	openClaimWindow(game, tile, player.id);
}

function computeClaimOptions(game, player, discardTile, isImmediateNext) {
	const matching = player.hand.filter((t) => t.suit === discardTile.suit && t.rank === discardTile.rank);
	const winCheck = findBestWin(player, discardTile, {
		selfDraw: false,
		seatWind: player.seatWind,
		roundWind: game.roundWind,
		fullyConcealed: player.melds.length === 0,
		flowers: annotateFlowers(player)
	});
	return {
		canHu: !!winCheck,
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
		if (p.disconnected) continue;
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
	if (huIds.length > 0) return endHandWithDiscardWin(game, pc, huIds);

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
		log(game, `${player.name} drew a replacement tile`);
	} else {
		game.turnEntrySource = 'claim';
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
	broadcastState(game);
}

function handleWinSelfDraw(game, socket) {
	const player = currentPlayer(game);
	if (!player || player.id !== socket.id) return socket.emit('error', 'Not your turn');
	if (game.turnPhase !== 'awaitingDiscard' || game.turnEntrySource !== 'draw') {
		return socket.emit('error', 'Cannot declare win now');
	}
	const context = {
		selfDraw: true,
		seatWind: player.seatWind,
		roundWind: game.roundWind,
		fullyConcealed: player.melds.length === 0,
		flowers: annotateFlowers(player)
	};
	const win = findBestWin(player, null, context);
	if (!win) return socket.emit('error', 'Not a winning hand');
	endHandWithSelfDrawWin(game, player, win);
}

function revealedHands(game) {
	return game.players.map((p) => ({ id: p.id, name: p.name, hand: p.hand, melds: p.melds, flowers: p.flowers }));
}

function endHandWithSelfDrawWin(game, player, win) {
	const points = fanToPoints(win.fan);
	for (const o of game.players) {
		if (o.id === player.id) continue;
		game.totalScores[o.id] = (game.totalScores[o.id] || 0) - points;
	}
	game.totalScores[player.id] = (game.totalScores[player.id] || 0) + points * 3;
	game.status = 'roundOver';
	game.pendingClaim = null;
	game.dealerRetained = player.id === game.players[game.dealerIndex].id;
	game.result = {
		draw: false,
		winners: [{ playerId: player.id, name: player.name, fan: win.fan, points, detail: win.detail, method: win.method, selfDraw: true }],
		discarderId: null,
		handNumber: game.handNumber,
		revealedHands: revealedHands(game)
	};
	log(game, `${player.name} wins by self-draw! (${win.fan} fan)`);
	broadcastState(game);
}

function endHandWithDiscardWin(game, pc, huIds) {
	const discard = pc.discardTile;
	const discarder = game.players.find((p) => p.id === pc.discarderId);
	const winners = [];
	for (const id of huIds) {
		const player = game.players.find((p) => p.id === id);
		const context = {
			selfDraw: false,
			seatWind: player.seatWind,
			roundWind: game.roundWind,
			fullyConcealed: player.melds.length === 0,
			flowers: annotateFlowers(player)
		};
		const win = findBestWin(player, discard, context);
		if (!win) continue;
		const points = fanToPoints(win.fan);
		game.totalScores[discarder.id] = (game.totalScores[discarder.id] || 0) - points * 3;
		game.totalScores[player.id] = (game.totalScores[player.id] || 0) + points * 3;
		winners.push({ playerId: id, name: player.name, fan: win.fan, points, detail: win.detail, method: win.method, selfDraw: false });
	}
	game.status = 'roundOver';
	game.pendingClaim = null;
	game.dealerRetained = winners.some((w) => w.playerId === game.players[game.dealerIndex].id);
	game.result = {
		draw: false,
		winners,
		discarderId: discarder.id,
		discarderName: discarder.name,
		discardTile: discard,
		handNumber: game.handNumber,
		revealedHands: revealedHands(game)
	};
	log(game, `${winners.map((w) => w.name).join(' and ')} won off ${discarder.name}'s discard!`);
	broadcastState(game);
}

function endHandDraw(game) {
	game.status = 'roundOver';
	game.pendingClaim = null;
	game.dealerRetained = true;
	game.result = { draw: true, winners: [], handNumber: game.handNumber, revealedHands: revealedHands(game) };
	log(game, 'Wall exhausted — hand is a draw');
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
		socket.on('start', () => {
			const roomId = socketRoom.get(socket.id);
			const game = roomId && games.get(roomId);
			if (game) startGame(game, socket);
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
