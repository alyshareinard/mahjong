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
// `matches(counts, ctx)` gets a tally of the player's full 14-tile-equivalent hand
// (concealed tiles + meld tiles, with kongs capped at 3 tiles so they behave like pungs)
// and must fully account for every tile with nothing left over. A player's final score is
// the higher of the ordinary calculation and the best matching named hand (Winning for a
// complete hand, Fishing for a non-winner who is exactly one tile away from one at hand-end).
// Big Robert (marked below) is still a best-effort reading pending a closer look at the
// book's page 14 — everything else has been confirmed against the full page text.

const RED_BAMBOO_RANKS = [1, 5, 7, 9];
const GREEN_BAMBOO_RANKS = [2, 3, 4, 6, 8];

function take(counts, key, n) {
	if ((counts[key] || 0) < n) return false;
	counts[key] -= n;
	return true;
}

function remainingTotal(counts) {
	return Object.values(counts).reduce((a, b) => a + b, 0);
}

function takeRunRange(counts, suit, lo, hi) {
	for (let r = lo; r <= hi; r++) if (!take(counts, `${suit}-${r}`, 1)) return false;
	return true;
}

function takeEachWind(counts) {
	for (const w of WIND_RANKS) if (!take(counts, `wind-${w}`, 1)) return false;
	return true;
}

function takeEachDragon(counts) {
	for (const d of DRAGON_RANKS) if (!take(counts, `dragon-${d}`, 1)) return false;
	return true;
}

// Consumes exactly one of each key in `keys`, except one (tried across every option) which
// is consumed twice — the "any tile paired" construction used throughout the short list.
function takeUniqueSetWithOnePaired(counts, keys) {
	for (const doubled of keys) {
		const trial = cloneCounts(counts);
		let ok = true;
		for (const k of keys) {
			if (!take(trial, k, k === doubled ? 2 : 1)) {
				ok = false;
				break;
			}
		}
		if (ok) {
			Object.assign(counts, trial);
			return true;
		}
	}
	return false;
}

// True if every remaining tile belongs to `suit` and decomposes into exactly `pairCount` pairs.
function isExactPairsInSuit(counts, suit, pairCount) {
	let total = 0;
	for (const [k, v] of Object.entries(counts)) {
		if (v <= 0) continue;
		if (!k.startsWith(`${suit}-`)) return false;
		if (v % 2 !== 0) return false;
		total += v;
	}
	return total === pairCount * 2;
}

function takeChow(counts, suit, startRank) {
	return take(counts, `${suit}-${startRank}`, 1) && take(counts, `${suit}-${startRank + 1}`, 1) && take(counts, `${suit}-${startRank + 2}`, 1);
}

// takeChow is a chained take() of 3 tiles: on a partial match (e.g. rank present, rank+1
// present, rank+2 missing) it still consumes the first two before failing. Retrying different
// start ranks against the *same* mutable object is therefore unsafe — this tries each start on
// a fresh clone and only commits (mutating `counts`, like `take`) on an actual full match.
function takeAnyChow(counts, suit, loRank = 1, hiRank = 7) {
	for (let r = loRank; r <= hiRank; r++) {
		const trial = cloneCounts(counts);
		if (takeChow(trial, suit, r)) {
			Object.assign(counts, trial);
			return true;
		}
	}
	return false;
}

function matchWrigglySnake(counts) {
	for (const suit of SUITS_NUM) {
		const trial = cloneCounts(counts);
		const keys = [...Array.from({ length: 9 }, (_, i) => `${suit}-${i + 1}`), ...WIND_RANKS.map((w) => `wind-${w}`)];
		if (takeUniqueSetWithOnePaired(trial, keys) && remainingTotal(trial) === 0) return true;
	}
	return false;
}

function matchRunPungPair(counts) {
	for (const suit of SUITS_NUM) {
		const trial = cloneCounts(counts);
		if (!takeRunRange(trial, suit, 1, 9)) continue;
		for (let pungRank = 1; pungRank <= 9; pungRank++) {
			const t2 = cloneCounts(trial);
			if (!take(t2, `${suit}-${pungRank}`, 3)) continue;
			for (let pairRank = 1; pairRank <= 9; pairRank++) {
				const t3 = cloneCounts(t2);
				if (take(t3, `${suit}-${pairRank}`, 2) && remainingTotal(t3) === 0) return true;
			}
		}
	}
	return false;
}

function matchGretasGarden(counts) {
	for (const suit of SUITS_NUM) {
		const trial = cloneCounts(counts);
		if (takeRunRange(trial, suit, 1, 7) && takeEachWind(trial) && takeEachDragon(trial) && remainingTotal(trial) === 0) return true;
	}
	return false;
}

function matchGretasDragon(counts) {
	for (const suit of SUITS_NUM) {
		for (const d of DRAGON_RANKS) {
			const trial = cloneCounts(counts);
			if (takeRunRange(trial, suit, 1, 7) && takeEachWind(trial) && take(trial, `dragon-${d}`, 3) && remainingTotal(trial) === 0) return true;
		}
	}
	return false;
}

function matchGertiesGarter(counts) {
	for (const suitA of SUITS_NUM) {
		for (const suitB of SUITS_NUM) {
			if (suitA === suitB) continue;
			const trial = cloneCounts(counts);
			if (takeRunRange(trial, suitA, 1, 7) && takeRunRange(trial, suitB, 1, 7) && remainingTotal(trial) === 0) return true;
		}
	}
	return false;
}

function matchRedLantern(counts, ctx) {
	for (const suit of SUITS_NUM) {
		const trial = cloneCounts(counts);
		const keys = Array.from({ length: 7 }, (_, i) => `${suit}-${i + 1}`);
		if (!takeUniqueSetWithOnePaired(trial, keys)) continue;
		if (take(trial, `wind-${ctx.seatWind}`, 3) && take(trial, 'dragon-red', 3) && remainingTotal(trial) === 0) return true;
	}
	return false;
}

function matchGatesOfHeaven(counts) {
	for (const suit of SUITS_NUM) {
		const trial = cloneCounts(counts);
		const keys = Array.from({ length: 7 }, (_, i) => `${suit}-${i + 2}`);
		if (!takeUniqueSetWithOnePaired(trial, keys)) continue;
		if (take(trial, `${suit}-1`, 3) && take(trial, `${suit}-9`, 3) && remainingTotal(trial) === 0) return true;
	}
	return false;
}

function matchConfusedGates(counts) {
	for (const suitRun of SUITS_NUM) {
		for (const suit1 of SUITS_NUM) {
			if (suit1 === suitRun) continue;
			for (const suit9 of SUITS_NUM) {
				if (suit9 === suitRun || suit9 === suit1) continue;
				const trial = cloneCounts(counts);
				const keys = Array.from({ length: 7 }, (_, i) => `${suitRun}-${i + 2}`);
				if (!takeUniqueSetWithOnePaired(trial, keys)) continue;
				if (take(trial, `${suit1}-1`, 3) && take(trial, `${suit9}-9`, 3) && remainingTotal(trial) === 0) return true;
			}
		}
	}
	return false;
}

function matchWindyChow(counts) {
	const trial = cloneCounts(counts);
	for (const suit of SUITS_NUM) {
		if (!takeAnyChow(trial, suit)) return false;
	}
	const keys = WIND_RANKS.map((w) => `wind-${w}`);
	return takeUniqueSetWithOnePaired(trial, keys) && remainingTotal(trial) === 0;
}

// Windy Ones/Nines: the short list doesn't spell out "any Wind paired" here the way Windy
// Chow does, but one wind is doubled to reach 14 tiles — confirmed.
function matchWindyRank(counts, rank) {
	const trial = cloneCounts(counts);
	const keys = WIND_RANKS.map((w) => `wind-${w}`);
	if (!takeUniqueSetWithOnePaired(trial, keys)) return false;
	for (const suit of SUITS_NUM) if (!take(trial, `${suit}-${rank}`, 3)) return false;
	return remainingTotal(trial) === 0;
}

