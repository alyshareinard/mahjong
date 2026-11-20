import { computeHandScore, type Meld, type ScoreResult } from './scoring';
import { tileKey, type Tile, type Suit, type WindRank } from './tiles';
import { findWinCandidates, extractMeldsForScoring, settlePayments } from './mahjongCore.js';
import { applySpecialWinnerScore, applySpecialFishingScore } from './specialHands.js';

export type HandMode = 'beginner' | 'shortList' | 'fullList';

export interface PlayerEntry {
	name: string;
	/** Concealed tiles, including the winning tile for a winner. Excludes declared melds and flowers. */
	hand: Tile[];
	melds: Meld[];
	flowers: Tile[];
}

export interface HandConfig {
	roundWind: WindRank;
	dealerIndex: number;
	handMode: HandMode;
	winnerIndex: number | null;
	selfDraw: boolean;
	winningTileId: string | null;
	wonWithLastWallTile: boolean;
	wonWithFinalDiscard: boolean;
	originalCall: boolean;
}

export type HandResult = ScoreResult & { specialHand?: string };

export interface PlayerScore {
	result: HandResult;
	score: number;
	issue: string | null;
}

export interface HandOutcome {
	seatWinds: WindRank[];
	players: PlayerScore[];
	payments: number[];
	/** Reason the hand can't be recorded yet, or null when it's ready. */
	blocking: string | null;
}

const WINDS: WindRank[] = ['E', 'S', 'W', 'N'];

export function seatWindFor(playerIndex: number, dealerIndex: number): WindRank {
	return WINDS[(playerIndex - dealerIndex + 4) % 4];
}

let tileCounter = 0;
const idPrefix = Date.now().toString(36);
// The prefix keeps ids unique across page reloads, since entered tiles are saved to localStorage.
export function makeTile(suit: Suit, rank: Tile['rank'], kind?: 'flower' | 'season'): Tile {
	return { id: `sk-${idPrefix}-${tileCounter++}`, suit, rank, ...(kind ? { kind } : {}) };
}

/** Key used to cap how many copies of a tile can exist at the table (4 of each tile, 1 of each flower). */
export function usageKey(tile: Tile): string {
	return tile.suit === 'flower' ? `flower-${tile.kind}-${tile.rank}` : tileKey(tile);
}

function emptyResult(selfDraw: boolean, lastWall: boolean): HandResult {
	return {
		basic: 0,
		doubles: 0,
		detail: selfDraw ? [{ name: 'Drew winning tile from wall', value: 2 }] : [],
		doubleDetail: lastWall ? [{ name: 'Won with last tile from wall', count: 1 }] : [],
		rawScore: 0,
		cappedScore: 0
	};
}

function scoreWinner(entry: PlayerEntry, seatWind: WindRank, cfg: HandConfig): { result: HandResult; issue: string | null } {
	const declared = entry.melds;
	const meldsNeeded = 4 - declared.length;
	const winningKey = cfg.winningTileId ? entry.hand.find((t) => t.id === cfg.winningTileId) : undefined;
	const winningTileKey = winningKey ? tileKey(winningKey) : null;

	let best: ScoreResult | null = null;
	if (meldsNeeded >= 0 && entry.hand.length === meldsNeeded * 3 + 2) {
		for (const cand of findWinCandidates(entry.hand, meldsNeeded)) {
			const pool = [...entry.hand];
			const take = (key: string) => pool.splice(
				pool.findIndex((t) => tileKey(t) === key),
				1
			)[0];
			const inHand: Meld[] = cand.melds.map((m: { type: Meld['type']; keys: string[] }) => ({
				type: m.type,
				concealed: true,
				tiles: m.keys.map(take)
			}));
			take(cand.pairKey);
			take(cand.pairKey);
			// A pung completed by someone else's discard is exposed, not concealed.
			if (!cfg.selfDraw && winningTileKey) {
				const completed = inHand.find((m) => m.type === 'pung' && tileKey(m.tiles[0]) === winningTileKey);
				if (completed) completed.concealed = false;
			}
			const result = computeHandScore({
				melds: [...declared, ...inHand],
				pairKey: cand.pairKey,
				flowers: entry.flowers,
				seatWind,
				roundWind: cfg.roundWind,
				selfDraw: cfg.selfDraw,
				wonWithLastWallTile: cfg.wonWithLastWallTile,
				wonWithFinalDiscard: cfg.wonWithFinalDiscard,
				originalCall: cfg.originalCall
			});
			if (!best || result.rawScore > best.rawScore) best = result;
		}
	}

	let result: HandResult = best ?? emptyResult(cfg.selfDraw, cfg.wonWithLastWallTile);
	if (cfg.handMode !== 'beginner') {
		result = applySpecialWinnerScore({ seatWind, hand: entry.hand, melds: declared }, null, result, cfg.handMode);
	}
	const issue =
		!best && !result.specialHand
			? "This isn't a complete winning hand — check the tiles (a winner needs 4 sets and a pair, or a named hand)."
			: null;
	return { result, issue };
}

function scoreLoser(entry: PlayerEntry, seatWind: WindRank, cfg: HandConfig): HandResult {
	const extracted = extractMeldsForScoring(entry.hand);
	let result: HandResult = computeHandScore({
		melds: [...entry.melds, ...(extracted.melds as Meld[])],
		pairKey: extracted.pairKey ?? '',
		flowers: entry.flowers,
		seatWind,
		roundWind: cfg.roundWind,
		selfDraw: false,
		isWinner: false
	});
	if (cfg.handMode !== 'beginner') {
		result = applySpecialFishingScore({ seatWind, hand: entry.hand, melds: entry.melds }, result, cfg.handMode);
	}
	return result;
}

export function scoreHand(entries: PlayerEntry[], cfg: HandConfig): HandOutcome {
	const seatWinds = entries.map((_, i) => seatWindFor(i, cfg.dealerIndex));
	let blocking: string | null = null;
	if (cfg.winnerIndex !== null && !cfg.selfDraw && !cfg.winningTileId) {
		blocking = 'Tap the winning tile in the winner’s hand.';
	}

	const players: PlayerScore[] = entries.map((entry, i) => {
		if (i === cfg.winnerIndex) {
			const { result, issue } = scoreWinner(entry, seatWinds[i], cfg);
			if (issue && !blocking) blocking = `${entry.name}: ${issue}`;
			return { result, score: result.cappedScore, issue };
		}
		const result = scoreLoser(entry, seatWinds[i], cfg);
		return { result, score: result.cappedScore, issue: null };
	});

	const ids = entries.map((_, i) => String(i));
	const scores: Record<string, number> = {};
	ids.forEach((id, i) => (scores[id] = players[i].score));
	const paid = settlePayments(
		ids.map((id, i) => ({ id, seatWind: seatWinds[i] })),
		scores,
		cfg.winnerIndex === null ? null : String(cfg.winnerIndex)
	) as Record<string, number>;

	return { seatWinds, players, payments: ids.map((id) => paid[id]), blocking };
}

/** Expected concealed tile count for a winner (14 tiles' worth minus declared melds). */
export function expectedWinnerHandSize(entry: PlayerEntry): number {
	return (4 - entry.melds.length) * 3 + 2;
}
