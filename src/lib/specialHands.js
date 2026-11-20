// @ts-nocheck
// Named special hands (The Mah Jong Player's Companion): distance/match logic and scoring
// helpers. Shared by the live game server and the client-side scoring app.
import { SUITS_NUM, WIND_RANKS, DRAGON_RANKS, tileKeyOf, tallyCounts, cloneCounts, ALL_TILE_KINDS } from './mahjongCore.js';
import { SHORT_LIST_HANDS, FULL_LIST_EXTRA_HANDS } from './specialHandsData.js';

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


export {
	SPECIAL_HANDS,
	FULL_SPECIAL_HANDS,
	specialHandTally,
	handsListFor,
	handDistance,
	bestSpecialHandMatch,
	applySpecialWinnerScore,
	applySpecialFishingScore,
	namedHandDistances
};