function matchHachiBan(counts) {
	for (const suit of SUITS_NUM) {
		for (const [lo, hi] of [[1, 8], [2, 9]]) {
			const base = cloneCounts(counts);
			if (!takeRunRange(base, suit, lo, hi)) continue;
			for (let skip = 0; skip < WIND_RANKS.length; skip++) {
				const t2 = cloneCounts(base);
				let ok = true;
				for (let wi = 0; wi < WIND_RANKS.length; wi++) {
					if (wi === skip) continue;
					if (!take(t2, `wind-${WIND_RANKS[wi]}`, 2)) {
						ok = false;
						break;
					}
				}
				if (ok && remainingTotal(t2) === 0) return true;
			}
			const t3 = cloneCounts(base);
			if (take(t3, 'dragon-red', 2) && take(t3, 'dragon-green', 2) && take(t3, 'dragon-white', 2) && remainingTotal(t3) === 0) return true;
		}
	}
	return false;
}

function matchFourBlessings(counts) {
	const trial = cloneCounts(counts);
	for (const w of WIND_RANKS) if (!take(trial, `wind-${w}`, 3)) return false;
	const remaining = Object.entries(trial).filter(([, v]) => v > 0);
	return remaining.length === 1 && remaining[0][1] === 2;
}

function matchWindfall(counts) {
	const base = cloneCounts(counts);
	if (!takeEachWind(base)) return false;
	for (const suit of SUITS_NUM) {
		if (isExactPairsInSuit(cloneCounts(base), suit, 5)) return true;
	}
	return false;
}

function matchGrandSequence(counts) {
	for (const suit of SUITS_NUM) {
		const base = cloneCounts(counts);
		if (!takeRunRange(base, suit, 1, 9)) continue;
		for (const honorKey of [...WIND_RANKS.map((w) => `wind-${w}`), ...DRAGON_RANKS.map((d) => `dragon-${d}`)]) {
			const t2 = cloneCounts(base);
			if (!take(t2, honorKey, 3)) continue;
			const remaining = Object.entries(t2).filter(([, v]) => v > 0);
			if (remaining.length === 1 && remaining[0][1] === 2 && SUITS_NUM.includes(remaining[0][0].split('-')[0])) return true;
		}
	}
	return false;
}

function matchDragonfly(counts) {
	const base = cloneCounts(counts);
	if (!takeEachDragon(base)) return false;
	for (const suit of SUITS_NUM) {
		let placed = false;
		for (let r = 1; r <= 9; r++) {
			if (take(base, `${suit}-${r}`, 3)) {
				placed = true;
				break;
			}
		}
		if (!placed) return false;
	}
	const remaining = Object.entries(base).filter(([, v]) => v > 0);
	return remaining.length === 1 && remaining[0][1] === 2 && SUITS_NUM.includes(remaining[0][0].split('-')[0]);
}

function matchDragonsBreath(counts) {
	const base = cloneCounts(counts);
	if (!takeUniqueSetWithOnePaired(base, DRAGON_RANKS.map((d) => `dragon-${d}`))) return false;
	for (const suit of SUITS_NUM) {
		if (isExactPairsInSuit(cloneCounts(base), suit, 5)) return true;
	}
	return false;
}

function matchWrigglyDragon(counts) {
	for (const suit of SUITS_NUM) {
		const base = cloneCounts(counts);
		if (!takeRunRange(base, suit, 1, 9)) continue;
		for (const chosen of DRAGON_RANKS) {
			const t2 = cloneCounts(base);
			let ok = true;
			for (const d of DRAGON_RANKS) {
				if (!take(t2, `dragon-${d}`, d === chosen ? 3 : 1)) {
					ok = false;
					break;
				}
			}
			if (ok && remainingTotal(t2) === 0) return true;
		}
	}
	return false;
}

function matchAllPairRubyJade(counts) {
	const base = cloneCounts(counts);
	if (!take(base, 'dragon-green', 2) || !take(base, 'dragon-red', 2)) return false;
	const pool = new Set([...RED_BAMBOO_RANKS, ...GREEN_BAMBOO_RANKS]);
	let pairs = 0;
	for (const [k, v] of Object.entries(base)) {
		if (v <= 0) continue;
		if (!k.startsWith('bamboo-')) return false;
		if (!pool.has(parseInt(k.split('-')[1], 10))) return false;
		if (v !== 2) return false;
		pairs++;
	}
	return pairs === 5;
}

function matchSparrowsSanctuary(counts) {
	const trial = cloneCounts(counts);
	if (!take(trial, 'bamboo-1', 4)) return false;
	for (const r of GREEN_BAMBOO_RANKS) if (!take(trial, `bamboo-${r}`, 2)) return false;
	return remainingTotal(trial) === 0;
}

function matchColorDragonSuitHand(counts, dragon, suit) {
	const trial = cloneCounts(counts);
	if (!take(trial, `dragon-${dragon}`, 3)) return false;
	const ranksAvailable = [];
	for (let r = 1; r <= 9; r++) if ((trial[`${suit}-${r}`] || 0) >= 3) ranksAvailable.push(r);
	for (let i = 0; i < ranksAvailable.length; i++) {
		for (let j = i + 1; j < ranksAvailable.length; j++) {
			for (let k = j + 1; k < ranksAvailable.length; k++) {
				const t2 = cloneCounts(trial);
				take(t2, `${suit}-${ranksAvailable[i]}`, 3);
				take(t2, `${suit}-${ranksAvailable[j]}`, 3);
				take(t2, `${suit}-${ranksAvailable[k]}`, 3);
				if (isExactPairsInSuit(t2, suit, 1)) return true;
			}
		}
	}
	return false;
}

function matchThreeGreatScholars(counts) {
	const trial = cloneCounts(counts);
	for (const d of DRAGON_RANKS) if (!take(trial, `dragon-${d}`, 3)) return false;
	for (const suit of SUITS_NUM) {
		for (let r = 1; r <= 9; r++) {
			const t2 = cloneCounts(trial);
			if (take(t2, `${suit}-${r}`, 3)) {
				const remaining = Object.entries(t2).filter(([, v]) => v > 0);
				if (remaining.length === 1 && remaining[0][1] === 2 && SUITS_NUM.includes(remaining[0][0].split('-')[0])) return true;
			}
		}
		for (let r = 1; r <= 7; r++) {
			const t2 = cloneCounts(trial);
			if (takeChow(t2, suit, r)) {
				const remaining = Object.entries(t2).filter(([, v]) => v > 0);
				if (remaining.length === 1 && remaining[0][1] === 2 && SUITS_NUM.includes(remaining[0][0].split('-')[0])) return true;
			}
		}
	}
	return false;
}

function matchGuardianDragon(counts) {
	for (const suit of SUITS_NUM) {
		const base = cloneCounts(counts);
		if (!takeRunRange(base, suit, 1, 9)) continue;
		for (const pungD of DRAGON_RANKS) {
			for (const pairD of DRAGON_RANKS) {
				if (pungD === pairD) continue;
				const t2 = cloneCounts(base);
				if (take(t2, `dragon-${pungD}`, 3) && take(t2, `dragon-${pairD}`, 2) && remainingTotal(t2) === 0) return true;
			}
		}
	}
	return false;
}

function matchUniqueWonder(counts) {
	const keys = [
		...WIND_RANKS.map((w) => `wind-${w}`),
		...DRAGON_RANKS.map((d) => `dragon-${d}`),
		...SUITS_NUM.flatMap((s) => [`${s}-1`, `${s}-9`])
	];
	const trial = cloneCounts(counts);
	return takeUniqueSetWithOnePaired(trial, keys) && remainingTotal(trial) === 0;
}

function matchFiveOddHonours(counts) {
	const honorKeys = [...WIND_RANKS.map((w) => `wind-${w}`), ...DRAGON_RANKS.map((d) => `dragon-${d}`)];
	for (const suit of SUITS_NUM) {
		const base = cloneCounts(counts);
		if (!takeRunRange(base, suit, 1, 9)) continue;
		let honorCount = 0;
		let ok = true;
		for (const k of honorKeys) {
			const c = base[k] || 0;
			if (c === 1) honorCount++;
			else if (c !== 0) {
				ok = false;
				break;
			}
		}
		if (ok && honorCount === 5 && remainingTotal(base) === 5) return true;
	}
	return false;
}

function matchDragonsTail(counts) {
	for (const suit of SUITS_NUM) {
		const base = cloneCounts(counts);
		if (!takeRunRange(base, suit, 1, 9)) continue;
		for (const d of DRAGON_RANKS) {
			for (const w of WIND_RANKS) {
				const t2 = cloneCounts(base);
				if (take(t2, `dragon-${d}`, 3) && take(t2, `wind-${w}`, 2) && remainingTotal(t2) === 0) return true;
				const t3 = cloneCounts(base);
				if (take(t3, `wind-${w}`, 3) && take(t3, `dragon-${d}`, 2) && remainingTotal(t3) === 0) return true;
			}
		}
	}
	return false;
}

