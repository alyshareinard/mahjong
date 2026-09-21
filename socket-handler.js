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
// East Wind always pays and receives double. The book's named hands (a beginner-friendly
// "Short List" of ~35, or the "Full List" of ~80 from the book's full synopsis) are layered
// on top per-room (see below) and can override this with a fixed score. General
// "fishing"/calling-hand declarations outside of named hands, and robbing-the-kong, are
// intentionally not implemented yet.

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
		if (player.originalCallActive) addDouble('Original call');
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

const ALL_TILE_KINDS = [
	...SUITS_NUM.flatMap((suit) => Array.from({ length: 9 }, (_, i) => ({ suit, rank: i + 1 }))),
	...WIND_RANKS.map((rank) => ({ suit: 'wind', rank })),
	...DRAGON_RANKS.map((rank) => ({ suit: 'dragon', rank }))
];

// Is this player one tile away from a complete hand (a "calling"/tenpai hand)?
// Used to gate the Original Call declaration, which requires the hand to
// already be calling right after the player's first discard.
function isCallingHand(player) {
	const meldsNeeded = 4 - player.melds.length;
	if (player.hand.length !== meldsNeeded * 3 + 1) return false;
	return ALL_TILE_KINDS.some((probe) => findAllOrdinaryWinShapes(player, { id: 'probe', ...probe }).length > 0);
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

// ---------- named special hands (The Mah Jong Player's Companion "Short List", pp.6-7) ----------
// These ~25 hands have their own flat Winning/Fishing scores that bypass the normal
// basic-score-times-doubles calculation (and can exceed the normal LIMIT). Each hand's
// `distance(counts, ctx, maxDistance)` gets a tally of the player's full 14-tile-equivalent
// hand (concealed tiles + meld tiles, with kongs capped at 3 tiles so they behave like pungs)
// and reports how many tiles away it is from that exact pattern (0 = already there). A
// player's final score is the higher of the ordinary calculation and the best matching named
// hand (Winning for a complete hand, Fishing for a non-winner who is exactly one tile away at
// hand-end). The Learning-mode hint also uses this to list hands a few tiles away.
// Big Robert (marked below) is still a best-effort reading pending a closer look at the
// book's page 14 — everything else has been confirmed against the full page text.

const RED_BAMBOO_RANKS = [1, 5, 7, 9];
const GREEN_BAMBOO_RANKS = [2, 3, 4, 6, 8];

// ---------- soft ("distance") primitives ----------
// Instead of failing when a tile isn't available, each of these takes whatever it can
// (never more than asked) and reports the shortfall — how many more of that tile are still
// needed. Chaining these and summing shortfalls gives "how many tiles away" a hand is from a
// target shape. Extra/unrelated tiles a hand holds cost nothing (they just get discarded
// along the way), which is why none of these need a "nothing left over" check the old
// boolean matchers used.
//
// A few helpers pick the *cheapest* available option (e.g. "the best pair anywhere"). That's
// only safe to use for the last, terminal piece of a pattern — one with nothing computed
// afterward that shares its tile pool. Where two requirements draw from the same pool (e.g. a
// pung and a pair both from the same suit), the code below enumerates the earlier choice
// explicitly and only applies a "cheapest remaining" helper to whichever piece is genuinely
// computed last, so a greedy pick for one can't accidentally starve the other.

function takeSoft(counts, key, n) {
	const have = counts[key] || 0;
	const used = Math.min(have, n);
	counts[key] = have - used;
	return n - used;
}

function takeRunRangeSoft(counts, suit, lo, hi) {
	let deficit = 0;
	for (let r = lo; r <= hi; r++) deficit += takeSoft(counts, `${suit}-${r}`, 1);
	return deficit;
}

function takeEachWindSoft(counts) {
	let deficit = 0;
	for (const w of WIND_RANKS) deficit += takeSoft(counts, `wind-${w}`, 1);
	return deficit;
}

function takeEachDragonSoft(counts) {
	let deficit = 0;
	for (const d of DRAGON_RANKS) deficit += takeSoft(counts, `dragon-${d}`, 1);
	return deficit;
}

// Lowest-shortfall way to take one of each key in `keys`, except one (tried across every
// option) taken twice — the "any tile paired" construction used throughout the short list.
function takeUniqueSetWithOnePairedSoft(counts, keys) {
	let best = null;
	for (const doubled of keys) {
		const trial = cloneCounts(counts);
		let deficit = 0;
		for (const k of keys) deficit += takeSoft(trial, k, k === doubled ? 2 : 1);
		if (!best || deficit < best.deficit) best = { deficit, trial };
	}
	Object.assign(counts, best.trial);
	return best.deficit;
}

// Lowest-shortfall way to reach exactly `pairCount` pairs using only tiles from `keys` (a
// suit's 9 ranks, a fixed bamboo-color list, terminal tiles, whichever pool applies). Prefers
// completing an existing single before starting a pair from nothing, and lets one rank
// contribute more than one pair (e.g. all 4 copies of a tile = 2 pairs) when needed.
function takePairsFromPoolSoft(counts, keys, pairCount) {
	const info = keys.map((key) => ({ key, available: counts[key] || 0, used: 0 }));
	let pairsNeeded = pairCount;
	for (const rk of info) {
		while (pairsNeeded > 0 && rk.available - rk.used >= 2) {
			rk.used += 2;
			pairsNeeded--;
		}
	}
	let deficit = 0;
	for (const rk of info) {
		if (pairsNeeded > 0 && rk.available - rk.used === 1) {
			rk.used += 1;
			pairsNeeded--;
			deficit += 1;
		}
	}
	deficit += pairsNeeded * 2;
	for (const rk of info) counts[rk.key] = rk.available - rk.used;
	return deficit;
}

function isExactPairsInSuitSoft(counts, suit, pairCount) {
	const keys = Array.from({ length: 9 }, (_, i) => `${suit}-${i + 1}`);
	return takePairsFromPoolSoft(counts, keys, pairCount);
}

function takeChowSoft(counts, suit, startRank) {
	return (
		takeSoft(counts, `${suit}-${startRank}`, 1) +
		takeSoft(counts, `${suit}-${startRank + 1}`, 1) +
		takeSoft(counts, `${suit}-${startRank + 2}`, 1)
	);
}

// Lowest-shortfall chow starting anywhere in [loRank, hiRank] within `suit` — safe to use
// wherever nothing else afterward needs tiles from this same suit/rank range.
function takeBestChowSoft(counts, suit, loRank = 1, hiRank = 7) {
	let best = null;
	for (let r = loRank; r <= hiRank; r++) {
		const trial = cloneCounts(counts);
		const deficit = takeChowSoft(trial, suit, r);
		if (!best || deficit < best.deficit) best = { deficit, trial };
	}
	Object.assign(counts, best.trial);
	return best.deficit;
}

// Lowest-shortfall chow starting anywhere in any of `suits` — for "a chow in any suit" when
// it's the last, terminal piece of a pattern.
function takeBestChowAcrossSuitsSoft(counts, suits) {
	let best = null;
	for (const suit of suits) {
		for (let r = 1; r <= 7; r++) {
			const trial = cloneCounts(counts);
			const deficit = takeChowSoft(trial, suit, r);
			if (!best || deficit < best.deficit) best = { deficit, trial };
		}
	}
	Object.assign(counts, best.trial);
	return best.deficit;
}

// Lowest-shortfall pair from any of `keys` — for "a pair" when it's the last, terminal piece.
function takeBestPairInPoolSoft(counts, keys) {
	let bestKey = null;
	let bestDeficit = 2;
	for (const k of keys) {
		const d = Math.max(0, 2 - (counts[k] || 0));
		if (d < bestDeficit) {
			bestDeficit = d;
			bestKey = k;
		}
	}
	if (bestKey) takeSoft(counts, bestKey, 2);
	return bestDeficit;
}

// Lowest-shortfall pair from any rank in any of `suits` (any-suit "Pr").
function takeBestPairInSuitsSoft(counts, suits) {
	return takeBestPairInPoolSoft(counts, suits.flatMap((s) => Array.from({ length: 9 }, (_, i) => `${s}-${i + 1}`)));
}

// Lowest-shortfall pung/kong (3-of-a-kind) from any of `keys`.
function takeBestPungInPoolSoft(counts, keys) {
	let bestKey = null;
	let bestDeficit = 3;
	for (const k of keys) {
		const d = Math.max(0, 3 - (counts[k] || 0));
		if (d < bestDeficit) {
			bestDeficit = d;
			bestKey = k;
		}
	}
	if (bestKey) takeSoft(counts, bestKey, 3);
	return bestDeficit;
}

// Lowest-shortfall pung restricted to a rank range within one suit (e.g. non-terminal 2-8).
function takeBestPungInSuitRangeSoft(counts, suit, lo, hi) {
	return takeBestPungInPoolSoft(
		counts,
		Array.from({ length: hi - lo + 1 }, (_, i) => `${suit}-${lo + i}`)
	);
}

// Lowest total shortfall for `count` pungs, each a DISTINCT key from `keys` — every pung uses
// its own key so there's no overlap to reason about, making "the N cheapest keys" optimal.
function takeBestDistinctPungsInPoolSoft(counts, keys, count) {
	const options = keys.map((key) => ({ key, deficit: Math.max(0, 3 - (counts[key] || 0)) }));
	options.sort((a, b) => a.deficit - b.deficit);
	let total = 0;
	for (let i = 0; i < count; i++) {
		total += options[i].deficit;
		takeSoft(counts, options[i].key, 3);
	}
	return total;
}

// Lowest-shortfall run of four consecutive ranks (1-4 .. 6-9) within `suit`.
function takeBestFourRunSoft(counts, suit) {
	let best = null;
	for (let r = 1; r <= 6; r++) {
		const trial = cloneCounts(counts);
		const d =
			takeSoft(trial, `${suit}-${r}`, 1) +
			takeSoft(trial, `${suit}-${r + 1}`, 1) +
			takeSoft(trial, `${suit}-${r + 2}`, 1) +
			takeSoft(trial, `${suit}-${r + 3}`, 1);
		if (!best || d < best.deficit) best = { deficit: d, trial };
	}
	Object.assign(counts, best.trial);
	return best.deficit;
}

function distanceWrigglySnake(counts) {
	let best = Infinity;
	for (const suit of SUITS_NUM) {
		const trial = cloneCounts(counts);
		const keys = [...Array.from({ length: 9 }, (_, i) => `${suit}-${i + 1}`), ...WIND_RANKS.map((w) => `wind-${w}`)];
		const d = takeUniqueSetWithOnePairedSoft(trial, keys);
		if (d < best) best = d;
	}
	return best;
}

function distanceRunPungPair(counts) {
	let best = Infinity;
	for (const suit of SUITS_NUM) {
		const base = cloneCounts(counts);
		const runDeficit = takeRunRangeSoft(base, suit, 1, 9);
		for (let pungRank = 1; pungRank <= 9; pungRank++) {
			const t2 = cloneCounts(base);
			const dPung = takeSoft(t2, `${suit}-${pungRank}`, 3);
			for (let pairRank = 1; pairRank <= 9; pairRank++) {
				const t3 = cloneCounts(t2);
				const total = runDeficit + dPung + takeSoft(t3, `${suit}-${pairRank}`, 2);
				if (total < best) best = total;
			}
		}
	}
	return best;
}

function distanceGretasGarden(counts) {
	let best = Infinity;
	for (const suit of SUITS_NUM) {
		const trial = cloneCounts(counts);
		const d = takeRunRangeSoft(trial, suit, 1, 7) + takeEachWindSoft(trial) + takeEachDragonSoft(trial);
		if (d < best) best = d;
	}
	return best;
}

function distanceGretasDragon(counts) {
	let best = Infinity;
	for (const suit of SUITS_NUM) {
		for (const d of DRAGON_RANKS) {
			const trial = cloneCounts(counts);
			const dist = takeRunRangeSoft(trial, suit, 1, 7) + takeEachWindSoft(trial) + takeSoft(trial, `dragon-${d}`, 3);
			if (dist < best) best = dist;
		}
	}
	return best;
}

function distanceGertiesGarter(counts) {
	let best = Infinity;
	for (const suitA of SUITS_NUM) {
		for (const suitB of SUITS_NUM) {
			if (suitA === suitB) continue;
			const trial = cloneCounts(counts);
			const d = takeRunRangeSoft(trial, suitA, 1, 7) + takeRunRangeSoft(trial, suitB, 1, 7);
			if (d < best) best = d;
		}
	}
	return best;
}

function distanceRedLantern(counts, ctx) {
	let best = Infinity;
	for (const suit of SUITS_NUM) {
		const trial = cloneCounts(counts);
		const keys = Array.from({ length: 7 }, (_, i) => `${suit}-${i + 1}`);
		const d = takeUniqueSetWithOnePairedSoft(trial, keys) + takeSoft(trial, `wind-${ctx.seatWind}`, 3) + takeSoft(trial, 'dragon-red', 3);
		if (d < best) best = d;
	}
	return best;
}

function distanceGatesOfHeaven(counts) {
	let best = Infinity;
	for (const suit of SUITS_NUM) {
		const trial = cloneCounts(counts);
		const keys = Array.from({ length: 7 }, (_, i) => `${suit}-${i + 2}`);
		const d = takeUniqueSetWithOnePairedSoft(trial, keys) + takeSoft(trial, `${suit}-1`, 3) + takeSoft(trial, `${suit}-9`, 3);
		if (d < best) best = d;
	}
	return best;
}

function distanceConfusedGates(counts) {
	let best = Infinity;
	for (const suitRun of SUITS_NUM) {
		for (const suit1 of SUITS_NUM) {
			if (suit1 === suitRun) continue;
			for (const suit9 of SUITS_NUM) {
				if (suit9 === suitRun || suit9 === suit1) continue;
				const trial = cloneCounts(counts);
				const keys = Array.from({ length: 7 }, (_, i) => `${suitRun}-${i + 2}`);
				const d = takeUniqueSetWithOnePairedSoft(trial, keys) + takeSoft(trial, `${suit1}-1`, 3) + takeSoft(trial, `${suit9}-9`, 3);
				if (d < best) best = d;
			}
		}
	}
	return best;
}

function distanceWindyChow(counts) {
	const trial = cloneCounts(counts);
	let d = 0;
	for (const suit of SUITS_NUM) d += takeBestChowSoft(trial, suit);
	d += takeUniqueSetWithOnePairedSoft(trial, WIND_RANKS.map((w) => `wind-${w}`));
	return d;
}

// Windy Ones/Nines/Threes/Sevens: the short list doesn't spell out "any Wind paired" here the
// way Windy Chow does, but one wind is doubled to reach 14 tiles — confirmed.
function distanceWindyRank(counts, rank) {
	const trial = cloneCounts(counts);
	let d = takeUniqueSetWithOnePairedSoft(trial, WIND_RANKS.map((w) => `wind-${w}`));
	for (const suit of SUITS_NUM) d += takeSoft(trial, `${suit}-${rank}`, 3);
	return d;
}

function distanceHachiBan(counts) {
	let best = Infinity;
	for (const suit of SUITS_NUM) {
		for (const [lo, hi] of [
			[1, 8],
			[2, 9]
		]) {
			const base = cloneCounts(counts);
			const runDeficit = takeRunRangeSoft(base, suit, lo, hi);
			for (let skip = 0; skip < WIND_RANKS.length; skip++) {
				const t2 = cloneCounts(base);
				let d = runDeficit;
				for (let wi = 0; wi < WIND_RANKS.length; wi++) {
					if (wi === skip) continue;
					d += takeSoft(t2, `wind-${WIND_RANKS[wi]}`, 2);
				}
				if (d < best) best = d;
			}
			const t3 = cloneCounts(base);
			const dDragons = runDeficit + takeSoft(t3, 'dragon-red', 2) + takeSoft(t3, 'dragon-green', 2) + takeSoft(t3, 'dragon-white', 2);
			if (dDragons < best) best = dDragons;
		}
	}
	return best;
}

function distanceFourBlessings(counts) {
	const trial = cloneCounts(counts);
	let d = 0;
	for (const w of WIND_RANKS) d += takeSoft(trial, `wind-${w}`, 3);
	d += takeBestPairInPoolSoft(trial, Object.keys(trial));
	return d;
}

function distanceWindfall(counts) {
	let best = Infinity;
	for (const suit of SUITS_NUM) {
		const trial = cloneCounts(counts);
		const d = takeEachWindSoft(trial) + isExactPairsInSuitSoft(trial, suit, 5);
		if (d < best) best = d;
	}
	return best;
}

function distanceGrandSequence(counts) {
	let best = Infinity;
	for (const suit of SUITS_NUM) {
		const base = cloneCounts(counts);
		const runDeficit = takeRunRangeSoft(base, suit, 1, 9);
		for (const honorKey of [...WIND_RANKS.map((w) => `wind-${w}`), ...DRAGON_RANKS.map((d) => `dragon-${d}`)]) {
			const t2 = cloneCounts(base);
			const d = runDeficit + takeSoft(t2, honorKey, 3) + takeBestPairInSuitsSoft(t2, SUITS_NUM);
			if (d < best) best = d;
		}
	}
	return best;
}

function distanceDragonfly(counts) {
	const base = cloneCounts(counts);
	const dragonDeficit = takeEachDragonSoft(base);
	let best = Infinity;
	for (let r1 = 1; r1 <= 9; r1++) {
		const t1 = cloneCounts(base);
		const d1 = takeSoft(t1, `characters-${r1}`, 3);
		for (let r2 = 1; r2 <= 9; r2++) {
			const t2 = cloneCounts(t1);
			const d2 = takeSoft(t2, `bamboo-${r2}`, 3);
			for (let r3 = 1; r3 <= 9; r3++) {
				const t3 = cloneCounts(t2);
				const d3 = takeSoft(t3, `dots-${r3}`, 3);
				const pairDeficit = takeBestPairInSuitsSoft(t3, SUITS_NUM);
				const total = dragonDeficit + d1 + d2 + d3 + pairDeficit;
				if (total < best) best = total;
			}
		}
	}
	return best;
}

function distanceDragonsBreath(counts) {
	let best = Infinity;
	for (const suit of SUITS_NUM) {
		const base = cloneCounts(counts);
		const d = takeUniqueSetWithOnePairedSoft(base, DRAGON_RANKS.map((dr) => `dragon-${dr}`)) + isExactPairsInSuitSoft(base, suit, 5);
		if (d < best) best = d;
	}
	return best;
}

function distanceWrigglyDragon(counts) {
	let best = Infinity;
	for (const suit of SUITS_NUM) {
		for (const chosen of DRAGON_RANKS) {
			const trial = cloneCounts(counts);
			let d = takeRunRangeSoft(trial, suit, 1, 9);
			for (const dr of DRAGON_RANKS) d += takeSoft(trial, `dragon-${dr}`, dr === chosen ? 3 : 1);
			if (d < best) best = d;
		}
	}
	return best;
}

function distanceAllPairRubyJade(counts) {
	const base = cloneCounts(counts);
	let d = takeSoft(base, 'dragon-green', 2) + takeSoft(base, 'dragon-red', 2);
	const pool = [...RED_BAMBOO_RANKS, ...GREEN_BAMBOO_RANKS].map((r) => `bamboo-${r}`);
	d += takePairsFromPoolSoft(base, pool, 5);
	return d;
}

function distanceSparrowsSanctuary(counts) {
	const trial = cloneCounts(counts);
	let d = takeSoft(trial, 'bamboo-1', 4);
	for (const r of GREEN_BAMBOO_RANKS) d += takeSoft(trial, `bamboo-${r}`, 2);
	return d;
}

function distanceColorDragonSuitHand(counts, dragon, suit) {
	const allRanks = Array.from({ length: 9 }, (_, i) => `${suit}-${i + 1}`);
	let best = Infinity;
	for (const pairKey of allRanks) {
		const trial = cloneCounts(counts);
		let d = takeSoft(trial, `dragon-${dragon}`, 3);
		d += takeSoft(trial, pairKey, 2);
		const pungKeys = allRanks.filter((k) => k !== pairKey);
		d += takeBestDistinctPungsInPoolSoft(trial, pungKeys, 3);
		if (d < best) best = d;
	}
	return best;
}

function distanceThreeGreatScholars(counts) {
	const base = cloneCounts(counts);
	let dragonsDeficit = 0;
	for (const d of DRAGON_RANKS) dragonsDeficit += takeSoft(base, `dragon-${d}`, 3);
	let best = Infinity;
	for (const suit of SUITS_NUM) {
		for (let r = 1; r <= 9; r++) {
			const t2 = cloneCounts(base);
			const dPung = takeSoft(t2, `${suit}-${r}`, 3);
			const dPair = takeBestPairInSuitsSoft(t2, SUITS_NUM);
			const total = dragonsDeficit + dPung + dPair;
			if (total < best) best = total;
		}
		for (let r = 1; r <= 7; r++) {
			const t2 = cloneCounts(base);
			const dChow = takeChowSoft(t2, suit, r);
			const dPair = takeBestPairInSuitsSoft(t2, SUITS_NUM);
			const total = dragonsDeficit + dChow + dPair;
			if (total < best) best = total;
		}
	}
	return best;
}

function distanceGuardianDragon(counts) {
	let best = Infinity;
	for (const suit of SUITS_NUM) {
		const base = cloneCounts(counts);
		const runDeficit = takeRunRangeSoft(base, suit, 1, 9);
		for (const pungD of DRAGON_RANKS) {
			for (const pairD of DRAGON_RANKS) {
				if (pungD === pairD) continue;
				const t2 = cloneCounts(base);
				const d = runDeficit + takeSoft(t2, `dragon-${pungD}`, 3) + takeSoft(t2, `dragon-${pairD}`, 2);
				if (d < best) best = d;
			}
		}
	}
	return best;
}

function distanceUniqueWonder(counts) {
	const keys = [
		...WIND_RANKS.map((w) => `wind-${w}`),
		...DRAGON_RANKS.map((d) => `dragon-${d}`),
		...SUITS_NUM.flatMap((s) => [`${s}-1`, `${s}-9`])
	];
	return takeUniqueSetWithOnePairedSoft(cloneCounts(counts), keys);
}

function distanceFiveOddHonours(counts) {
	const honorKeys = [...WIND_RANKS.map((w) => `wind-${w}`), ...DRAGON_RANKS.map((d) => `dragon-${d}`)];
	let best = Infinity;
	for (const suit of SUITS_NUM) {
		const base = cloneCounts(counts);
		const runDeficit = takeRunRangeSoft(base, suit, 1, 9);
		const options = honorKeys.map((k) => ((base[k] || 0) >= 1 ? 0 : 1)).sort((a, b) => a - b);
		let honorDeficit = 0;
		for (let i = 0; i < 5; i++) honorDeficit += options[i];
		const d = runDeficit + honorDeficit;
		if (d < best) best = d;
	}
	return best;
}

function distanceDragonsTail(counts) {
	let best = Infinity;
	for (const suit of SUITS_NUM) {
		const base = cloneCounts(counts);
		const runDeficit = takeRunRangeSoft(base, suit, 1, 9);
		for (const d of DRAGON_RANKS) {
			for (const w of WIND_RANKS) {
				const t2 = cloneCounts(base);
				const dist1 = runDeficit + takeSoft(t2, `dragon-${d}`, 3) + takeSoft(t2, `wind-${w}`, 2);
				if (dist1 < best) best = dist1;
				const t3 = cloneCounts(base);
				const dist2 = runDeficit + takeSoft(t3, `wind-${w}`, 3) + takeSoft(t3, `dragon-${d}`, 2);
				if (dist2 < best) best = dist2;
			}
		}
	}
	return best;
}

function distanceHoveringAngel(counts, ctx) {
	const base = cloneCounts(counts);
	let d = takeSoft(base, `wind-${ctx.seatWind}`, 3);
	for (const suit of SUITS_NUM) d += takeBestChowSoft(base, suit);
	let best = Infinity;
	for (const dr of DRAGON_RANKS) {
		const t2 = cloneCounts(base);
		const dist = d + takeSoft(t2, `dragon-${dr}`, 2);
		if (dist < best) best = dist;
	}
	return best;
}

function distanceHeavenlyTwins(counts) {
	let best = Infinity;
	for (const suit of SUITS_NUM) {
		const d = isExactPairsInSuitSoft(cloneCounts(counts), suit, 7);
		if (d < best) best = d;
	}
	return best;
}

// "All Pair" (500) vs "All Pair Honours" (1000): read as plain Seven Pairs (any tiles) vs.
// the stricter version where every pair must be a terminal/Wind/Dragon — best-effort reading
// of two short-list rows that would otherwise look like the same hand.
function distanceAllPair(counts) {
	const allKeys = [
		...SUITS_NUM.flatMap((s) => Array.from({ length: 9 }, (_, i) => `${s}-${i + 1}`)),
		...WIND_RANKS.map((w) => `wind-${w}`),
		...DRAGON_RANKS.map((d) => `dragon-${d}`)
	];
	return takePairsFromPoolSoft(cloneCounts(counts), allKeys, 7);
}

function distanceAllPairHonours(counts) {
	const pool = [
		...WIND_RANKS.map((w) => `wind-${w}`),
		...DRAGON_RANKS.map((d) => `dragon-${d}`),
		...SUITS_NUM.flatMap((s) => [`${s}-1`, `${s}-9`])
	];
	return takePairsFromPoolSoft(cloneCounts(counts), pool, 7);
}

// Knitting: seven distinct numbers, each held as a pair confined to one of two chosen suits
// (no third suit, no honors) — confirmed: "7 pairs same number in 2 suits", each individual
// pair same-suit.
function distanceKnitting(counts) {
	let best = Infinity;
	for (const suitA of SUITS_NUM) {
		for (const suitB of SUITS_NUM) {
			if (suitA === suitB) continue;
			const options = [];
			for (let r = 1; r <= 9; r++) {
				const dA = Math.max(0, 2 - (counts[`${suitA}-${r}`] || 0));
				const dB = Math.max(0, 2 - (counts[`${suitB}-${r}`] || 0));
				options.push(Math.min(dA, dB));
			}
			options.sort((a, b) => a - b);
			let d = 0;
			for (let i = 0; i < 7; i++) d += options[i];
			if (d < best) best = d;
		}
	}
	return best;
}

// Triple Knitting: four numbers each held once in all three suits, plus one same-suit pair —
// confirmed: "4 sets same number in 3 suits + knitting pair".
function distanceTripleKnitting(counts) {
	const trial = cloneCounts(counts);
	const rankCosts = [];
	for (let r = 1; r <= 9; r++) {
		let cost = 0;
		for (const s of SUITS_NUM) cost += Math.max(0, 1 - (trial[`${s}-${r}`] || 0));
		rankCosts.push({ r, cost });
	}
	rankCosts.sort((a, b) => a.cost - b.cost);
	let d = 0;
	for (let i = 0; i < 4; i++) {
		d += rankCosts[i].cost;
		for (const s of SUITS_NUM) takeSoft(trial, `${s}-${rankCosts[i].r}`, 1);
	}
	d += takeBestPairInPoolSoft(trial, Object.keys(trial));
	return d;
}

// Big Robert: best-effort reading, FLAGGED for a closer look at page 14 — a run of four
// consecutive numbers in each suit, plus a pair of a Wind or Dragon. The book's "(if Numbers
// same = L)" limit-hand bonus isn't applied. There may also be a distinct "Little Robert"
// (500/200, "Chow in each suit + P/K + Pr in any suit") that this short-list entry relates
// to — unconfirmed, and that pattern doesn't obviously match "Big Robert" as coded here.
function distanceBigRobert(counts) {
	const base = cloneCounts(counts);
	let d = 0;
	for (const suit of SUITS_NUM) d += takeBestFourRunSoft(base, suit);
	d += takeBestPairInPoolSoft(base, [...WIND_RANKS.map((w) => `wind-${w}`), ...DRAGON_RANKS.map((dr) => `dragon-${dr}`)]);
	return d;
}

// Moon at Bottom of Well: "three in ascending order" = a Run 1-9 (123, 456, 789), plus a
// fourth chow and a pair on top of that, all in Dots.
function distanceMoonAtBottomOfWell(counts) {
	const suit = 'dots';
	const base = cloneCounts(counts);
	const runDeficit = takeRunRangeSoft(base, suit, 1, 9);
	let best = Infinity;
	for (let cr = 1; cr <= 7; cr++) {
		const t2 = cloneCounts(base);
		const dChow = takeChowSoft(t2, suit, cr);
		const dPair = takeBestPairInSuitsSoft(t2, [suit]);
		const total = runDeficit + dChow + dPair;
		if (total < best) best = total;
	}
	return best;
}

// ---------- Full List (The Mah Jong Player's Companion, "Full Synopsis of Special Hands",
// pp.56-60) ----------
// Adds ~45 more named hands on top of the Short List above. A blanket simplification here:
// wherever the book writes "P/K" without an explicit "X/X" alternative, this only checks for
// a pung-worth (3) in the tally, which is capped at 3 for any declared kong anyway — the only
// gap is a kong's worth (4) sitting fully concealed and never declared, which is rare enough
// to accept as a known simplification rather than doubling every check in this section.

const CORRESPONDING_DRAGON = { characters: 'red', bamboo: 'green', dots: 'white' };
const ODD_RANKS = [1, 3, 5, 7, 9];
const EVEN_RANKS = [2, 4, 6, 8];
const BLUE_CIRCLE_RANKS = [2, 3, 4, 5, 8, 9];

function distanceGuardianWinds(counts) {
	let best = Infinity;
	for (const suit of SUITS_NUM) {
		const base = cloneCounts(counts);
		const runDeficit = takeRunRangeSoft(base, suit, 1, 9);
		for (const pungW of WIND_RANKS) {
			for (const pairW of WIND_RANKS) {
				if (pungW === pairW) continue;
				const t2 = cloneCounts(base);
				const d = runDeficit + takeSoft(t2, `wind-${pungW}`, 3) + takeSoft(t2, `wind-${pairW}`, 2);
				if (d < best) best = d;
			}
		}
	}
	return best;
}

function distanceDragonsGates(counts) {
	let best = Infinity;
	for (const suit of SUITS_NUM) {
		const base = cloneCounts(counts);
		const keys = Array.from({ length: 7 }, (_, i) => `${suit}-${i + 2}`);
		const baseDeficit = takeUniqueSetWithOnePairedSoft(base, keys);
		const dragon = CORRESPONDING_DRAGON[suit];
		for (const terminal of [1, 9]) {
			const t2 = cloneCounts(base);
			const d = baseDeficit + takeSoft(t2, `${suit}-${terminal}`, 3) + takeSoft(t2, `dragon-${dragon}`, 3);
			if (d < best) best = d;
		}
	}
	return best;
}

function distanceDragonsTeeth(counts) {
	let best = Infinity;
	for (const suit of ['characters', 'dots']) {
		const base = cloneCounts(counts);
		const dragonsDeficit = takeSoft(base, 'dragon-red', 3) + takeSoft(base, 'dragon-white', 3);
		for (const lo of [1, 2]) {
			const t2 = cloneCounts(base);
			const keys = Array.from({ length: 7 }, (_, i) => `${suit}-${lo + i}`);
			const d = dragonsDeficit + takeUniqueSetWithOnePairedSoft(t2, keys);
			if (d < best) best = d;
		}
	}
	return best;
}

function distanceYinYang(counts) {
	let best = Infinity;
	for (const suitA of SUITS_NUM) {
		for (const suitB of SUITS_NUM) {
			if (suitA === suitB) continue;
			const trial = cloneCounts(counts);
			const d =
				takeSoft(trial, `${suitA}-1`, 2) +
				takeSoft(trial, `${suitA}-2`, 1) +
				takeSoft(trial, `${suitA}-3`, 1) +
				takeSoft(trial, `${suitA}-4`, 1) +
				takeSoft(trial, `${suitA}-5`, 2) +
				takeSoft(trial, `${suitB}-5`, 2) +
				takeSoft(trial, `${suitB}-6`, 1) +
				takeSoft(trial, `${suitB}-7`, 1) +
				takeSoft(trial, `${suitB}-8`, 1) +
				takeSoft(trial, `${suitB}-9`, 2);
			if (d < best) best = d;
		}
	}
	return best;
}

function distanceThreePhilosophers(counts) {
	const base = cloneCounts(counts);
	let d = 0;
	for (const suit of SUITS_NUM) d += takeBestChowSoft(base, suit);
	let best = Infinity;
	for (const suit of SUITS_NUM) {
		for (let r = 1; r <= 7; r++) {
			const t2 = cloneCounts(base);
			const dChow = takeChowSoft(t2, suit, r);
			const dPair = takeBestPairInSuitsSoft(t2, SUITS_NUM);
			const total = d + dChow + dPair;
			if (total < best) best = total;
		}
	}
	return best;
}

function distanceCrazyChows(counts, ctx, maxDistance) {
	function search(remainingChows, trial, soFar) {
		if (soFar > maxDistance) return Infinity;
		if (remainingChows === 0) return soFar + takeBestPairInSuitsSoft(trial, SUITS_NUM);
		let best = Infinity;
		for (const suit of SUITS_NUM) {
			for (let r = 1; r <= 7; r++) {
				const t2 = cloneCounts(trial);
				const d = takeChowSoft(t2, suit, r);
				const total = search(remainingChows - 1, t2, soFar + d);
				if (total < best) best = total;
			}
		}
		return best;
	}
	return search(4, cloneCounts(counts), 0);
}

function distanceLittleRobert(counts) {
	const base = cloneCounts(counts);
	let d = 0;
	for (const suit of SUITS_NUM) d += takeBestChowSoft(base, suit);
	let best = Infinity;
	for (const suit of SUITS_NUM) {
		for (let r = 1; r <= 9; r++) {
			const t2 = cloneCounts(base);
			const dPung = takeSoft(t2, `${suit}-${r}`, 3);
			const dPair = takeBestPairInSuitsSoft(t2, SUITS_NUM);
			const total = d + dPung + dPair;
			if (total < best) best = total;
		}
	}
	return best;
}

function distanceChowRankTriple(counts, startRank) {
	const trial = cloneCounts(counts);
	let d = 0;
	for (const suit of SUITS_NUM) d += takeChowSoft(trial, suit, startRank);
	d += takeUniqueSetWithOnePairedSoft(trial, WIND_RANKS.map((w) => `wind-${w}`));
	return d;
}

function distanceChopSuey(counts) {
	return distanceChowRankTriple(counts, 1);
}

function distanceChowMien(counts) {
	return distanceChowRankTriple(counts, 7);
}

function distanceLittleBrother(counts, ctx) {
	const base = cloneCounts(counts);
	let d = 0;
	for (const suit of SUITS_NUM) d += takeBestChowSoft(base, suit);
	d += takeSoft(base, `wind-${ctx.seatWind}`, 2);
	d += takeBestChowAcrossSuitsSoft(base, SUITS_NUM);
	return d;
}

function distanceAppleBlossom(counts, ctx, maxDistance) {
	function search(remainingChows, trial, soFar) {
		if (soFar > maxDistance) return Infinity;
		if (remainingChows === 0) return soFar + takeSoft(trial, 'dragon-white', 3) + takeSoft(trial, 'dragon-green', 2);
		let best = Infinity;
		for (const suit of SUITS_NUM) {
			for (let r = 1; r <= 7; r++) {
				const t2 = cloneCounts(trial);
				const d = takeChowSoft(t2, suit, r);
				const total = search(remainingChows - 1, t2, soFar + d);
				if (total < best) best = total;
			}
		}
		return best;
	}
	return search(3, cloneCounts(counts), 0);
}

function distanceTheProfessors(counts, ctx, maxDistance) {
	function search(remainingChows, trial, soFar) {
		if (soFar > maxDistance) return Infinity;
		if (remainingChows === 0) return soFar + takeEachDragonSoft(trial) + takeSoft(trial, `wind-${ctx.seatWind}`, 2);
		let best = Infinity;
		for (const suit of SUITS_NUM) {
			for (let r = 1; r <= 7; r++) {
				const t2 = cloneCounts(trial);
				const d = takeChowSoft(t2, suit, r);
				const total = search(remainingChows - 1, t2, soFar + d);
				if (total < best) best = total;
			}
		}
		return best;
	}
	return search(3, cloneCounts(counts), 0);
}

// Chow Chow requires the whole hand to have come from self-drawn wall tiles with no calls,
// ending on the last tile in the wall. `ctx.selfDraw`/`ctx.wonWithLastWallTile` are only set
// when scoring an actual win (see applySpecialWinnerScore) — in a fishing/preview check
// they're undefined, so only the concealment/shape requirement (knowable in advance) applies.
function distanceChowChow(counts, ctx, maxDistance) {
	if (!ctx.player || !ctx.player.melds.every((m) => m.concealed)) return Infinity;
	if (ctx.selfDraw === false || ctx.wonWithLastWallTile === false) return Infinity;
	let best = Infinity;
	for (const suit of SUITS_NUM) {
		function search(remainingChows, trial, soFar) {
			if (soFar > maxDistance) return Infinity;
			if (remainingChows === 0) return soFar + takeBestPairInSuitsSoft(trial, [suit]);
			let localBest = Infinity;
			for (let r = 1; r <= 7; r++) {
				const t2 = cloneCounts(trial);
				const d = takeChowSoft(t2, suit, r);
				const total = search(remainingChows - 1, t2, soFar + d);
				if (total < localBest) localBest = total;
			}
			return localBest;
		}
		const d = search(4, cloneCounts(counts), 0);
		if (d < best) best = d;
	}
	return best;
}

function distanceOddsAndEvens(counts) {
	let best = Infinity;
	for (const evenSuit of SUITS_NUM) {
		const oddSuits = SUITS_NUM.filter((s) => s !== evenSuit);
		const trial = cloneCounts(counts);
		let d = 0;
		for (const suit of oddSuits) for (const r of ODD_RANKS) d += takeSoft(trial, `${suit}-${r}`, 1);
		for (const r of EVEN_RANKS) d += takeSoft(trial, `${evenSuit}-${r}`, 1);
		if (d < best) best = d;
	}
	return best;
}

function distanceHeadsAndTails(counts) {
	const terminalKeys = SUITS_NUM.flatMap((s) => [`${s}-1`, `${s}-9`]);
	let best = Infinity;
	for (const pairKey of terminalKeys) {
		const trial = cloneCounts(counts);
		const pairDeficit = takeSoft(trial, pairKey, 2);
		const pungKeys = terminalKeys.filter((k) => k !== pairKey);
		const pungDeficit = takeBestDistinctPungsInPoolSoft(trial, pungKeys, 4);
		const total = pairDeficit + pungDeficit;
		if (total < best) best = total;
	}
	return best;
}

function distanceRobin(counts) {
	let best = Infinity;
	for (const suitA of SUITS_NUM) {
		for (const suitB of SUITS_NUM) {
			if (suitB === suitA) continue;
			const suitC = SUITS_NUM.find((s) => s !== suitA && s !== suitB);
			for (let ra = 1; ra <= 7; ra++) {
				const t1 = cloneCounts(counts);
				const dA = takeChowSoft(t1, suitA, ra);
				for (let rb1 = 1; rb1 <= 7; rb1++) {
					const t2 = cloneCounts(t1);
					const dB1 = takeChowSoft(t2, suitB, rb1);
					for (let rb2 = 1; rb2 <= 7; rb2++) {
						const t3 = cloneCounts(t2);
						const dB2 = takeChowSoft(t3, suitB, rb2);
						for (let rc = 1; rc <= 7; rc++) {
							const t4 = cloneCounts(t3);
							const dC = takeChowSoft(t4, suitC, rc);
							const dPair = takeBestPairInSuitsSoft(t4, [suitC]);
							const total = dA + dB1 + dB2 + dC + dPair;
							if (total < best) best = total;
						}
					}
				}
			}
		}
	}
	return best;
}

function distanceAllPairJade(counts) {
	const optionA = cloneCounts(counts);
	const dA = takeSoft(optionA, 'dragon-green', 2) + takePairsFromPoolSoft(optionA, GREEN_BAMBOO_RANKS.map((r) => `bamboo-${r}`), 6);
	const optionB = cloneCounts(counts);
	const dB = takeSoft(optionB, 'dragon-green', 4) + takePairsFromPoolSoft(optionB, GREEN_BAMBOO_RANKS.map((r) => `bamboo-${r}`), 5);
	return Math.min(dA, dB);
}

function distanceImperialJade(counts, ctx, maxDistance) {
	const base = cloneCounts(counts);
	const dragonDeficit = takeSoft(base, 'dragon-green', 3);
	function search(remaining, trial, soFar, chowUsed) {
		if (soFar > maxDistance) return Infinity;
		if (remaining === 0) return soFar + takeBestPairInPoolSoft(trial, GREEN_BAMBOO_RANKS.map((r) => `bamboo-${r}`));
		let localBest = Infinity;
		for (let r = 1; r <= 9; r++) {
			const t2 = cloneCounts(trial);
			const d = takeSoft(t2, `bamboo-${r}`, 3);
			const total = search(remaining - 1, t2, soFar + d, chowUsed);
			if (total < localBest) localBest = total;
		}
		if (!chowUsed) {
			for (let r = 1; r <= 7; r++) {
				const t2 = cloneCounts(trial);
				const d = takeChowSoft(t2, 'bamboo', r);
				const total = search(remaining - 1, t2, soFar + d, true);
				if (total < localBest) localBest = total;
			}
		}
		return localBest;
	}
	return search(3, base, dragonDeficit, false);
}

function distanceLilyOfTheValley(counts) {
	const allBambooRanks = Array.from({ length: 9 }, (_, i) => `bamboo-${i + 1}`);
	let best = Infinity;
	for (const pairKey of GREEN_BAMBOO_RANKS.map((r) => `bamboo-${r}`)) {
		const trial = cloneCounts(counts);
		let d = takeSoft(trial, 'dragon-green', 3) + takeSoft(trial, 'dragon-white', 3);
		d += takeSoft(trial, pairKey, 2);
		const pungKeys = allBambooRanks.filter((k) => k !== pairKey);
		d += takeBestDistinctPungsInPoolSoft(trial, pungKeys, 2);
		if (d < best) best = d;
	}
	return best;
}

function distanceRedLily(counts) {
	const allBambooRanks = Array.from({ length: 9 }, (_, i) => `bamboo-${i + 1}`);
	let best = Infinity;
	for (const pairKey of RED_BAMBOO_RANKS.map((r) => `bamboo-${r}`)) {
		const trial = cloneCounts(counts);
		let d = takeSoft(trial, 'dragon-red', 3) + takeSoft(trial, 'dragon-white', 3);
		d += takeSoft(trial, pairKey, 2);
		const pungKeys = allBambooRanks.filter((k) => k !== pairKey);
		d += takeBestDistinctPungsInPoolSoft(trial, pungKeys, 2);
		if (d < best) best = d;
	}
	return best;
}

function distanceRoyalRuby(counts) {
	const allBambooRanks = Array.from({ length: 9 }, (_, i) => `bamboo-${i + 1}`);
	let best = Infinity;
	for (const pairKey of RED_BAMBOO_RANKS.map((r) => `bamboo-${r}`)) {
		const trial = cloneCounts(counts);
		let d = takeSoft(trial, 'dragon-red', 3);
		d += takeSoft(trial, pairKey, 2);
		const pungKeys = allBambooRanks.filter((k) => k !== pairKey);
		d += takeBestDistinctPungsInPoolSoft(trial, pungKeys, 3);
		if (d < best) best = d;
	}
	return best;
}

function distanceRubyJade(counts) {
	const allBambooRanks = Array.from({ length: 9 }, (_, i) => `bamboo-${i + 1}`);
	const pairPool = [...RED_BAMBOO_RANKS, ...GREEN_BAMBOO_RANKS].map((r) => `bamboo-${r}`);
	let best = Infinity;
	for (const pairKey of pairPool) {
		const trial = cloneCounts(counts);
		let d = takeSoft(trial, 'dragon-red', 3) + takeSoft(trial, 'dragon-green', 3);
		d += takeSoft(trial, pairKey, 2);
		const pungKeys = allBambooRanks.filter((k) => k !== pairKey);
		d += takeBestDistinctPungsInPoolSoft(trial, pungKeys, 2);
		if (d < best) best = d;
	}
	return best;
}

function distanceLillypilly(counts) {
	const allDotsRanks = Array.from({ length: 9 }, (_, i) => `dots-${i + 1}`);
	const trial = cloneCounts(counts);
	let d = takeSoft(trial, 'dragon-green', 3) + takeSoft(trial, 'dragon-white', 2);
	d += takeBestDistinctPungsInPoolSoft(trial, allDotsRanks, 3);
	return d;
}

function distanceBlueMountains(counts) {
	const allDotsRanks = Array.from({ length: 9 }, (_, i) => `dots-${i + 1}`);
	let best = Infinity;
	for (const pairKey of BLUE_CIRCLE_RANKS.map((r) => `dots-${r}`)) {
		const trial = cloneCounts(counts);
		let d = takeSoft(trial, 'dragon-green', 3);
		d += takeSoft(trial, pairKey, 2);
		const pungKeys = allDotsRanks.filter((k) => k !== pairKey);
		d += takeBestDistinctPungsInPoolSoft(trial, pungKeys, 3);
		if (d < best) best = d;
	}
	return best;
}

function distanceWhiteElephant(counts) {
	const allDotsRanks = Array.from({ length: 9 }, (_, i) => `dots-${i + 1}`);
	let best = Infinity;
	for (const pairKey of EVEN_RANKS.map((r) => `dots-${r}`)) {
		const trial = cloneCounts(counts);
		let d = takeSoft(trial, 'dragon-white', 3);
		d += takeSoft(trial, pairKey, 2);
		const pungKeys = allDotsRanks.filter((k) => k !== pairKey);
		d += takeBestDistinctPungsInPoolSoft(trial, pungKeys, 3);
		if (d < best) best = d;
	}
	return best;
}

function distanceDrivenSnow(counts) {
	const allCharRanks = Array.from({ length: 9 }, (_, i) => `characters-${i + 1}`);
	let best = Infinity;
	for (const pairKey of ODD_RANKS.map((r) => `characters-${r}`)) {
		const trial = cloneCounts(counts);
		let d = takeSoft(trial, 'dragon-white', 3);
		d += takeSoft(trial, pairKey, 2);
		const pungKeys = allCharRanks.filter((k) => k !== pairKey);
		d += takeBestDistinctPungsInPoolSoft(trial, pungKeys, 3);
		if (d < best) best = d;
	}
	return best;
}

function distanceDragonsScales(counts) {
	const allCharRanks = Array.from({ length: 9 }, (_, i) => `characters-${i + 1}`);
	let best = Infinity;
	for (const pairKey of EVEN_RANKS.map((r) => `characters-${r}`)) {
		const trial = cloneCounts(counts);
		let d = takeSoft(trial, 'dragon-red', 3);
		d += takeSoft(trial, pairKey, 2);
		const pungKeys = allCharRanks.filter((k) => k !== pairKey);
		d += takeBestDistinctPungsInPoolSoft(trial, pungKeys, 3);
		if (d < best) best = d;
	}
	return best;
}

function distanceDragonette(counts) {
	let best = Infinity;
	for (const suit of SUITS_NUM) {
		const trial = cloneCounts(counts);
		let d = takeEachWindSoft(trial);
		d += takeUniqueSetWithOnePairedSoft(trial, DRAGON_RANKS.map((dr) => `dragon-${dr}`));
		const nonTerminalKeys = Array.from({ length: 7 }, (_, i) => `${suit}-${i + 2}`);
		d += takePairsFromPoolSoft(trial, nonTerminalKeys, 3);
		if (d < best) best = d;
	}
	return best;
}

function distanceDragonsRun(counts) {
	let best = Infinity;
	for (const suit of SUITS_NUM) {
		const base = cloneCounts(counts);
		const d0 = takeRunRangeSoft(base, suit, 1, 9) + takeEachDragonSoft(base);
		for (const w of WIND_RANKS) {
			const t2 = cloneCounts(base);
			const d = d0 + takeSoft(t2, `wind-${w}`, 2);
			if (d < best) best = d;
		}
	}
	return best;
}

function distanceSunrise(counts) {
	const base = cloneCounts(counts);
	let d = takeSoft(base, 'wind-E', 3) + takeSoft(base, 'dragon-white', 2);
	for (const suit of SUITS_NUM) d += takeBestPungInSuitRangeSoft(base, suit, 2, 8);
	return d;
}

function distanceSunset(counts) {
	const base = cloneCounts(counts);
	let d = takeSoft(base, 'wind-W', 3) + takeSoft(base, 'dragon-red', 2);
	for (const suit of SUITS_NUM) d += takeBestPungInSuitRangeSoft(base, suit, 2, 8);
	return d;
}

function distanceNumbersInParallel(counts) {
	const honorKeys = [...WIND_RANKS.map((w) => `wind-${w}`), ...DRAGON_RANKS.map((d) => `dragon-${d}`)];
	let best = Infinity;
	for (const pungHonor of honorKeys) {
		for (const pairHonor of honorKeys) {
			if (pungHonor === pairHonor) continue;
			const base = cloneCounts(counts);
			const d0 = takeSoft(base, pungHonor, 3) + takeSoft(base, pairHonor, 2);
			for (let r = 2; r <= 8; r++) {
				const t2 = cloneCounts(base);
				let d = d0;
				for (const suit of SUITS_NUM) d += takeSoft(t2, `${suit}-${r}`, 3);
				if (d < best) best = d;
			}
		}
	}
	return best;
}

// Best-effort reading: "Two P/K of same number in two suits" is taken as two separate
// number/suit-pair groups (four melds total), since the stated pieces alone don't add up to
// 14 tiles otherwise.
function distanceNumbersDoubled(counts) {
	const honorKeys = [...WIND_RANKS.map((w) => `wind-${w}`), ...DRAGON_RANKS.map((d) => `dragon-${d}`)];
	const suitPairs = [
		[SUITS_NUM[0], SUITS_NUM[1]],
		[SUITS_NUM[0], SUITS_NUM[2]],
		[SUITS_NUM[1], SUITS_NUM[2]]
	];
	let best = Infinity;
	for (const pairHonor of honorKeys) {
		const base = cloneCounts(counts);
		const d0 = takeSoft(base, pairHonor, 2);
		for (let rA = 2; rA <= 8; rA++) {
			for (let rB = 2; rB <= 8; rB++) {
				if (rA === rB) continue;
				for (const [s1, s2] of suitPairs) {
					for (const [s3, s4] of suitPairs) {
						const t2 = cloneCounts(base);
						const d =
							d0 +
							takeSoft(t2, `${s1}-${rA}`, 3) +
							takeSoft(t2, `${s2}-${rA}`, 3) +
							takeSoft(t2, `${s3}-${rB}`, 3) +
							takeSoft(t2, `${s4}-${rB}`, 3);
						if (d < best) best = d;
					}
				}
			}
		}
	}
	return best;
}

function distanceChineseOdds(counts) {
	let best = Infinity;
	for (const suit of SUITS_NUM) {
		const oddKeys = ODD_RANKS.map((r) => `${suit}-${r}`);
		for (const pairKey of oddKeys) {
			const trial = cloneCounts(counts);
			const pairDeficit = takeSoft(trial, pairKey, 2);
			const pungKeys = oddKeys.filter((k) => k !== pairKey);
			const pungDeficit = takeBestDistinctPungsInPoolSoft(trial, pungKeys, 4);
			const total = pairDeficit + pungDeficit;
			if (total < best) best = total;
		}
	}
	return best;
}

// Seven Twins is All Pair's shape plus the "all tiles from wall inc. last" procedural
// requirement — see the Chow Chow comment above for how that's checked.
function distanceSevenTwins(counts, ctx) {
	if (!ctx.player || !ctx.player.melds.every((m) => m.concealed)) return Infinity;
	if (ctx.selfDraw === false || ctx.wonWithLastWallTile === false) return Infinity;
	return distanceAllPair(counts);
}

function distanceGoldenGates(counts) {
	let best = Infinity;
	for (const suit of SUITS_NUM) {
		const dragon = CORRESPONDING_DRAGON[suit];
		const trial = cloneCounts(counts);
		let d0 = 0;
		for (const r of [2, 4, 6, 8]) d0 += takeSoft(trial, `${suit}-${r}`, 2);
		for (const terminal of [1, 9]) {
			const t2 = cloneCounts(trial);
			const d = d0 + takeSoft(t2, `${suit}-${terminal}`, 3) + takeSoft(t2, `dragon-${dragon}`, 3);
			if (d < best) best = d;
		}
	}
	return best;
}

function distanceWindyDragons(counts) {
	const base = cloneCounts(counts);
	let d0 = 0;
	for (const w of WIND_RANKS) d0 += takeSoft(base, `wind-${w}`, 2);
	let best = Infinity;
	for (let i = 0; i < DRAGON_RANKS.length; i++) {
		for (let j = i + 1; j < DRAGON_RANKS.length; j++) {
			const t2 = cloneCounts(base);
			const d = d0 + takeSoft(t2, `dragon-${DRAGON_RANKS[i]}`, 3) + takeSoft(t2, `dragon-${DRAGON_RANKS[j]}`, 3);
			if (d < best) best = d;
		}
	}
	return best;
}

function distanceWindvane(counts) {
	const trial = cloneCounts(counts);
	let d = takeUniqueSetWithOnePairedSoft(trial, WIND_RANKS.map((w) => `wind-${w}`));
	for (const suit of SUITS_NUM) d += takeBestDistinctPungsInPoolSoft(trial, Array.from({ length: 9 }, (_, i) => `${suit}-${i + 1}`), 1);
	return d;
}

function distanceCivilWar(counts) {
	let best = Infinity;
	for (const suitA of SUITS_NUM) {
		for (const suitB of SUITS_NUM) {
			if (suitA === suitB) continue;
			const trial = cloneCounts(counts);
			const d =
				takeSoft(trial, 'wind-N', 3) +
				takeSoft(trial, 'wind-S', 3) +
				takeSoft(trial, `${suitA}-1`, 2) +
				takeSoft(trial, `${suitA}-8`, 1) +
				takeSoft(trial, `${suitA}-6`, 1) +
				takeSoft(trial, `${suitB}-1`, 1) +
				takeSoft(trial, `${suitB}-8`, 1) +
				takeSoft(trial, `${suitB}-6`, 1) +
				takeSoft(trial, `${suitB}-5`, 1);
			if (d < best) best = d;
		}
	}
	return best;
}

// Up You Go / Down You Go need the kong's literal 4th tile (their 14-tile shape isn't the
// usual "4 melds + pair", so a kong here isn't just an interchangeable pung) — the general
// tally caps every kong at 3, so once a real concealed kong is confirmed we restore the tile
// the cap dropped before computing distance. Because a concealed kong must already be
// declared (knowable now, not a future possibility), these only ever show up once that's
// happened — same treatment as Chow Chow's concealment check above.
function distanceUpYouGo(counts, ctx) {
	if (!ctx.player) return Infinity;
	let best = Infinity;
	for (const suit of SUITS_NUM) {
		const hasConcealedKong = ctx.player.melds.some((m) => m.type === 'kong' && m.concealed && m.tiles[0].suit === suit && m.tiles[0].rank === 8);
		if (!hasConcealedKong) continue;
		const trial = cloneCounts(counts);
		trial[`${suit}-8`] = (trial[`${suit}-8`] || 0) + 1;
		const d =
			takeEachWindSoft(trial) +
			takeSoft(trial, `${suit}-2`, 1) +
			takeSoft(trial, `${suit}-4`, 2) +
			takeSoft(trial, `${suit}-6`, 3) +
			takeSoft(trial, `${suit}-8`, 4);
		if (d < best) best = d;
	}
	return best;
}

function distanceDownYouGo(counts, ctx) {
	if (!ctx.player) return Infinity;
	let best = Infinity;
	for (const suit of SUITS_NUM) {
		const hasConcealedKong = ctx.player.melds.some((m) => m.type === 'kong' && m.concealed && m.tiles[0].suit === suit && m.tiles[0].rank === 2);
		if (!hasConcealedKong) continue;
		const trial = cloneCounts(counts);
		trial[`${suit}-2`] = (trial[`${suit}-2`] || 0) + 1;
		const d =
			takeEachWindSoft(trial) +
			takeSoft(trial, `${suit}-2`, 4) +
			takeSoft(trial, `${suit}-4`, 3) +
			takeSoft(trial, `${suit}-6`, 2) +
			takeSoft(trial, `${suit}-8`, 1);
		if (d < best) best = d;
	}
	return best;
}

function distanceRedWaratah(counts) {
	const base = cloneCounts(counts);
	const d = takeSoft(base, 'dragon-red', 3) + takeSoft(base, 'dragon-green', 2);
	let best = Infinity;
	for (const redBambooRank of RED_BAMBOO_RANKS) {
		const t2 = cloneCounts(base);
		const dBamboo = takeSoft(t2, `bamboo-${redBambooRank}`, 3);
		const dDotsPung = takeBestDistinctPungsInPoolSoft(t2, Array.from({ length: 9 }, (_, i) => `dots-${i + 1}`), 1);
		const dCharPung = takeBestDistinctPungsInPoolSoft(t2, Array.from({ length: 9 }, (_, i) => `characters-${i + 1}`), 1);
		const total = d + dBamboo + dDotsPung + dCharPung;
		if (total < best) best = total;
	}
	return best;
}

function distanceAllWindsAndDragons(counts) {
	const honorKeys = [...WIND_RANKS.map((w) => `wind-${w}`), ...DRAGON_RANKS.map((d) => `dragon-${d}`)];
	let best = Infinity;
	for (const pairKey of honorKeys) {
		const trial = cloneCounts(counts);
		const pairDeficit = takeSoft(trial, pairKey, 2);
		const pungKeys = honorKeys.filter((k) => k !== pairKey);
		const pungDeficit = takeBestDistinctPungsInPoolSoft(trial, pungKeys, 4);
		const total = pairDeficit + pungDeficit;
		if (total < best) best = total;
	}
	return best;
}

import { SHORT_LIST_HANDS, FULL_LIST_EXTRA_HANDS } from './src/lib/specialHandsData.js';

// Maps each named hand to its scoring/distance function by name. Display metadata (scores,
// description) lives in src/lib/specialHandsData.js, the single source of truth shared with
// the client's static reference pages, so the two can never drift out of sync.
const DISTANCE_FNS = {
	'Wriggly Snake': (c) => distanceWrigglySnake(c),
	'Run, Pung & Pair': (c) => distanceRunPungPair(c),
	'Greta\'s Garden': (c) => distanceGretasGarden(c),
	'Greta\'s Dragon': (c) => distanceGretasDragon(c),
	'Gertie\'s Garter': (c) => distanceGertiesGarter(c),
	'Red Lantern': (c, ctx) => distanceRedLantern(c, ctx),
	'Gates of Heaven': (c) => distanceGatesOfHeaven(c),
	'Confused Gates': (c) => distanceConfusedGates(c),
	'Windy Chow': (c) => distanceWindyChow(c),
	'Big Robert': (c) => distanceBigRobert(c),
	'Moon at Bottom of Well': (c) => distanceMoonAtBottomOfWell(c),
	'Knitting': (c) => distanceKnitting(c),
	'Triple Knitting': (c) => distanceTripleKnitting(c),
	'All Pair': (c) => distanceAllPair(c),
	'All Pair Honours': (c) => distanceAllPairHonours(c),
	'Heavenly Twins': (c) => distanceHeavenlyTwins(c),
	'Windfall': (c) => distanceWindfall(c),
	'All Pair Ruby Jade': (c) => distanceAllPairRubyJade(c),
	'Sparrow\'s Sanctuary': (c) => distanceSparrowsSanctuary(c),
	'Windy Ones': (c) => distanceWindyRank(c, 1),
	'Windy Nines': (c) => distanceWindyRank(c, 9),
	'Hachi Ban': (c) => distanceHachiBan(c),
	'Four Blessings': (c) => distanceFourBlessings(c),
	'Grand Sequence': (c) => distanceGrandSequence(c),
	'Dragonfly': (c) => distanceDragonfly(c),
	'Dragon\'s Breath': (c) => distanceDragonsBreath(c),
	'Wriggly Dragon': (c) => distanceWrigglyDragon(c),
	'Green Jade': (c) => distanceColorDragonSuitHand(c, 'green', 'bamboo'),
	'Red Coral': (c) => distanceColorDragonSuitHand(c, 'red', 'characters'),
	'White Opal': (c) => distanceColorDragonSuitHand(c, 'white', 'dots'),
	'Guardian Dragon': (c) => distanceGuardianDragon(c),
	'Three Great Scholars': (c) => distanceThreeGreatScholars(c),
	'Unique Wonder': (c) => distanceUniqueWonder(c),
	'Five Odd Honours': (c) => distanceFiveOddHonours(c),
	'Dragon\'s Tail': (c) => distanceDragonsTail(c),
	'Hovering Angel': (c, ctx) => distanceHoveringAngel(c, ctx),
	'Guardian Winds': (c) => distanceGuardianWinds(c),
	'Dragon\'s Gates': (c) => distanceDragonsGates(c),
	'Dragon\'s Teeth': (c) => distanceDragonsTeeth(c),
	'Yin Yang': (c) => distanceYinYang(c),
	'Three Philosophers': (c) => distanceThreePhilosophers(c),
	'Chow Chow': (c, ctx, max) => distanceChowChow(c, ctx, max),
	'Crazy Chows': (c, ctx, max) => distanceCrazyChows(c, ctx, max),
	'Little Robert': (c) => distanceLittleRobert(c),
	'Chop Suey': (c) => distanceChopSuey(c),
	'Chow Mien': (c) => distanceChowMien(c),
	'Little Brother': (c, ctx) => distanceLittleBrother(c, ctx),
	'Apple Blossom': (c, ctx, max) => distanceAppleBlossom(c, ctx, max),
	'The Professors': (c, ctx, max) => distanceTheProfessors(c, ctx, max),
	'Odds & Evens': (c) => distanceOddsAndEvens(c),
	'Heads and Tails': (c) => distanceHeadsAndTails(c),
	'Robin': (c) => distanceRobin(c),
	'All Pair Jade': (c) => distanceAllPairJade(c),
	'Imperial Jade': (c, ctx, max) => distanceImperialJade(c, ctx, max),
	'Lily of the Valley': (c) => distanceLilyOfTheValley(c),
	'Red Lily': (c) => distanceRedLily(c),
	'Royal Ruby': (c) => distanceRoyalRuby(c),
	'Ruby Jade': (c) => distanceRubyJade(c),
	'Lillypilly': (c) => distanceLillypilly(c),
	'Blue Mountains': (c) => distanceBlueMountains(c),
	'White Elephant': (c) => distanceWhiteElephant(c),
	'Driven Snow': (c) => distanceDrivenSnow(c),
	'Dragon\'s Scales': (c) => distanceDragonsScales(c),
	'Dragonette': (c) => distanceDragonette(c),
	'Dragon\'s Run': (c) => distanceDragonsRun(c),
	'Sunrise': (c) => distanceSunrise(c),
	'Sunset': (c) => distanceSunset(c),
	'Numbers in Parallel': (c) => distanceNumbersInParallel(c),
	'Numbers Doubled': (c) => distanceNumbersDoubled(c),
	'Chinese Odds': (c) => distanceChineseOdds(c),
	'Seven Twins': (c, ctx) => distanceSevenTwins(c, ctx),
	'Golden Gates': (c) => distanceGoldenGates(c),
	'Windy Dragons': (c) => distanceWindyDragons(c),
	'Windvane': (c) => distanceWindvane(c),
	'Three Sisters': (c) => distanceWindyRank(c, 3),
	'Seven Brothers': (c) => distanceWindyRank(c, 7),
	'Civil War': (c) => distanceCivilWar(c),
	'Up You Go': (c, ctx) => distanceUpYouGo(c, ctx),
	'Down You Go': (c, ctx) => distanceDownYouGo(c, ctx),
	'Red Waratah': (c) => distanceRedWaratah(c),
	'All Winds and Dragons': (c) => distanceAllWindsAndDragons(c)
};

function withDistance(handInfoList) {
	return handInfoList.map((h) => ({ ...h, distance: DISTANCE_FNS[h.name] }));
}

const SPECIAL_HANDS = withDistance(SHORT_LIST_HANDS);
const FULL_SPECIAL_HANDS = withDistance([...SHORT_LIST_HANDS, ...FULL_LIST_EXTRA_HANDS]);

// Normalizes a player's tiles (concealed hand + revealed meld tiles, kongs capped at 3
// tiles so they behave like pungs) into a suit-rank tally for named-hand pattern matching.
function specialHandTally(player, extraTile) {
	const tiles = [...player.hand];
	if (extraTile) tiles.push(extraTile);
	for (const m of player.melds) tiles.push(...m.tiles.slice(0, 3));
	return tallyCounts(tiles);
}

function handsListFor(handMode) {
	return handMode === 'fullList' ? FULL_SPECIAL_HANDS : SPECIAL_HANDS;
}

// The default cap for recursive hands' branch-and-bound pruning when a caller doesn't need
// anything beyond "is this hand complete" (distance 0) or a specific small maxDistance.
const DEFAULT_MAX_DISTANCE = 8;

function handDistance(hand, tally, ctx, maxDistance) {
	return hand.distance(cloneCounts(tally), ctx, maxDistance ?? DEFAULT_MAX_DISTANCE);
}

function bestSpecialHandMatch(tally, ctx, handsList) {
	let best = null;
	for (const hand of handsList) {
		if (handDistance(hand, tally, ctx, 0) === 0 && (!best || hand.winning > best.winning)) best = hand;
	}
	return best;
}

function bestSpecialHandFishingMatch(partialTally, ctx, handsList) {
	let best = null;
	for (const hand of handsList) {
		if (handDistance(hand, partialTally, ctx, 1) === 1 && (!best || hand.fishing > best.fishing)) best = hand;
	}
	return best;
}

// If a named hand's Winning score beats the ordinary calculation, use it instead — named
// hands are absolute scores, not subject to the normal LIMIT cap. `ordinaryResult` is mined
// for whether this was a self-draw / last-wall-tile win, since a few hands (e.g. Chow Chow)
// require that.
function applySpecialWinnerScore(player, winningTile, ordinaryResult, handMode) {
	const tally = specialHandTally(player, winningTile);
	const ctx = {
		seatWind: player.seatWind,
		player,
		selfDraw: ordinaryResult.detail.some((d) => d.name === 'Drew winning tile from wall'),
		wonWithLastWallTile: ordinaryResult.doubleDetail.some((d) => d.name === 'Won with last tile from wall')
	};
	const special = bestSpecialHandMatch(tally, ctx, handsListFor(handMode));
	if (special && special.winning > ordinaryResult.cappedScore) {
		return { ...ordinaryResult, cappedScore: special.winning, rawScore: special.winning, specialHand: special.name };
	}
	return ordinaryResult;
}

// A non-winner who's exactly one tile away from a named hand at hand-end collects its
// Fishing score if that beats their ordinary (non-winning) score.
function applySpecialFishingScore(player, ordinaryResult, handMode) {
	const tally = specialHandTally(player, null);
	const ctx = { seatWind: player.seatWind, player };
	const special = bestSpecialHandFishingMatch(tally, ctx, handsListFor(handMode));
	if (special && special.fishing > ordinaryResult.cappedScore) {
		return { ...ordinaryResult, cappedScore: special.fishing, rawScore: special.fishing, specialHand: `${special.name} (fishing)` };
	}
	return ordinaryResult;
}

const MAX_NAMED_HAND_RESULTS = 8;

// For the Learning-mode hint: every named hand this player is within `maxDistance` tiles of
// right now, sorted closest-first (ties broken by higher Winning score). For hands exactly
// one tile away, also lists which specific tile(s) would complete it and how many are still
// unseen — for anything further away, exact tile suggestions would be combinatorially messy,
// so only the distance is reported.
function namedHandDistances(player, handMode, maxDistance = 3) {
	if (handMode === 'beginner') return [];
	const tally = specialHandTally(player, null);
	const ctx = { seatWind: player.seatWind, player };
	const results = [];
	for (const hand of handsListFor(handMode)) {
		const distance = handDistance(hand, tally, ctx, maxDistance);
		if (distance > maxDistance) continue;
		const entry = { name: hand.name, description: hand.description, winning: hand.winning, fishing: hand.fishing, distance, waits: [] };
		if (distance === 1) {
			for (const probe of ALL_TILE_KINDS) {
				const trial = cloneCounts(tally);
				const key = `${probe.suit}-${probe.rank}`;
				trial[key] = (trial[key] || 0) + 1;
				if (hand.distance(trial, ctx, 0) === 0) entry.waits.push({ suit: probe.suit, rank: probe.rank });
			}
		}
		results.push(entry);
	}
	results.sort((a, b) => a.distance - b.distance || b.winning - a.winning);
	return results.slice(0, MAX_NAMED_HAND_RESULTS);
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
			handMode: 'shortList',
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
		myOriginalCallEligible: player.originalCallEligible,
		myOriginalCallActive: player.originalCallActive,
		myNamedHandFishing:
			game.status === 'playing' && player.assistMode === 'learning' ? namedHandDistances(player, game.handMode, 3) : [],
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
			originalCall: p.originalCallActive,
			totalScore: game.totalScores[p.id] ?? 0
		})),
		dealerPlayerId: game.players[game.dealerIndex]?.id ?? null,
		roundWind: game.roundWind,
		handNumber: game.handNumber,
		handMode: game.handMode,
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
		discardCount: 0,
		originalCallEligible: false,
		originalCallActive: false,
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
	game.chat.push({ playerId: player.id, name: player.name, text: trimmed, timestamp: Date.now() });
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
		p.discardCount = 0;
		p.originalCallEligible = false;
		p.originalCallActive = false;
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
			discardCount: 0,
			originalCallEligible: false,
			originalCallActive: false,
			socket: null
		});
	}
	return dummyCount;
}

