import type { Tile } from './tiles';

type TileLike = { suit: string; rank: number | string };

const SUITED_SUITS = ['characters', 'bamboo', 'dots'];
const WIND_RANKS: Array<'E' | 'S' | 'W' | 'N'> = ['E', 'S', 'W', 'N'];
const DRAGON_RANKS: Array<'red' | 'green' | 'white'> = ['red', 'green', 'white'];

const SUIT_ORDER: Record<string, number> = { characters: 0, bamboo: 1, dots: 2, wind: 3, dragon: 4 };
const WIND_SEQ: Record<string, number> = { E: 0, S: 1, W: 2, N: 3 };
const DRAGON_SEQ: Record<string, number> = { red: 0, green: 1, white: 2 };

function tileKey(t: TileLike): string {
	return `${t.suit}-${t.rank}`;
}

function keyOrder(key: string): number {
	const [suit, rankRaw] = key.split('-');
	const suitOrd = SUIT_ORDER[suit] ?? 9;
	let rankOrd: number;
	if (suit === 'wind') rankOrd = WIND_SEQ[rankRaw] ?? 0;
	else if (suit === 'dragon') rankOrd = DRAGON_SEQ[rankRaw] ?? 0;
	else rankOrd = parseInt(rankRaw, 10);
	return suitOrd * 100 + rankOrd;
}

function tallyCounts(tiles: TileLike[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const t of tiles) {
		const k = tileKey(t);
		counts[k] = (counts[k] || 0) + 1;
	}
	return counts;
}

export interface HandGroup {
	type: 'set' | 'pair' | 'taatsu';
	keys: string[];
	/**
	 * False for a group that only shows up one tile further from tenpai than
	 * the best decomposition found — e.g. keeping a completed pung intact when
	 * breaking it for an immediate pair is actually one tile closer. Still
	 * worth surfacing (a human eye reasonably expects a made set to show up),
	 * just not as the primary suggestion — the UI renders these dashed.
	 */
	optimal: boolean;
}

export interface HandAnalysis {
	shanten: number;
	/**
	 * Every group (complete set, the pair, or a taatsu) that appears in ANY
	 * decomposition tying for the best shanten found, plus near-miss groups
	 * one tile further away (`optimal: false`) — a flat, deduplicated pool of
	 * possibilities, not one consistent partition. When a hand is genuinely
	 * ambiguous (e.g. holding 5,6,6 of a suit, where either 5+6 or 6+6 works
	 * equally well), both groups show up here so the UI can present both
	 * rather than silently picking one.
	 */
	groupOptions: HandGroup[];
}

/**
 * Full shanten analysis for the "ordinary" (4 sets + 1 pair) hand shape, evaluated
 * over whatever tiles are passed in (works for a 13-tile hand, a 14-tile hand, or
 * any size — extra/unhelpful tiles are simply skipped by the search). -1 = complete,
 * 0 = tenpai (one tile away), higher = further away. `meldsNeeded` is 4 minus
 * however many melds are already exposed/declared.
 */
// A hand with a few identical/adjacent tiles can genuinely tie across many
// decompositions (e.g. 5,6,7,7,7 of a suit ties several ways). Capping how
// many distinct alternatives we keep (separately for the optimal and the
// one-tile-worse near-miss tiers) bounds how many stacked underline rows the
// UI ever has to show — past this it stops being "here's the ambiguity" and
// starts being noise.
const MAX_GROUP_OPTIONS = 10;
const MAX_NEAR_MISS_GROUP_OPTIONS = 10;