function matchHoveringAngel(counts, ctx) {
	const base = cloneCounts(counts);
	if (!take(base, `wind-${ctx.seatWind}`, 3)) return false;
	for (const suit of SUITS_NUM) {
		if (!takeAnyChow(base, suit)) return false;
	}
	for (const d of DRAGON_RANKS) {
		const t2 = cloneCounts(base);
		if (take(t2, `dragon-${d}`, 2) && remainingTotal(t2) === 0) return true;
	}
	return false;
}

function matchHeavenlyTwins(counts) {
	for (const suit of SUITS_NUM) {
		if (isExactPairsInSuit(cloneCounts(counts), suit, 7)) return true;
	}
	return false;
}

// "All Pair" (500) vs "All Pair Honours" (1000): read as plain Seven Pairs (any tiles)
// vs. the stricter version where every pair must be a terminal/Wind/Dragon — best-effort
// reading of two short-list rows that would otherwise look like the same hand.
function matchAllPair(counts) {
	let total = 0;
	for (const v of Object.values(counts)) {
		if (v % 2 !== 0) return false;
		total += v;
	}
	return total === 14;
}

function matchAllPairHonours(counts) {
	let total = 0;
	for (const [k, v] of Object.entries(counts)) {
		if (v <= 0) continue;
		if (v % 2 !== 0) return false;
		const [suit, rank] = k.split('-');
		if (!(suit === 'wind' || suit === 'dragon' || rank === '1' || rank === '9')) return false;
		total += v;
	}
	return total === 14;
}

// Knitting: seven distinct numbers, each held as a pair confined to one of two chosen
// suits (no third suit, no honors) — confirmed: "7 pairs same number in 2 suits", each
// individual pair same-suit.
function matchKnitting(counts) {
	for (const suitA of SUITS_NUM) {
		for (const suitB of SUITS_NUM) {
			if (suitA === suitB) continue;
			const other = SUITS_NUM.find((s) => s !== suitA && s !== suitB);
			let usesOutside = false;
			for (const [k, v] of Object.entries(counts)) {
				if (v > 0 && (k.startsWith(`${other}-`) || k.startsWith('wind-') || k.startsWith('dragon-'))) usesOutside = true;
			}
			if (usesOutside) continue;
			let pairRanks = 0;
			let ok = true;
			for (let r = 1; r <= 9; r++) {
				const ca = counts[`${suitA}-${r}`] || 0;
				const cb = counts[`${suitB}-${r}`] || 0;
				const total = ca + cb;
				if (total === 0) continue;
				if (total !== 2 || (ca !== 2 && cb !== 2)) {
					ok = false;
					break;
				}
				pairRanks++;
			}
			if (ok && pairRanks === 7) return true;
		}
	}
	return false;
}

// Triple Knitting: four numbers each held once in all three suits, plus one same-suit pair —
// confirmed: "4 sets same number in 3 suits + knitting pair".
function matchTripleKnitting(counts) {
	const ranks = [];
	for (let r = 1; r <= 9; r++) if (SUITS_NUM.every((s) => (counts[`${s}-${r}`] || 0) >= 1)) ranks.push(r);
	for (let a = 0; a < ranks.length; a++) {
		for (let b = a + 1; b < ranks.length; b++) {
			for (let c = b + 1; c < ranks.length; c++) {
				for (let d = c + 1; d < ranks.length; d++) {
					const chosen = [ranks[a], ranks[b], ranks[c], ranks[d]];
					const trial = cloneCounts(counts);
					for (const r of chosen) for (const s of SUITS_NUM) take(trial, `${s}-${r}`, 1);
					const remaining = Object.entries(trial).filter(([, v]) => v > 0);
					if (remaining.length === 1 && remaining[0][1] === 2) return true;
				}
			}
		}
	}
	return false;
}

// Big Robert: best-effort reading, FLAGGED for a closer look at page 14 — a run of four
// consecutive numbers in each suit, plus a pair of a Wind or Dragon. The book's "(if Numbers
// same = L)" limit-hand bonus isn't applied. There may also be a distinct "Little Robert"
// (500/200, "Chow in each suit + P/K + Pr in any suit") that this short-list entry relates
// to — unconfirmed, and that pattern doesn't obviously match "Big Robert" as coded here.
function matchBigRobert(counts) {
	const base = cloneCounts(counts);
	for (const suit of SUITS_NUM) {
		let placed = false;
		for (let r = 1; r <= 6; r++) {
			const t2 = cloneCounts(base);
			if (take(t2, `${suit}-${r}`, 1) && take(t2, `${suit}-${r + 1}`, 1) && take(t2, `${suit}-${r + 2}`, 1) && take(t2, `${suit}-${r + 3}`, 1)) {
				Object.assign(base, t2);
				placed = true;
				break;
			}
		}
		if (!placed) return false;
	}
	for (const key of [...WIND_RANKS.map((w) => `wind-${w}`), ...DRAGON_RANKS.map((d) => `dragon-${d}`)]) {
		const t2 = cloneCounts(base);
		if (take(t2, key, 2) && remainingTotal(t2) === 0) return true;
	}
	return false;
}

// Moon at Bottom of Well: "three in ascending order" = a Run 1-9 (123, 456, 789), plus a
// fourth chow and a pair on top of that, all in Dots.
function matchMoonAtBottomOfWell(counts) {
	const suit = 'dots';
	const base = cloneCounts(counts);
	if (!takeRunRange(base, suit, 1, 9)) return false;
	for (let cr = 1; cr <= 7; cr++) {
		const t2 = cloneCounts(base);
		if (!takeChow(t2, suit, cr)) continue;
		const remaining = Object.entries(t2).filter(([, v]) => v > 0);
		if (remaining.length === 1 && remaining[0][1] === 2 && remaining[0][0].startsWith(`${suit}-`)) return true;
	}
	return false;
}

