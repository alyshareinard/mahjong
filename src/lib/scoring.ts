import { tileName, type Tile, type WindRank } from './tiles';

export type MeldType = 'chow' | 'pung' | 'kong';

export interface Meld {
	type: MeldType;
	concealed: boolean;
	tiles: Tile[];
}

export const LIMIT = 1000;
const OWN_FLOWER_RANK: Record<string, number> = { E: 1, S: 2, W: 3, N: 4 };

// Mirrors socket-handler.js's scoring engine (The Mah Jong Player's Companion,
// pp.22-25) so the learning quiz always agrees with the live game. If the
// live scoring rules ever change, update both.

function tileKeyOf(t: { suit: string; rank: number | string }): string {
	return `${t.suit}-${t.rank}`;
}

function isMajorTile(tile: { suit: string; rank: number | string }): boolean {
	if (tile.suit === 'wind' || tile.suit === 'dragon') return true;
	if (tile.suit === 'characters' || tile.suit === 'bamboo' || tile.suit === 'dots') {
		return tile.rank === 1 || tile.rank === 9;
	}
	return false;
}

function meldPoints(meld: Meld): number {
	if (meld.type === 'chow') return 0;
	const major = isMajorTile(meld.tiles[0]);
	if (meld.type === 'pung') return meld.concealed ? (major ? 8 : 4) : major ? 4 : 2;
	return meld.concealed ? (major ? 32 : 16) : major ? 16 : 8;
}

function pairBonusPoints(pairKey: string, seatWind: WindRank, roundWind: WindRank): number {
	const [suit, rank] = pairKey.split('-');
	if (suit === 'dragon') return 2;
	if (suit === 'wind') {
		let pts = 0;
		if (rank === seatWind) pts += 2;
		if (rank === roundWind) pts += 2;
		return pts;
	}
	return 0;
}

export interface ScoreContext {
	melds: Meld[];
	pairKey: string;
	flowers: Tile[];
	seatWind: WindRank;
	roundWind: WindRank;
	selfDraw: boolean;
	wonWithLastWallTile?: boolean;
	wonWithFinalDiscard?: boolean;
}

export interface ScoreDetail {
	name: string;
	value: number;
}
export interface DoubleDetail {
	name: string;
	count: number;
}
export interface ScoreResult {
	basic: number;
	doubles: number;
	detail: ScoreDetail[];
	doubleDetail: DoubleDetail[];
	rawScore: number;
	cappedScore: number;
}

/** Scores a complete (winning) hand exactly as the live game would. */
export function computeHandScore(ctx: ScoreContext): ScoreResult {
	const { melds, pairKey, flowers, seatWind, roundWind, selfDraw, wonWithLastWallTile, wonWithFinalDiscard } = ctx;
	const detail: ScoreDetail[] = [];
	let basic = 0;
	function addBasic(name: string, value: number) {
		if (value) {
			basic += value;
			detail.push({ name, value });
		}
	}
	const doubleDetail: DoubleDetail[] = [];
	let doubles = 0;
	function addDouble(name: string, count = 1) {
		doubles += count;
		doubleDetail.push({ name, count });
	}

	for (const m of melds) {
		const pts = meldPoints(m);
		if (pts > 0) addBasic(`${m.concealed ? 'Concealed' : 'Exposed'} ${m.type} of ${tileName(m.tiles[0])}`, pts);
	}
	if (pairKey) {
		const pts = pairBonusPoints(pairKey, seatWind, roundWind);
		const [pSuit, pRankRaw] = pairKey.split('-');
		const pRank = pSuit === 'wind' || pSuit === 'dragon' ? pRankRaw : parseInt(pRankRaw, 10);
		if (pts > 0) addBasic(`Pair of ${tileName({ suit: pSuit, rank: pRank } as Tile)}`, pts);
	}
	if (flowers.length > 0) addBasic(`Flowers/Seasons x${flowers.length}`, flowers.length * 4);
	addBasic('Going Mah-Jong', 20);
	if (selfDraw) addBasic('Drew winning tile from wall', 2);

	for (const m of melds) {
		if (m.type === 'chow') continue;
		const key = tileKeyOf(m.tiles[0]);
		if (key.startsWith('dragon-')) addDouble(`Dragon ${m.type}`);
		if (key.startsWith('wind-')) {
			const w = key.split('-')[1];
			if (w === seatWind) addDouble(`Own wind ${m.type}`);
			if (w === roundWind) addDouble(`Round wind ${m.type}`);
		}
	}
	const ownFlowerRank = OWN_FLOWER_RANK[seatWind];
	if (flowers.some((f) => f.kind === 'flower' && f.rank === ownFlowerRank)) addDouble('Holding own Flower');
	if (flowers.some((f) => f.kind === 'season' && f.rank === ownFlowerRank)) addDouble('Holding own Season');
	if ([1, 2, 3, 4].every((n) => flowers.some((f) => f.kind === 'flower' && f.rank === n))) addDouble('Complete set of Flowers', 2);
	if ([1, 2, 3, 4].every((n) => flowers.some((f) => f.kind === 'season' && f.rank === n))) addDouble('Complete set of Seasons', 2);

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

	const rawScore = Math.round(basic * Math.pow(2, doubles));
	const cappedScore = Math.min(rawScore, LIMIT);
	return { basic, doubles, detail, doubleDetail, rawScore, cappedScore };
}