export function analyzeHand(concealedTiles: TileLike[], meldsNeeded: number): HandAnalysis {
	const startCounts = tallyCounts(concealedTiles);
	const totalTiles = concealedTiles.length;
	const found: { shanten: number; groups: Omit<HandGroup, 'optimal'>[] }[] = [];

	function finalize(groups: Omit<HandGroup, 'optimal'>[], slotsUsed: number, completeCount: number, hasPair: boolean) {
		const taatsuCount = slotsUsed - completeCount;
		let shanten = (meldsNeeded - completeCount) * 2 - taatsuCount - (hasPair ? 1 : 0);
		// The classic "no pair yet" penalty only makes sense when every tile has
		// genuinely been committed to a meld or taatsu — if there's a tile left
		// over (e.g. 4 complete melds + one unpaired single, a tanki wait), that
		// spare tile IS the pair candidate, and applying the penalty anyway is
		// what made an obvious tenpai/near-tenpai hand read as needing an extra,
		// unnecessary exchange (and flooded ukeire with irrelevant tiles).
		const leftover = totalTiles - (completeCount * 3 + taatsuCount * 2 + (hasPair ? 2 : 0));
		if (slotsUsed === meldsNeeded && !hasPair && leftover <= 0) shanten += 1;
		found.push({ shanten, groups });
	}

	function search(
		counts: Record<string, number>,
		groups: Omit<HandGroup, 'optimal'>[],
		slotsUsed: number,
		completeCount: number,
		hasPair: boolean
	) {
		const keys = Object.keys(counts)
			.filter((k) => counts[k] > 0)
			.sort((a, b) => keyOrder(a) - keyOrder(b));
		if (keys.length === 0) {
			finalize(groups, slotsUsed, completeCount, hasPair);
			return;
		}
		const key = keys[0];
		const [suit, rankRaw] = key.split('-');
		const isSuited = SUITED_SUITS.includes(suit);
		const rank = isSuited ? parseInt(rankRaw, 10) : 0;
		const count = counts[key];

		if (count >= 3 && slotsUsed < meldsNeeded) {
			const next = { ...counts };
			next[key] -= 3;
			search(next, [...groups, { type: 'set', keys: [key, key, key] }], slotsUsed + 1, completeCount + 1, hasPair);
		}
		if (isSuited && rank <= 7 && slotsUsed < meldsNeeded) {
			const k2 = `${suit}-${rank + 1}`;
			const k3 = `${suit}-${rank + 2}`;
			if ((counts[k2] || 0) >= 1 && (counts[k3] || 0) >= 1) {
				const next = { ...counts };
				next[key] -= 1;
				next[k2] -= 1;
				next[k3] -= 1;
				search(next, [...groups, { type: 'set', keys: [key, k2, k3] }], slotsUsed + 1, completeCount + 1, hasPair);
			}
		}
		if (count >= 2 && slotsUsed < meldsNeeded) {
			const next = { ...counts };
			next[key] -= 2;
			search(next, [...groups, { type: 'taatsu', keys: [key, key] }], slotsUsed + 1, completeCount, hasPair);
		}
		if (isSuited && rank <= 8 && slotsUsed < meldsNeeded) {
			const k2 = `${suit}-${rank + 1}`;
			if ((counts[k2] || 0) >= 1) {
				const next = { ...counts };
				next[key] -= 1;
				next[k2] -= 1;
				search(next, [...groups, { type: 'taatsu', keys: [key, k2] }], slotsUsed + 1, completeCount, hasPair);
			}
		}
		if (isSuited && rank <= 7 && slotsUsed < meldsNeeded) {
			const k3 = `${suit}-${rank + 2}`;
			if ((counts[k3] || 0) >= 1) {
				const next = { ...counts };
				next[key] -= 1;
				next[k3] -= 1;
				search(next, [...groups, { type: 'taatsu', keys: [key, k3] }], slotsUsed + 1, completeCount, hasPair);
			}
		}
		if (count >= 2 && !hasPair) {
			const next = { ...counts };
			next[key] -= 2;
			search(next, [...groups, { type: 'pair', keys: [key, key] }], slotsUsed, completeCount, true);
		}
		{
			const next = { ...counts };
			next[key] -= 1;
			search(next, groups, slotsUsed, completeCount, hasPair);
		}
	}

	search(startCounts, [], 0, 0, false);

	const bestShanten = Math.min(...found.map((f) => f.shanten));
	const groupOptions: HandGroup[] = [];
	// Keyed without the optimal flag: a group already shown at its best tier
	// shouldn't also show up dashed as a near-miss duplicate of itself.
	const seenGroupSignatures = new Set<string>();
	function groupSignature(g: Omit<HandGroup, 'optimal'>): string {
		return `${g.type}:${[...g.keys].sort().join(',')}`;
	}
	function collect(targetShanten: number, optimal: boolean, cap: number) {
		let count = 0;
		for (const f of found) {
			if (f.shanten !== targetShanten) continue;
			for (const g of f.groups) {
				if (count >= cap) return;
				const sig = groupSignature(g);
				if (seenGroupSignatures.has(sig)) continue;
				seenGroupSignatures.add(sig);
				groupOptions.push({ ...g, optimal });
				count++;
			}
		}
	}
	collect(bestShanten, true, MAX_GROUP_OPTIONS);
	collect(bestShanten + 1, false, MAX_NEAR_MISS_GROUP_OPTIONS);

	// A near-miss taatsu/pair whose tiles are entirely inside an optimal complete
	// set is never worth showing — it's just "here's a worse way to read the same
	// tiles you already have a made meld from" (e.g. 7-8 and 8-9 dashed under a
	// 7-8-9 chow that's already solid). Only filters near-miss groups; an optimal
	// set/pair/taatsu is kept even if some other optimal set also covers its tiles.
	function keysSubsetOf(candidate: string[], container: string[]): boolean {
		const remaining = [...container];
		for (const k of candidate) {
			const idx = remaining.indexOf(k);
			if (idx === -1) return false;
			remaining.splice(idx, 1);
		}
		return true;
	}
	const optimalSetKeyLists = groupOptions.filter((g) => g.optimal && g.type === 'set').map((g) => g.keys);
	const filtered = groupOptions.filter(
		(g) => g.optimal || g.type === 'set' || !optimalSetKeyLists.some((setKeys) => keysSubsetOf(g.keys, setKeys))
	);

	return { shanten: bestShanten, groupOptions: filtered };
}