const SPECIAL_HANDS = [
	{ name: 'Wriggly Snake', winning: 1000, fishing: 400, matches: (c) => matchWrigglySnake(c) },
	{ name: 'Run, Pung & Pair', winning: 1000, fishing: 400, matches: (c) => matchRunPungPair(c) },
	{ name: "Greta's Garden", winning: 1000, fishing: 400, matches: (c) => matchGretasGarden(c) },
	{ name: "Greta's Dragon", winning: 1000, fishing: 400, matches: (c) => matchGretasDragon(c) },
	{ name: "Gertie's Garter", winning: 1000, fishing: 400, matches: (c) => matchGertiesGarter(c) },
	{ name: 'Red Lantern', winning: 2000, fishing: 800, matches: (c, ctx) => matchRedLantern(c, ctx) },
	{ name: 'Gates of Heaven', winning: 1000, fishing: 400, matches: (c) => matchGatesOfHeaven(c) },
	{ name: 'Confused Gates', winning: 1000, fishing: 400, matches: (c) => matchConfusedGates(c) },
	{ name: 'Windy Chow', winning: 500, fishing: 200, matches: (c) => matchWindyChow(c) },
	{ name: 'Big Robert', winning: 500, fishing: 200, matches: (c) => matchBigRobert(c) },
	{ name: 'Moon at Bottom of Well', winning: 1000, fishing: 400, matches: (c) => matchMoonAtBottomOfWell(c) },
	{ name: 'Knitting', winning: 500, fishing: 200, matches: (c) => matchKnitting(c) },
	{ name: 'Triple Knitting', winning: 500, fishing: 200, matches: (c) => matchTripleKnitting(c) },
	{ name: 'All Pair', winning: 500, fishing: 200, matches: (c) => matchAllPair(c) },
	{ name: 'All Pair Honours', winning: 1000, fishing: 400, matches: (c) => matchAllPairHonours(c) },
	{ name: 'Heavenly Twins', winning: 1000, fishing: 400, matches: (c) => matchHeavenlyTwins(c) },
	{ name: 'Windfall', winning: 1000, fishing: 400, matches: (c) => matchWindfall(c) },
	{ name: 'All Pair Ruby Jade', winning: 1000, fishing: 400, matches: (c) => matchAllPairRubyJade(c) },
	{ name: "Sparrow's Sanctuary", winning: 1500, fishing: 600, matches: (c) => matchSparrowsSanctuary(c) },
	{ name: 'Windy Ones', winning: 1000, fishing: 400, matches: (c) => matchWindyRank(c, 1) },
	{ name: 'Windy Nines', winning: 1000, fishing: 400, matches: (c) => matchWindyRank(c, 9) },
	{ name: 'Hachi Ban', winning: 1000, fishing: 400, matches: (c) => matchHachiBan(c) },
	{ name: 'Four Blessings', winning: 1500, fishing: 600, matches: (c) => matchFourBlessings(c) },
	{ name: 'Grand Sequence', winning: 1000, fishing: 400, matches: (c) => matchGrandSequence(c) },
	{ name: 'Dragonfly', winning: 1000, fishing: 400, matches: (c) => matchDragonfly(c) },
	{ name: "Dragon's Breath", winning: 1000, fishing: 400, matches: (c) => matchDragonsBreath(c) },
	{ name: 'Wriggly Dragon', winning: 1000, fishing: 400, matches: (c) => matchWrigglyDragon(c) },
	{ name: 'Green Jade', winning: 1000, fishing: 400, matches: (c) => matchColorDragonSuitHand(c, 'green', 'bamboo') },
	{ name: 'Red Coral', winning: 1000, fishing: 400, matches: (c) => matchColorDragonSuitHand(c, 'red', 'characters') },
	{ name: 'White Opal', winning: 1000, fishing: 400, matches: (c) => matchColorDragonSuitHand(c, 'white', 'dots') },
	{ name: 'Guardian Dragon', winning: 1000, fishing: 400, matches: (c) => matchGuardianDragon(c) },
	{ name: 'Three Great Scholars', winning: 1500, fishing: 600, matches: (c) => matchThreeGreatScholars(c) },
	{ name: 'Unique Wonder', winning: 2000, fishing: 800, matches: (c) => matchUniqueWonder(c) },
	{ name: 'Five Odd Honours', winning: 500, fishing: 200, matches: (c) => matchFiveOddHonours(c) },
	{ name: "Dragon's Tail", winning: 1000, fishing: 400, matches: (c) => matchDragonsTail(c) },
	{ name: 'Hovering Angel', winning: 1000, fishing: 400, matches: (c, ctx) => matchHoveringAngel(c, ctx) }
];

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

function matchGuardianWinds(counts) {
	for (const suit of SUITS_NUM) {
		const base = cloneCounts(counts);
		if (!takeRunRange(base, suit, 1, 9)) continue;
		for (const pungW of WIND_RANKS) {
			for (const pairW of WIND_RANKS) {
				if (pungW === pairW) continue;
				const t2 = cloneCounts(base);
				if (take(t2, `wind-${pungW}`, 3) && take(t2, `wind-${pairW}`, 2) && remainingTotal(t2) === 0) return true;
			}
		}
	}
	return false;
}

function matchDragonsGates(counts) {
	for (const suit of SUITS_NUM) {
		const trial = cloneCounts(counts);
		const keys = Array.from({ length: 7 }, (_, i) => `${suit}-${i + 2}`);
		if (!takeUniqueSetWithOnePaired(trial, keys)) continue;
		const dragon = CORRESPONDING_DRAGON[suit];
		for (const terminal of [1, 9]) {
			const t2 = cloneCounts(trial);
			if (take(t2, `${suit}-${terminal}`, 3) && take(t2, `dragon-${dragon}`, 3) && remainingTotal(t2) === 0) return true;
		}
	}
	return false;
}

function matchDragonsTeeth(counts) {
	for (const suit of ['characters', 'dots']) {
		const base = cloneCounts(counts);
		if (!take(base, 'dragon-red', 3) || !take(base, 'dragon-white', 3)) continue;
		for (const lo of [1, 2]) {
			const keys = Array.from({ length: 7 }, (_, i) => `${suit}-${lo + i}`);
			const t2 = cloneCounts(base);
			if (takeUniqueSetWithOnePaired(t2, keys) && remainingTotal(t2) === 0) return true;
		}
	}
	return false;
}

function matchYinYang(counts) {
	for (const suitA of SUITS_NUM) {
		for (const suitB of SUITS_NUM) {
			if (suitA === suitB) continue;
			const trial = cloneCounts(counts);
			if (
				take(trial, `${suitA}-1`, 2) &&
				take(trial, `${suitA}-2`, 1) &&
				take(trial, `${suitA}-3`, 1) &&
				take(trial, `${suitA}-4`, 1) &&
				take(trial, `${suitA}-5`, 2) &&
				take(trial, `${suitB}-5`, 2) &&
				take(trial, `${suitB}-6`, 1) &&
				take(trial, `${suitB}-7`, 1) &&
				take(trial, `${suitB}-8`, 1) &&
				take(trial, `${suitB}-9`, 2) &&
				remainingTotal(trial) === 0
			) {
				return true;
			}
		}
	}
	return false;
}

function matchThreePhilosophers(counts) {
	const base = cloneCounts(counts);
	for (const suit of SUITS_NUM) {
		if (!takeAnyChow(base, suit)) return false;
	}
	for (const suit of SUITS_NUM) {
		for (let r = 1; r <= 7; r++) {
			const t2 = cloneCounts(base);
			if (!takeChow(t2, suit, r)) continue;
			const remaining = Object.entries(t2).filter(([, v]) => v > 0);
			if (remaining.length === 1 && remaining[0][1] === 2 && SUITS_NUM.includes(remaining[0][0].split('-')[0])) return true;
		}
	}
	return false;
}

function matchCrazyChows(counts) {
	function search(remainingChows, trial) {
		if (remainingChows === 0) {
			const remaining = Object.entries(trial).filter(([, v]) => v > 0);
			return remaining.length === 1 && remaining[0][1] === 2 && SUITS_NUM.includes(remaining[0][0].split('-')[0]);
		}
		for (const suit of SUITS_NUM) {
			for (let r = 1; r <= 7; r++) {
				const t2 = cloneCounts(trial);
				if (takeChow(t2, suit, r) && search(remainingChows - 1, t2)) return true;
			}
		}
		return false;
	}
	return search(4, cloneCounts(counts));
}

function matchLittleRobert(counts) {
	const base = cloneCounts(counts);
	for (const suit of SUITS_NUM) {
		if (!takeAnyChow(base, suit)) return false;
	}
	for (const suit of SUITS_NUM) {
		for (let r = 1; r <= 9; r++) {
			const t2 = cloneCounts(base);
			if (!take(t2, `${suit}-${r}`, 3)) continue;
			const remaining = Object.entries(t2).filter(([, v]) => v > 0);
			if (remaining.length === 1 && remaining[0][1] === 2 && SUITS_NUM.includes(remaining[0][0].split('-')[0])) return true;
		}
	}
	return false;
}

function matchChowRankTriple(counts, startRank) {
	const trial = cloneCounts(counts);
	for (const suit of SUITS_NUM) {
		if (!takeChow(trial, suit, startRank)) return false;
	}
	const keys = WIND_RANKS.map((w) => `wind-${w}`);
	return takeUniqueSetWithOnePaired(trial, keys) && remainingTotal(trial) === 0;
}

function matchChopSuey(counts) {
	return matchChowRankTriple(counts, 1);
}

function matchChowMien(counts) {
	return matchChowRankTriple(counts, 7);
}

function matchLittleBrother(counts, ctx) {
	const base = cloneCounts(counts);
	for (const suit of SUITS_NUM) {
		if (!takeAnyChow(base, suit)) return false;
	}
	if (!take(base, `wind-${ctx.seatWind}`, 2)) return false;
	for (const suit of SUITS_NUM) {
		for (let r = 1; r <= 7; r++) {
			const t2 = cloneCounts(base);
			if (takeChow(t2, suit, r) && remainingTotal(t2) === 0) return true;
		}
	}
	return false;
}

function matchAppleBlossom(counts) {
	function search(remainingChows, trial) {
		if (remainingChows === 0) return take(trial, 'dragon-white', 3) && take(trial, 'dragon-green', 2) && remainingTotal(trial) === 0;
		for (const suit of SUITS_NUM) {
			for (let r = 1; r <= 7; r++) {
				const t2 = cloneCounts(trial);
				if (takeChow(t2, suit, r) && search(remainingChows - 1, t2)) return true;
			}
		}
		return false;
	}
	return search(3, cloneCounts(counts));
}

