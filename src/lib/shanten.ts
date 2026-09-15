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
	groups: HandGroup[];
}

/**
 * Full shanten analysis for the "ordinary" (4 sets + 1 pair) hand shape, evaluated
 * over whatever tiles are passed in (works for a 13-tile hand, a 14-tile hand, or
 * any size — extra/unhelpful tiles are simply skipped by the search). -1 = complete,
 * 0 = tenpai (one tile away), higher = further away. `meldsNeeded` is 4 minus
 * however many melds are already exposed/declared. `groups` lists the tile-type
 * groups (complete sets, the pair, and taatsu) that make up the best decomposition
 * found — tiles not mentioned in any group are floating/unhelpful right now.
 */
export function analyzeHand(concealedTiles: TileLike[], meldsNeeded: number): HandAnalysis {
	const startCounts = tallyCounts(concealedTiles);
	let best: HandAnalysis = { shanten: Infinity, groups: [] };

	function finalize(groups: HandGroup[], slotsUsed: number, completeCount: number, hasPair: boolean) {
		const taatsuCount = slotsUsed - completeCount;
		let shanten = (meldsNeeded - completeCount) * 2 - taatsuCount - (hasPair ? 1 : 0);
		if (slotsUsed === meldsNeeded && !hasPair) shanten += 1;
		if (shanten < best.shanten) best = { shanten, groups };
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
	return best;
}

/** Shanten number only — see {@link analyzeHand} for the full decomposition. */
export function evaluateShanten(concealedTiles: TileLike[], meldsNeeded: number): number {
	return analyzeHand(concealedTiles, meldsNeeded).shanten;
}

/**
 * Maps each group from a HandAnalysis onto specific tile ids from the hand
 * (any matching instance will do, since same-type tiles are interchangeable),
 * for highlighting a player's hand by role. Tiles in no group are left unmapped.
 */
export function assignHandGroups(hand: Tile[], groups: HandGroup[]): Map<string, 'set' | 'pair' | 'taatsu'> {
	const used = new Set<string>();
	const map = new Map<string, 'set' | 'pair' | 'taatsu'>();
	for (const group of groups) {
		for (const key of group.keys) {
			const match = hand.find((t) => !used.has(t.id) && tileKey(t) === key);
			if (match) {
				used.add(match.id);
				map.set(match.id, group.type);
			}
		}
	}
	return map;
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