/** Shanten number only — see {@link analyzeHand} for the full decomposition. */
export function evaluateShanten(concealedTiles: TileLike[], meldsNeeded: number): number {
	return analyzeHand(concealedTiles, meldsNeeded).shanten;
}

export interface TileUnderline {
	row: number;
	type: 'set' | 'pair' | 'taatsu';
	/** False renders as a dashed line — see {@link HandGroup.optimal}. */
	optimal: boolean;
	/** True if the next hand position is also part of this same group at this
	 * row, so the renderer can bridge the gap between the two tiles rather
	 * than showing two visually separate stub bars. */
	extendRight: boolean;
}

/**
 * Resolves each candidate group onto actual positions in `hand` (the same
 * array order the caller renders), then assigns each group a "row" such that
 * two groups sharing a tile position never land on the same row — so a tile
 * that's ambiguous between two roles (e.g. 6 could pair with a neighboring 5
 * as a run, or with another 6 as a pair-toward-triplet) gets a separate,
 * visually stacked underline for each possibility instead of the two
 * conflicting on one line. Optimal groups claim rows first, so a tile's
 * best-decomposition role always lands on row 0 when it has one. Returns one
 * underline list per hand position (empty for tiles not part of any
 * candidate group).
 */
export function computeUnderlines(hand: Tile[], groupOptions: HandGroup[]): TileUnderline[][] {
	const resolved: { type: HandGroup['type']; optimal: boolean; positions: number[] }[] = [];
	for (const group of groupOptions) {
		const used = new Set<number>();
		const positions: number[] = [];
		let ok = true;
		for (const key of group.keys) {
			const idx = hand.findIndex((t, i) => !used.has(i) && tileKey(t) === key);
			if (idx === -1) {
				ok = false;
				break;
			}
			used.add(idx);
			positions.push(idx);
		}
		if (ok) resolved.push({ type: group.type, optimal: group.optimal, positions });
	}

	resolved.sort((a, b) => Number(b.optimal) - Number(a.optimal) || Math.min(...a.positions) - Math.min(...b.positions));

	const rowOccupancy: Set<number>[] = [];
	const rows: number[] = [];
	for (const g of resolved) {
		let row = 0;
		while (rowOccupancy[row] && g.positions.some((p) => rowOccupancy[row].has(p))) row++;
		if (!rowOccupancy[row]) rowOccupancy[row] = new Set();
		for (const p of g.positions) rowOccupancy[row].add(p);
		rows.push(row);
	}

	const result: TileUnderline[][] = hand.map(() => []);
	resolved.forEach((g, i) => {
		const sortedPositions = [...g.positions].sort((a, b) => a - b);
		for (let k = 0; k < sortedPositions.length; k++) {
			const pos = sortedPositions[k];
			const extendRight = sortedPositions[k + 1] === pos + 1;
			result[pos].push({ row: rows[i], type: g.type, optimal: g.optimal, extendRight });
		}
	});
	return result;
}