function matchTheProfessors(counts, ctx) {
	function search(remainingChows, trial) {
		if (remainingChows === 0) return takeEachDragon(trial) && take(trial, `wind-${ctx.seatWind}`, 2) && remainingTotal(trial) === 0;
		for (const suit of SUITS_NUM) {
			for (let r = 1; r <= 7; r++) {
				const t2 = cloneCounts(trial);
				if (takeChow(t2, suit, r) && search(remainingChows - 1, t2)) return true;
			}
		}
		return false;
	}
	return search(3, cloneCounts(counts));
}

// Chow Chow requires the whole hand to have come from self-drawn wall tiles with no calls,
// ending on the last tile in the wall. `ctx.selfDraw`/`ctx.wonWithLastWallTile` are only set
// when scoring an actual win (see applySpecialWinnerScore) — in a fishing check they're
// undefined, so only the concealment/shape requirement is checked there.
function matchChowChow(counts, ctx) {
	if (!ctx.player || !ctx.player.melds.every((m) => m.concealed)) return false;
	if (ctx.selfDraw === false || ctx.wonWithLastWallTile === false) return false;
	for (const suit of SUITS_NUM) {
		function search(remainingChows, trial) {
			if (remainingChows === 0) {
				const remaining = Object.entries(trial).filter(([, v]) => v > 0);
				return remaining.length === 1 && remaining[0][1] === 2 && remaining[0][0].startsWith(`${suit}-`);
			}
			for (let r = 1; r <= 7; r++) {
				const t2 = cloneCounts(trial);
				if (takeChow(t2, suit, r) && search(remainingChows - 1, t2)) return true;
			}
			return false;
		}
		if (search(4, cloneCounts(counts))) return true;
	}
	return false;
}

function matchOddsAndEvens(counts) {
	for (const evenSuit of SUITS_NUM) {
		const oddSuits = SUITS_NUM.filter((s) => s !== evenSuit);
		const trial = cloneCounts(counts);
		let ok = true;
		for (const suit of oddSuits) {
			for (const r of ODD_RANKS) {
				if (!take(trial, `${suit}-${r}`, 1)) {
					ok = false;
					break;
				}
			}
			if (!ok) break;
		}
		if (!ok) continue;
		for (const r of EVEN_RANKS) {
			if (!take(trial, `${evenSuit}-${r}`, 1)) {
				ok = false;
				break;
			}
		}
		if (ok && remainingTotal(trial) === 0) return true;
	}
	return false;
}

function matchHeadsAndTails(counts) {
	const terminalKeys = SUITS_NUM.flatMap((s) => [`${s}-1`, `${s}-9`]);
	function chooseMelds(remaining, trial) {
		if (remaining === 0) {
			const rem = Object.entries(trial).filter(([, v]) => v > 0);
			return rem.length === 1 && rem[0][1] === 2 && terminalKeys.includes(rem[0][0]);
		}
		for (const key of terminalKeys) {
			const t2 = cloneCounts(trial);
			if (take(t2, key, 3) && chooseMelds(remaining - 1, t2)) return true;
		}
		return false;
	}
	return chooseMelds(4, cloneCounts(counts));
}

function matchRobin(counts) {
	for (const suitA of SUITS_NUM) {
		for (const suitB of SUITS_NUM) {
			if (suitB === suitA) continue;
			const suitC = SUITS_NUM.find((s) => s !== suitA && s !== suitB);
			for (let ra = 1; ra <= 7; ra++) {
				const t1 = cloneCounts(counts);
				if (!takeChow(t1, suitA, ra)) continue;
				for (let rb1 = 1; rb1 <= 7; rb1++) {
					const t2 = cloneCounts(t1);
					if (!takeChow(t2, suitB, rb1)) continue;
					for (let rb2 = 1; rb2 <= 7; rb2++) {
						const t3 = cloneCounts(t2);
						if (!takeChow(t3, suitB, rb2)) continue;
						for (let rc = 1; rc <= 7; rc++) {
							const t4 = cloneCounts(t3);
							if (!takeChow(t4, suitC, rc)) continue;
							const remaining = Object.entries(t4).filter(([, v]) => v > 0);
							if (remaining.length === 1 && remaining[0][1] === 2 && remaining[0][0].startsWith(`${suitC}-`)) return true;
						}
					}
				}
			}
		}
	}
	return false;
}

function matchAllPairJade(counts) {
	const optionA = cloneCounts(counts);
	if (take(optionA, 'dragon-green', 2)) {
		let pairs = 0;
		let ok = true;
		for (const [k, v] of Object.entries(optionA)) {
			if (v <= 0) continue;
			if (!k.startsWith('bamboo-') || !GREEN_BAMBOO_RANKS.includes(parseInt(k.split('-')[1], 10)) || (v !== 2 && v !== 4)) {
				ok = false;
				break;
			}
			pairs += v / 2;
		}
		if (ok && pairs === 6) return true;
	}
	const optionB = cloneCounts(counts);
	if (take(optionB, 'dragon-green', 4)) {
		let pairs = 0;
		let ok = true;
		for (const [k, v] of Object.entries(optionB)) {
			if (v <= 0) continue;
			if (!k.startsWith('bamboo-') || !GREEN_BAMBOO_RANKS.includes(parseInt(k.split('-')[1], 10)) || v !== 2) {
				ok = false;
				break;
			}
			pairs++;
		}
		if (ok && pairs === 5) return true;
	}
	return false;
}

function matchImperialJade(counts) {
	for (const dragonCount of [3, 4]) {
		const base = cloneCounts(counts);
		if (!take(base, 'dragon-green', dragonCount)) continue;
		function search(remaining, trial, chowUsed) {
			if (remaining === 0) {
				const rem = Object.entries(trial).filter(([, v]) => v > 0);
				if (rem.length !== 1 || rem[0][1] !== 2) return false;
				const [k] = rem[0];
				return k.startsWith('bamboo-') && GREEN_BAMBOO_RANKS.includes(parseInt(k.split('-')[1], 10));
			}
			for (let r = 1; r <= 9; r++) {
				const t2 = cloneCounts(trial);
				if (take(t2, `bamboo-${r}`, 3) && search(remaining - 1, t2, chowUsed)) return true;
			}
			if (!chowUsed) {
				for (let r = 1; r <= 7; r++) {
					const t2 = cloneCounts(trial);
					if (takeChow(t2, 'bamboo', r) && search(remaining - 1, t2, true)) return true;
				}
			}
			return false;
		}
		if (search(3, base, false)) return true;
	}
	return false;
}

function matchLilyOfTheValley(counts) {
	for (const gCount of [3, 4]) {
		for (const wCount of [3, 4]) {
			const base = cloneCounts(counts);
			if (!take(base, 'dragon-green', gCount) || !take(base, 'dragon-white', wCount)) continue;
			for (let r1 = 1; r1 <= 9; r1++) {
				const t2 = cloneCounts(base);
				if (!take(t2, `bamboo-${r1}`, 3)) continue;
				for (let r2 = 1; r2 <= 9; r2++) {
					const t3 = cloneCounts(t2);
					if (!take(t3, `bamboo-${r2}`, 3)) continue;
					const remaining = Object.entries(t3).filter(([, v]) => v > 0);
					if (remaining.length === 1 && remaining[0][1] === 2) {
						const rank = parseInt(remaining[0][0].split('-')[1], 10);
						if (remaining[0][0].startsWith('bamboo-') && GREEN_BAMBOO_RANKS.includes(rank)) return true;
					}
				}
			}
		}
	}
	return false;
}

function matchRedLily(counts) {
	for (const rCount of [3, 4]) {
		for (const wCount of [3, 4]) {
			const base = cloneCounts(counts);
			if (!take(base, 'dragon-red', rCount) || !take(base, 'dragon-white', wCount)) continue;
			for (let r1 = 1; r1 <= 9; r1++) {
				const t2 = cloneCounts(base);
				if (!take(t2, `bamboo-${r1}`, 3)) continue;
				for (let r2 = 1; r2 <= 9; r2++) {
					const t3 = cloneCounts(t2);
					if (!take(t3, `bamboo-${r2}`, 3)) continue;
					const remaining = Object.entries(t3).filter(([, v]) => v > 0);
					if (remaining.length === 1 && remaining[0][1] === 2) {
						const rank = parseInt(remaining[0][0].split('-')[1], 10);
						if (remaining[0][0].startsWith('bamboo-') && RED_BAMBOO_RANKS.includes(rank)) return true;
					}
				}
			}
		}
	}
	return false;
}

