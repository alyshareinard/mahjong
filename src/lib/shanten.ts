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
}

export interface HandAnalysis {
	shanten: number;
	/**
	 * Every group (complete set, the pair, or a taatsu) that appears in ANY
	 * decomposition tying for the best shanten found — a flat, deduplicated
	 * pool of possibilities, not one consistent partition. When a hand is
	 * genuinely ambiguous (e.g. holding 5,6,6 of a suit, where either 5+6 or
	 * 6+6 works equally well), both groups show up here so the UI can present
	 * both rather than silently picking one.
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
// many distinct alternatives we keep bounds how many stacked underline rows
// the UI ever has to show — past this it stops being "here's the ambiguity"
// and starts being noise.
const MAX_GROUP_OPTIONS = 10;

export function analyzeHand(concealedTiles: TileLike[], meldsNeeded: number): HandAnalysis {
	const startCounts = tallyCounts(concealedTiles);
	let bestShanten = Infinity;
	const groupOptions: HandGroup[] = [];
	const seenGroupSignatures = new Set<string>();

	function groupSignature(g: HandGroup): string {
		return `${g.type}:${[...g.keys].sort().join(',')}`;
	}

	function finalize(groups: HandGroup[], slotsUsed: number, completeCount: number, hasPair: boolean) {
		const taatsuCount = slotsUsed - completeCount;
		let shanten = (meldsNeeded - completeCount) * 2 - taatsuCount - (hasPair ? 1 : 0);
		if (slotsUsed === meldsNeeded && !hasPair) shanten += 1;
		if (shanten < bestShanten) {
			bestShanten = shanten;
			groupOptions.length = 0;
			seenGroupSignatures.clear();
		}
		if (shanten === bestShanten) {
			for (const g of groups) {
				if (groupOptions.length >= MAX_GROUP_OPTIONS) break;
				const sig = groupSignature(g);
				if (!seenGroupSignatures.has(sig)) {
					seenGroupSignatures.add(sig);
					groupOptions.push(g);
				}
			}
		}
	}

	function search(
		counts: Record<string, number>,
		groups: HandGroup[],
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
	return { shanten: bestShanten, groupOptions };
}

/** Shanten number only — see {@link analyzeHand} for the full decomposition. */
export function evaluateShanten(concealedTiles: TileLike[], meldsNeeded: number): number {
	return analyzeHand(concealedTiles, meldsNeeded).shanten;
}

export interface TileUnderline {
	row: number;
	type: 'set' | 'pair' | 'taatsu';
}

/**
 * Resolves each candidate group onto actual positions in `hand` (the same
 * array order the caller renders), then assigns each group a "row" such that
 * two groups sharing a tile position never land on the same row — so a tile
 * that's ambiguous between two roles (e.g. 6 could pair with a neighboring 5
 * as a run, or with another 6 as a pair-toward-triplet) gets a separate,
 * visually stacked underline for each possibility instead of the two
 * conflicting on one line. Returns one underline list per hand position
 * (empty for tiles not part of any candidate group).
 */
export function computeUnderlines(hand: Tile[], groupOptions: HandGroup[]): TileUnderline[][] {
	const resolved: { type: HandGroup['type']; positions: number[] }[] = [];
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
		if (ok) resolved.push({ type: group.type, positions });
	}

	resolved.sort((a, b) => Math.min(...a.positions) - Math.min(...b.positions));

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
		for (const p of g.positions) result[p].push({ row: rows[i], type: g.type });
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
