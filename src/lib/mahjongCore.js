// Shared, framework-free Mahjong helpers used by both the live game server
// (socket-handler.js) and the client-side scoring app. Plain JS so plain Node can import it.
// @ts-nocheck

export const SUITS_NUM = ['characters', 'bamboo', 'dots'];
export const WIND_RANKS = ['E', 'S', 'W', 'N'];
export const DRAGON_RANKS = ['red', 'green', 'white'];
export const SUIT_RANK_ORDER = { characters: 0, bamboo: 1, dots: 2, wind: 3, dragon: 4 };
export const WIND_SEQ = { E: 0, S: 1, W: 2, N: 3 };
export const DRAGON_SEQ = { red: 0, green: 1, white: 2 };

export function tileKeyOf(tile) {
	return `${tile.suit}-${tile.rank}`;
}

export function tallyCounts(tiles) {
	const counts = {};
	for (const t of tiles) {
		const k = tileKeyOf(t);
		counts[k] = (counts[k] || 0) + 1;
	}
	return counts;
}

export function cloneCounts(counts) {
	return { ...counts };
}

export function keyOrder(key) {
	const [suit, rankRaw] = key.split('-');
	const suitOrd = SUIT_RANK_ORDER[suit] ?? 9;
	let rankOrd;
	if (suit === 'wind') rankOrd = WIND_SEQ[rankRaw];
	else if (suit === 'dragon') rankOrd = DRAGON_SEQ[rankRaw];
	else rankOrd = parseInt(rankRaw, 10);
	return suitOrd * 100 + rankOrd;
}

export function findAllMeldDecompositions(counts, meldsNeeded) {
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

export function findWinCandidates(concealedTiles, meldsNeeded) {
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

// Best-effort decomposition of a (possibly incomplete) concealed hand into
// pungs/kongs + one bonus-worthy pair, for scoring non-winning hands at hand-end.
export function extractMeldsForScoring(hand) {
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

export const ALL_TILE_KINDS = [
	...SUITS_NUM.flatMap((suit) => Array.from({ length: 9 }, (_, i) => ({ suit, rank: i + 1 }))),
	...WIND_RANKS.map((rank) => ({ suit: 'wind', rank })),
	...DRAGON_RANKS.map((rank) => ({ suit: 'dragon', rank }))
];

// Settle a hand: the winner receives their full score from each opponent; non-winners
// settle the difference between their own scores. Any transaction involving East Wind
// (paying or receiving) is doubled. Works for the no-winner (draw) case too, since every
// pair then just falls through to the "settle the difference" branch.
// `players` is [{ id, seatWind }]; `scores` maps id -> capped hand score.
export function settlePayments(players, scores, winnerId) {
	const payments = {};
	for (const p of players) payments[p.id] = 0;
	for (let i = 0; i < players.length; i++) {
		for (let j = i + 1; j < players.length; j++) {
			const a = players[i];
			const b = players[j];
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