function matchRoyalRuby(counts) {
	for (const rCount of [3, 4]) {
		const base = cloneCounts(counts);
		if (!take(base, 'dragon-red', rCount)) continue;
		function search(remaining, trial) {
			if (remaining === 0) {
				const rem = Object.entries(trial).filter(([, v]) => v > 0);
				if (rem.length !== 1 || rem[0][1] !== 2) return false;
				const [k] = rem[0];
				return k.startsWith('bamboo-') && RED_BAMBOO_RANKS.includes(parseInt(k.split('-')[1], 10));
			}
			for (let r = 1; r <= 9; r++) {
				const t2 = cloneCounts(trial);
				if (take(t2, `bamboo-${r}`, 3) && search(remaining - 1, t2)) return true;
			}
			return false;
		}
		if (search(3, base)) return true;
	}
	return false;
}

function matchRubyJade(counts) {
	for (const rCount of [3, 4]) {
		for (const gCount of [3, 4]) {
			const base = cloneCounts(counts);
			if (!take(base, 'dragon-red', rCount) || !take(base, 'dragon-green', gCount)) continue;
			for (let r1 = 1; r1 <= 9; r1++) {
				const t2 = cloneCounts(base);
				if (!take(t2, `bamboo-${r1}`, 3)) continue;
				for (let r2 = 1; r2 <= 9; r2++) {
					const t3 = cloneCounts(t2);
					if (!take(t3, `bamboo-${r2}`, 3)) continue;
					const remaining = Object.entries(t3).filter(([, v]) => v > 0);
					if (remaining.length === 1 && remaining[0][1] === 2) {
						const rank = parseInt(remaining[0][0].split('-')[1], 10);
						if (remaining[0][0].startsWith('bamboo-') && (RED_BAMBOO_RANKS.includes(rank) || GREEN_BAMBOO_RANKS.includes(rank))) return true;
					}
				}
			}
		}
	}
	return false;
}

function matchLillypilly(counts) {
	const trial = cloneCounts(counts);
	if (!take(trial, 'dragon-green', 3) || !take(trial, 'dragon-white', 2)) return false;
	function search(remaining, t) {
		if (remaining === 0) return remainingTotal(t) === 0;
		for (let r = 1; r <= 9; r++) {
			const t2 = cloneCounts(t);
			if (take(t2, `dots-${r}`, 3) && search(remaining - 1, t2)) return true;
		}
		return false;
	}
	return search(3, trial);
}

function matchBlueMountains(counts) {
	const base = cloneCounts(counts);
	if (!take(base, 'dragon-green', 3)) return false;
	function search(remaining, trial) {
		if (remaining === 0) {
			const rem = Object.entries(trial).filter(([, v]) => v > 0);
			if (rem.length !== 1 || rem[0][1] !== 2) return false;
			const [k] = rem[0];
			return k.startsWith('dots-') && BLUE_CIRCLE_RANKS.includes(parseInt(k.split('-')[1], 10));
		}
		for (let r = 1; r <= 9; r++) {
			const t2 = cloneCounts(trial);
			if (take(t2, `dots-${r}`, 3) && search(remaining - 1, t2)) return true;
		}
		return false;
	}
	return search(3, base);
}

function matchWhiteElephant(counts) {
	for (const wCount of [3, 4]) {
		const base = cloneCounts(counts);
		if (!take(base, 'dragon-white', wCount)) continue;
		function search(remaining, trial) {
			if (remaining === 0) {
				const rem = Object.entries(trial).filter(([, v]) => v > 0);
				if (rem.length !== 1 || rem[0][1] !== 2) return false;
				const [k] = rem[0];
				return k.startsWith('dots-') && EVEN_RANKS.includes(parseInt(k.split('-')[1], 10));
			}
			for (let r = 1; r <= 9; r++) {
				const t2 = cloneCounts(trial);
				if (take(t2, `dots-${r}`, 3) && search(remaining - 1, t2)) return true;
			}
			return false;
		}
		if (search(3, base)) return true;
	}
	return false;
}

function matchDrivenSnow(counts) {
	const base = cloneCounts(counts);
	if (!take(base, 'dragon-white', 3)) return false;
	function search(remaining, trial) {
		if (remaining === 0) {
			const rem = Object.entries(trial).filter(([, v]) => v > 0);
			if (rem.length !== 1 || rem[0][1] !== 2) return false;
			const [k] = rem[0];
			return k.startsWith('characters-') && ODD_RANKS.includes(parseInt(k.split('-')[1], 10));
		}
		for (let r = 1; r <= 9; r++) {
			const t2 = cloneCounts(trial);
			if (take(t2, `characters-${r}`, 3) && search(remaining - 1, t2)) return true;
		}
		return false;
	}
	return search(3, base);
}

function matchDragonsScales(counts) {
	const base = cloneCounts(counts);
	if (!take(base, 'dragon-red', 3)) return false;
	function search(remaining, trial) {
		if (remaining === 0) {
			const rem = Object.entries(trial).filter(([, v]) => v > 0);
			if (rem.length !== 1 || rem[0][1] !== 2) return false;
			const [k] = rem[0];
			return k.startsWith('characters-') && EVEN_RANKS.includes(parseInt(k.split('-')[1], 10));
		}
		for (let r = 1; r <= 9; r++) {
			const t2 = cloneCounts(trial);
			if (take(t2, `characters-${r}`, 3) && search(remaining - 1, t2)) return true;
		}
		return false;
	}
	return search(3, base);
}

function matchDragonette(counts) {
	for (const suit of SUITS_NUM) {
		const trial = cloneCounts(counts);
		if (!takeEachWind(trial)) continue;
		if (!takeUniqueSetWithOnePaired(trial, DRAGON_RANKS.map((d) => `dragon-${d}`))) continue;
		let pairs = 0;
		let ok = true;
		for (const [k, v] of Object.entries(trial)) {
			if (v <= 0) continue;
			if (!k.startsWith(`${suit}-`)) {
				ok = false;
				break;
			}
			const rank = parseInt(k.split('-')[1], 10);
			if (rank === 1 || rank === 9 || v !== 2) {
				ok = false;
				break;
			}
			pairs++;
		}
		if (ok && pairs === 3) return true;
	}
	return false;
}

function matchDragonsRun(counts) {
	for (const suit of SUITS_NUM) {
		const base = cloneCounts(counts);
		if (!takeRunRange(base, suit, 1, 9)) continue;
		if (!takeEachDragon(base)) continue;
		for (const w of WIND_RANKS) {
			const t2 = cloneCounts(base);
			if (take(t2, `wind-${w}`, 2) && remainingTotal(t2) === 0) return true;
		}
	}
	return false;
}

function matchSunrise(counts) {
	const base = cloneCounts(counts);
	if (!take(base, 'wind-E', 3) || !take(base, 'dragon-white', 2)) return false;
	for (const suit of SUITS_NUM) {
		let placed = false;
		for (let r = 2; r <= 8; r++) {
			if (take(base, `${suit}-${r}`, 3)) {
				placed = true;
				break;
			}
		}
		if (!placed) return false;
	}
	return remainingTotal(base) === 0;
}

function matchSunset(counts) {
	const base = cloneCounts(counts);
	if (!take(base, 'wind-W', 3) || !take(base, 'dragon-red', 2)) return false;
	for (const suit of SUITS_NUM) {
		let placed = false;
		for (let r = 2; r <= 8; r++) {
			if (take(base, `${suit}-${r}`, 3)) {
				placed = true;
				break;
			}
		}
		if (!placed) return false;
	}
	return remainingTotal(base) === 0;
}

function matchNumbersInParallel(counts) {
	const honorKeys = [...WIND_RANKS.map((w) => `wind-${w}`), ...DRAGON_RANKS.map((d) => `dragon-${d}`)];
	for (const pungHonor of honorKeys) {
		for (const pairHonor of honorKeys) {
			if (pungHonor === pairHonor) continue;
			const base = cloneCounts(counts);
			if (!take(base, pungHonor, 3) || !take(base, pairHonor, 2)) continue;
			for (let r = 2; r <= 8; r++) {
				const t2 = cloneCounts(base);
				let ok = true;
				for (const suit of SUITS_NUM) {
					if (!take(t2, `${suit}-${r}`, 3)) {
						ok = false;
						break;
					}
				}
				if (ok && remainingTotal(t2) === 0) return true;
			}
		}
	}
	return false;
}