function allTileTypes(): TileLike[] {
	const types: TileLike[] = [];
	for (const suit of SUITED_SUITS) for (let rank = 1; rank <= 9; rank++) types.push({ suit, rank });
	for (const rank of WIND_RANKS) types.push({ suit: 'wind', rank });
	for (const rank of DRAGON_RANKS) types.push({ suit: 'dragon', rank });
	return types;
}

export interface UkeireTile {
	tile: TileLike;
	shantenAfter: number;
}

/** Tile types that would improve shanten if added to this hand. */
export function computeUkeire(hand: TileLike[], meldsNeeded: number): UkeireTile[] {
	const current = evaluateShanten(hand, meldsNeeded);
	const useful: UkeireTile[] = [];
	for (const type of allTileTypes()) {
		const shantenAfter = evaluateShanten([...hand, type], meldsNeeded);
		if (shantenAfter < current) useful.push({ tile: type, shantenAfter });
	}
	return useful;
}

export interface DiscardSuggestion {
	tileId: string;
	tile: Tile;
	resultingShanten: number;
	ukeireCount: number;
}

/** Ranks every distinct tile in a (14-tile) hand by how good a discard it'd be. */
export function suggestDiscards(hand: Tile[], meldsNeeded: number): DiscardSuggestion[] {
	const seen = new Set<string>();
	const results: DiscardSuggestion[] = [];
	for (const tile of hand) {
		const key = tileKey(tile);
		if (seen.has(key)) continue;
		seen.add(key);
		const remaining = hand.filter((t) => t.id !== tile.id);
		const resultingShanten = evaluateShanten(remaining, meldsNeeded);
		const ukeireCount = computeUkeire(remaining, meldsNeeded).length;
		results.push({ tileId: tile.id, tile, resultingShanten, ukeireCount });
	}
	results.sort((a, b) => a.resultingShanten - b.resultingShanten || b.ukeireCount - a.ukeireCount);
	return results;
}

export interface ClaimEvaluation {
	type: 'pong' | 'kong' | 'chi';
	tileIds?: [string, string];
	resultingShanten: number;
}

/** Evaluates each available claim (pong/kong/chi) against doing nothing. */
export function evaluateClaimOptions(
	hand: Tile[],
	exposedMeldsCount: number,
	discardTile: Tile,
	options: { canPong: boolean; canKong: boolean; chiOptions: [string, string][] }
): { currentShanten: number; evaluations: ClaimEvaluation[] } {
	const meldsNeeded = 4 - exposedMeldsCount;
	const currentShanten = evaluateShanten(hand, meldsNeeded);
	const evaluations: ClaimEvaluation[] = [];

	if (options.canPong) {
		const matching = hand.filter((t) => t.suit === discardTile.suit && t.rank === discardTile.rank).slice(0, 2);
		const remaining = hand.filter((t) => !matching.includes(t));
		evaluations.push({ type: 'pong', resultingShanten: evaluateShanten(remaining, meldsNeeded - 1) });
	}
	if (options.canKong) {
		const matching = hand.filter((t) => t.suit === discardTile.suit && t.rank === discardTile.rank).slice(0, 3);
		const remaining = hand.filter((t) => !matching.includes(t));
		evaluations.push({ type: 'kong', resultingShanten: evaluateShanten(remaining, meldsNeeded - 1) });
	}
	for (const pair of options.chiOptions) {
		const remaining = hand.filter((t) => !pair.includes(t.id));
		evaluations.push({ type: 'chi', tileIds: pair, resultingShanten: evaluateShanten(remaining, meldsNeeded - 1) });
	}

	return { currentShanten, evaluations };
}

export function shantenLabel(shanten: number): string {
	if (shanten <= -1) return 'Complete';
	if (shanten === 0) return 'Tenpai (1 tile away)';
	return `${shanten} tiles away`;
}