const HAND_MODES = ['beginner', 'shortList', 'fullList'];

function startGame(game, socket, fillEmptySeats, handMode) {
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
	game.handMode = HAND_MODES.includes(handMode) ? handMode : 'shortList';
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

// Original Call: a player may declare it right after their first discard of the
// hand if that leaves them calling (one tile from complete). If they never change
// their hand again — always discarding exactly the tile they just drew, and never
// claiming/konging — before going Mah-Jong, it's worth an extra double.
// Called whenever a discard gets claimed (pong/kong/chi/win) so it stops showing in the
// discard pile at the same time it appears in the claimer's exposed meld or winning hand.
function removeDiscardTile(game, tileId) {
	const idx = game.discards.findIndex((d) => d.tile.id === tileId);
	if (idx !== -1) game.discards.splice(idx, 1);
}

function performDiscard(game, player, tileId) {
	const idx = player.hand.findIndex((t) => t.id === tileId);
	if (idx === -1) return;
	const isFirstDiscard = player.discardCount === 0;
	const handChanged = game.turnEntrySource !== 'draw' || tileId !== game.lastDrawnTileId;
	player.discardCount += 1;
	const [tile] = player.hand.splice(idx, 1);
	game.discards.push({ tile, playerId: player.id });
	log(game, `${player.name} discarded ${describeTile(tile)}`);
	if (player.originalCallActive && handChanged) {
		player.originalCallActive = false;
		log(game, `${player.name}'s Original Call is broken`);
	}
	player.originalCallEligible = isFirstDiscard && isCallingHand(player);
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
	removeDiscardTile(game, discard.id);
	log(game, `${player.name} claimed ${response.type === 'kong' ? 'kong' : 'pong'} on ${describeTile(discard)}`);
	if (player.originalCallActive) {
		player.originalCallActive = false;
		log(game, `${player.name}'s Original Call is broken`);
	}
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
	removeDiscardTile(game, discard.id);
	log(game, `${player.name} chi'd ${describeTile(discard)}`);
	if (player.originalCallActive) {
		player.originalCallActive = false;
		log(game, `${player.name}'s Original Call is broken`);
	}
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
	if (player.originalCallActive) {
		player.originalCallActive = false;
		log(game, `${player.name}'s Original Call is broken`);
	}
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
	if (player.originalCallActive) {
		player.originalCallActive = false;
		log(game, `${player.name}'s Original Call is broken`);
	}
	const drew = drawTileForPlayer(game, player);
	if (!drew) return endHandDraw(game);
	game.turnEntrySource = 'draw';
	game.lastDrawnTileId = drew.id;
	broadcastState(game);
}

function handleDeclareOriginalCall(game, socket) {
	const player = game.players.find((p) => p.id === socket.id);
	if (!player) return;
	if (!player.originalCallEligible) return socket.emit('error', 'Cannot declare Original Call now');
	player.originalCallEligible = false;
	player.originalCallActive = true;
	log(game, `${player.name} declared an Original Call`);
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
	removeDiscardTile(game, discard.id);
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
		let result = p.id === winnerId ? winnerResult : computeHandScore(game, p, { isWinner: false });
		if (game.handMode !== 'beginner') {
			result =
				p.id === winnerId
					? applySpecialWinnerScore(p, winningTile, result, game.handMode)
					: applySpecialFishingScore(p, result, game.handMode);
		}
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
			specialHand: scoreResults[p.id].specialHand ?? null,
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
		socket.on('start', ({ fillEmptySeats, handMode } = {}) => {
			const roomId = socketRoom.get(socket.id);
			const game = roomId && games.get(roomId);
			if (game) startGame(game, socket, !!fillEmptySeats, handMode);
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
		socket.on('declareOriginalCall', () => {
			const roomId = socketRoom.get(socket.id);
			const game = roomId && games.get(roomId);
			if (game) handleDeclareOriginalCall(game, socket);
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