// Best-effort reading: "Two P/K of same number in two suits" is taken as two separate
// number/suit-pair groups (four melds total), since the stated pieces alone don't add up
// to 14 tiles otherwise.
function matchNumbersDoubled(counts) {
	const honorKeys = [...WIND_RANKS.map((w) => `wind-${w}`), ...DRAGON_RANKS.map((d) => `dragon-${d}`)];
	const suitPairs = [
		[SUITS_NUM[0], SUITS_NUM[1]],
		[SUITS_NUM[0], SUITS_NUM[2]],
		[SUITS_NUM[1], SUITS_NUM[2]]
	];
	for (const pairHonor of honorKeys) {
		const base = cloneCounts(counts);
		if (!take(base, pairHonor, 2)) continue;
		for (let rA = 2; rA <= 8; rA++) {
			for (let rB = 2; rB <= 8; rB++) {
				if (rA === rB) continue;
				for (const [s1, s2] of suitPairs) {
					for (const [s3, s4] of suitPairs) {
						const t2 = cloneCounts(base);
						if (
							take(t2, `${s1}-${rA}`, 3) &&
							take(t2, `${s2}-${rA}`, 3) &&
							take(t2, `${s3}-${rB}`, 3) &&
							take(t2, `${s4}-${rB}`, 3) &&
							remainingTotal(t2) === 0
						) {
							return true;
						}
					}
				}
			}
		}
	}
	return false;
}

function matchChineseOdds(counts) {
	for (const suit of SUITS_NUM) {
		function search(remaining, trial) {
			if (remaining === 0) {
				const rem = Object.entries(trial).filter(([, v]) => v > 0);
				if (rem.length !== 1 || rem[0][1] !== 2) return false;
				const [k] = rem[0];
				return k.startsWith(`${suit}-`) && ODD_RANKS.includes(parseInt(k.split('-')[1], 10));
			}
			for (const r of ODD_RANKS) {
				const t2 = cloneCounts(trial);
				if (take(t2, `${suit}-${r}`, 3) && search(remaining - 1, t2)) return true;
			}
			return false;
		}
		if (search(4, cloneCounts(counts))) return true;
	}
	return false;
}

// Seven Twins is All Pair's shape plus the "all tiles from wall inc. last" procedural
// requirement — see the Chow Chow comment above for how that's checked.
function matchSevenTwins(counts, ctx) {
	if (!ctx.player || !ctx.player.melds.every((m) => m.concealed)) return false;
	if (ctx.selfDraw === false || ctx.wonWithLastWallTile === false) return false;
	return matchAllPair(counts);
}

function matchGoldenGates(counts) {
	for (const suit of SUITS_NUM) {
		const dragon = CORRESPONDING_DRAGON[suit];
		const trial = cloneCounts(counts);
		let ok = true;
		for (const r of [2, 4, 6, 8]) {
			if (!take(trial, `${suit}-${r}`, 2)) {
				ok = false;
				break;
			}
		}
		if (!ok) continue;
		for (const terminal of [1, 9]) {
			const t2 = cloneCounts(trial);
			if (take(t2, `${suit}-${terminal}`, 3) && take(t2, `dragon-${dragon}`, 3) && remainingTotal(t2) === 0) return true;
		}
	}
	return false;
}

function matchWindyDragons(counts) {
	const base = cloneCounts(counts);
	for (const w of WIND_RANKS) if (!take(base, `wind-${w}`, 2)) return false;
	for (let i = 0; i < DRAGON_RANKS.length; i++) {
		for (let j = i + 1; j < DRAGON_RANKS.length; j++) {
			const t2 = cloneCounts(base);
			if (take(t2, `dragon-${DRAGON_RANKS[i]}`, 3) && take(t2, `dragon-${DRAGON_RANKS[j]}`, 3) && remainingTotal(t2) === 0) return true;
		}
	}
	return false;
}

function matchWindvane(counts) {
	const trial = cloneCounts(counts);
	if (!takeUniqueSetWithOnePaired(trial, WIND_RANKS.map((w) => `wind-${w}`))) return false;
	for (const suit of SUITS_NUM) {
		let placed = false;
		for (let r = 1; r <= 9; r++) {
			if (take(trial, `${suit}-${r}`, 3)) {
				placed = true;
				break;
			}
		}
		if (!placed) return false;
	}
	return remainingTotal(trial) === 0;
}

function matchCivilWar(counts) {
	for (const suitA of SUITS_NUM) {
		for (const suitB of SUITS_NUM) {
			if (suitA === suitB) continue;
			const trial = cloneCounts(counts);
			if (
				take(trial, 'wind-N', 3) &&
				take(trial, 'wind-S', 3) &&
				take(trial, `${suitA}-1`, 2) &&
				take(trial, `${suitA}-8`, 1) &&
				take(trial, `${suitA}-6`, 1) &&
				take(trial, `${suitB}-1`, 1) &&
				take(trial, `${suitB}-8`, 1) &&
				take(trial, `${suitB}-6`, 1) &&
				take(trial, `${suitB}-5`, 1) &&
				remainingTotal(trial) === 0
			) {
				return true;
			}
		}
	}
	return false;
}

// Up You Go / Down You Go need the kong's literal 4th tile (their 14-tile shape isn't the
// usual "4 melds + pair", so a kong here isn't just an interchangeable pung) — the general
// tally caps every kong at 3, so once a real concealed kong is confirmed we restore the tile
// the cap dropped before checking counts.
function matchUpYouGo(counts, ctx) {
	if (!ctx.player) return false;
	for (const suit of SUITS_NUM) {
		const hasConcealedKong = ctx.player.melds.some((m) => m.type === 'kong' && m.concealed && m.tiles[0].suit === suit && m.tiles[0].rank === 8);
		if (!hasConcealedKong) continue;
		const trial = cloneCounts(counts);
		trial[`${suit}-8`] = (trial[`${suit}-8`] || 0) + 1;
		if (!takeEachWind(trial)) continue;
		if (take(trial, `${suit}-2`, 1) && take(trial, `${suit}-4`, 2) && take(trial, `${suit}-6`, 3) && take(trial, `${suit}-8`, 4) && remainingTotal(trial) === 0) {
			return true;
		}
	}
	return false;
}

function matchDownYouGo(counts, ctx) {
	if (!ctx.player) return false;
	for (const suit of SUITS_NUM) {
		const hasConcealedKong = ctx.player.melds.some((m) => m.type === 'kong' && m.concealed && m.tiles[0].suit === suit && m.tiles[0].rank === 2);
		if (!hasConcealedKong) continue;
		const trial = cloneCounts(counts);
		trial[`${suit}-2`] = (trial[`${suit}-2`] || 0) + 1;
		if (!takeEachWind(trial)) continue;
		if (take(trial, `${suit}-2`, 4) && take(trial, `${suit}-4`, 3) && take(trial, `${suit}-6`, 2) && take(trial, `${suit}-8`, 1) && remainingTotal(trial) === 0) {
			return true;
		}
	}
	return false;
}

function matchRedWaratah(counts) {
	const base = cloneCounts(counts);
	if (!take(base, 'dragon-red', 3) || !take(base, 'dragon-green', 2)) return false;
	for (const redBambooRank of RED_BAMBOO_RANKS) {
		const t2 = cloneCounts(base);
		if (!take(t2, `bamboo-${redBambooRank}`, 3)) continue;
		for (let cr = 1; cr <= 9; cr++) {
			const t3 = cloneCounts(t2);
			if (!take(t3, `dots-${cr}`, 3)) continue;
			for (let hr = 1; hr <= 9; hr++) {
				const t4 = cloneCounts(t3);
				if (take(t4, `characters-${hr}`, 3) && remainingTotal(t4) === 0) return true;
			}
		}
	}
	return false;
}

function matchAllWindsAndDragons(counts) {
	const honorKeys = [...WIND_RANKS.map((w) => `wind-${w}`), ...DRAGON_RANKS.map((d) => `dragon-${d}`)];
	function search(remaining, trial, used) {
		if (remaining === 0) {
			const rem = Object.entries(trial).filter(([, v]) => v > 0);
			if (rem.length !== 1 || rem[0][1] !== 2) return false;
			return honorKeys.includes(rem[0][0]);
		}
		for (const key of honorKeys) {
			if (used.has(key)) continue;
			const t2 = cloneCounts(trial);
			if (take(t2, key, 3) && search(remaining - 1, t2, new Set([...used, key]))) return true;
		}
		return false;
	}
	return search(4, cloneCounts(counts), new Set());
}

const FULL_SPECIAL_HANDS = [
	...SPECIAL_HANDS,
	{ name: 'Guardian Winds', winning: 1000, fishing: 400, matches: (c) => matchGuardianWinds(c) },
	{ name: "Dragon's Gates", winning: 1000, fishing: 400, matches: (c) => matchDragonsGates(c) },
	{ name: "Dragon's Teeth", winning: 1000, fishing: 400, matches: (c) => matchDragonsTeeth(c) },
	{ name: 'Yin Yang', winning: 1000, fishing: 400, matches: (c) => matchYinYang(c) },
	{ name: 'Three Philosophers', winning: 1000, fishing: 400, matches: (c) => matchThreePhilosophers(c) },
	// Chow Chow's shape is a stricter (all-one-suit, procedural) subset of Crazy Chows at the
	// same score, so it's listed first to win the display-name tie when both match.
	{ name: 'Chow Chow', winning: 500, fishing: 200, matches: (c, ctx) => matchChowChow(c, ctx) },
	{ name: 'Crazy Chows', winning: 500, fishing: 200, matches: (c) => matchCrazyChows(c) },
	{ name: 'Little Robert', winning: 500, fishing: 200, matches: (c) => matchLittleRobert(c) },
	{ name: 'Chop Suey', winning: 1000, fishing: 400, matches: (c) => matchChopSuey(c) },
	{ name: 'Chow Mien', winning: 1000, fishing: 400, matches: (c) => matchChowMien(c) },
	{ name: 'Little Brother', winning: 500, fishing: 200, matches: (c, ctx) => matchLittleBrother(c, ctx) },
	{ name: 'Apple Blossom', winning: 1000, fishing: 400, matches: (c) => matchAppleBlossom(c) },
	{ name: 'The Professors', winning: 500, fishing: 200, matches: (c, ctx) => matchTheProfessors(c, ctx) },
	{ name: 'Odds & Evens', winning: 1500, fishing: 600, matches: (c) => matchOddsAndEvens(c) },
	{ name: 'Heads and Tails', winning: 1000, fishing: 400, matches: (c) => matchHeadsAndTails(c) },
	{ name: 'Robin', winning: 500, fishing: 200, matches: (c) => matchRobin(c) },
	{ name: 'All Pair Jade', winning: 1000, fishing: 400, matches: (c) => matchAllPairJade(c) },
	{ name: 'Imperial Jade', winning: 2000, fishing: 800, matches: (c) => matchImperialJade(c) },
	{ name: 'Lily of the Valley', winning: 2000, fishing: 800, matches: (c) => matchLilyOfTheValley(c) },
	{ name: 'Red Lily', winning: 2000, fishing: 800, matches: (c) => matchRedLily(c) },
	{ name: 'Royal Ruby', winning: 2000, fishing: 800, matches: (c) => matchRoyalRuby(c) },
	{ name: 'Ruby Jade', winning: 1000, fishing: 400, matches: (c) => matchRubyJade(c) },
	{ name: 'Lillypilly', winning: 1000, fishing: 400, matches: (c) => matchLillypilly(c) },
	{ name: 'Blue Mountains', winning: 1000, fishing: 400, matches: (c) => matchBlueMountains(c) },
	{ name: 'White Elephant', winning: 1000, fishing: 400, matches: (c) => matchWhiteElephant(c) },
	{ name: 'Driven Snow', winning: 1000, fishing: 400, matches: (c) => matchDrivenSnow(c) },
	{ name: "Dragon's Scales", winning: 1000, fishing: 400, matches: (c) => matchDragonsScales(c) },
	{ name: 'Dragonette', winning: 1000, fishing: 400, matches: (c) => matchDragonette(c) },
	{ name: "Dragon's Run", winning: 1500, fishing: 600, matches: (c) => matchDragonsRun(c) },
	{ name: 'Sunrise', winning: 1000, fishing: 400, matches: (c) => matchSunrise(c) },
	{ name: 'Sunset', winning: 1000, fishing: 400, matches: (c) => matchSunset(c) },
	{ name: 'Numbers in Parallel', winning: 1500, fishing: 600, matches: (c) => matchNumbersInParallel(c) },
	{ name: 'Numbers Doubled', winning: 1500, fishing: 600, matches: (c) => matchNumbersDoubled(c) },
	{ name: 'Chinese Odds', winning: 1500, fishing: 600, matches: (c) => matchChineseOdds(c) },
	{ name: 'Seven Twins', winning: 500, fishing: 200, matches: (c, ctx) => matchSevenTwins(c, ctx) },
	{ name: 'Golden Gates', winning: 1000, fishing: 400, matches: (c) => matchGoldenGates(c) },
	{ name: 'Windy Dragons', winning: 1000, fishing: 400, matches: (c) => matchWindyDragons(c) },
	{ name: 'Windvane', winning: 1000, fishing: 400, matches: (c) => matchWindvane(c) },
	{ name: 'Three Sisters', winning: 1000, fishing: 400, matches: (c) => matchWindyRank(c, 3) },
	{ name: 'Seven Brothers', winning: 1000, fishing: 400, matches: (c) => matchWindyRank(c, 7) },
	{ name: 'Civil War', winning: 1500, fishing: 600, matches: (c) => matchCivilWar(c) },
	{ name: 'Up You Go', winning: 2000, fishing: 800, matches: (c, ctx) => matchUpYouGo(c, ctx) },
	{ name: 'Down You Go', winning: 2000, fishing: 800, matches: (c, ctx) => matchDownYouGo(c, ctx) },
	{ name: 'Red Waratah', winning: 1000, fishing: 400, matches: (c) => matchRedWaratah(c) },
	{ name: 'All Winds and Dragons', winning: 1000, fishing: 400, matches: (c) => matchAllWindsAndDragons(c) }
];

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

function bestSpecialHandMatch(tally, ctx, handsList) {
	let best = null;
	for (const hand of handsList) {
		if (hand.matches(cloneCounts(tally), ctx) && (!best || hand.winning > best.winning)) best = hand;
	}
	return best;
}

function bestSpecialHandFishingMatch(partialTally, ctx, handsList) {
	let best = null;
	for (const probe of ALL_TILE_KINDS) {
		const key = `${probe.suit}-${probe.rank}`;
		const trial = cloneCounts(partialTally);
		trial[key] = (trial[key] || 0) + 1;
		const match = bestSpecialHandMatch(trial, ctx, handsList);
		if (match && (!best || match.fishing > best.fishing)) best = match;
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

const MAX_NAMED_HAND_FISHING_RESULTS = 8;

// For the Learning-mode hint: every named hand this player is exactly one tile away
// from right now, with which specific tile(s) would complete it. Cheap (checks each
// hand against each of the 34 tile kinds — no partial-progress search), so it only
// ever answers "how close is 1 tile", not "how close is 2 or 3 tiles".
function namedHandFishingOptions(player, handMode) {
	if (handMode === 'beginner') return [];
	const tally = specialHandTally(player, null);
	const ctx = { seatWind: player.seatWind, player };
	const results = [];
	for (const hand of handsListFor(handMode)) {
		const waits = [];
		for (const probe of ALL_TILE_KINDS) {
			const trial = cloneCounts(tally);
			const key = `${probe.suit}-${probe.rank}`;
			trial[key] = (trial[key] || 0) + 1;
			if (hand.matches(trial, ctx)) waits.push({ suit: probe.suit, rank: probe.rank });
		}
		if (waits.length > 0) results.push({ name: hand.name, winning: hand.winning, fishing: hand.fishing, waits });
	}
	results.sort((a, b) => b.winning - a.winning);
	return results.slice(0, MAX_NAMED_HAND_FISHING_RESULTS);
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
		myOriginalCallEligible: player.originalCallEligible,
		myOriginalCallActive: player.originalCallActive,
		myNamedHandFishing:
			game.status === 'playing' && player.assistMode === 'learning' ? namedHandFishingOptions(player, game.handMode) : [],
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
