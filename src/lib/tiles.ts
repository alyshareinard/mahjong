export type Suit = 'characters' | 'bamboo' | 'dots' | 'wind' | 'dragon' | 'flower';
export type WindRank = 'E' | 'S' | 'W' | 'N';
export type DragonRank = 'red' | 'green' | 'white';

export interface Tile {
	id: string;
	suit: Suit;
	rank: number | WindRank | DragonRank;
	kind?: 'flower' | 'season';
}

export function tileKey(tile: Tile): string {
	return `${tile.suit}-${tile.rank}`;
}

const SUIT_CHAR: Record<string, string> = {
	characters: '萬',
	bamboo: '索',
	dots: '筒'
};

const WIND_CHAR: Record<WindRank, string> = {
	E: '東',
	S: '南',
	W: '西',
	N: '北'
};

const WIND_NAME: Record<WindRank, string> = {
	E: 'East',
	S: 'South',
	W: 'West',
	N: 'North'
};

const DRAGON_CHAR: Record<DragonRank, string> = {
	red: '中',
	green: '發',
	white: '白'
};

const DRAGON_NAME: Record<DragonRank, string> = {
	red: 'Red Dragon',
	green: 'Green Dragon',
	white: 'White Dragon'
};

const FLOWER_CHAR: Record<number, string> = { 1: '梅', 2: '蘭', 3: '竹', 4: '菊' };
const SEASON_CHAR: Record<number, string> = { 1: '春', 2: '夏', 3: '秋', 4: '冬' };

export function tileMainChar(tile: Tile): string {
	if (tile.suit === 'wind') return WIND_CHAR[tile.rank as WindRank];
	if (tile.suit === 'dragon') return DRAGON_CHAR[tile.rank as DragonRank];
	if (tile.suit === 'flower') {
		return tile.kind === 'season' ? SEASON_CHAR[tile.rank as number] : FLOWER_CHAR[tile.rank as number];
	}
	return String(tile.rank);
}

export function tileSuitChar(tile: Tile): string {
	if (tile.suit === 'characters' || tile.suit === 'bamboo' || tile.suit === 'dots') {
		return SUIT_CHAR[tile.suit];
	}
	return '';
}

export function tileColorClass(tile: Tile): string {
	switch (tile.suit) {
		case 'characters':
			return 'text-red-600';
		case 'bamboo':
			return 'text-emerald-700';
		case 'dots':
			return 'text-blue-700';
		case 'wind':
			return 'text-slate-900';
		case 'dragon':
			if (tile.rank === 'red') return 'text-red-600';
			if (tile.rank === 'green') return 'text-emerald-700';
			return 'text-blue-700';
		case 'flower':
			return 'text-fuchsia-600';
	}
}

export function tileName(tile: Tile): string {
	if (tile.suit === 'wind') return `${WIND_NAME[tile.rank as WindRank]} Wind`;
	if (tile.suit === 'dragon') return DRAGON_NAME[tile.rank as DragonRank];
	if (tile.suit === 'flower') {
		const n = tile.rank as number;
		return tile.kind === 'season' ? `Season ${n}` : `Flower ${n}`;
	}
	const suitName = tile.suit === 'characters' ? 'Characters' : tile.suit === 'bamboo' ? 'Bamboo' : 'Dots';
	return `${tile.rank} of ${suitName}`;
}

const SUIT_ORDER: Record<Suit, number> = {
	characters: 0,
	bamboo: 1,
	dots: 2,
	wind: 3,
	dragon: 4,
	flower: 5
};

const WIND_ORDER: Record<WindRank, number> = { E: 0, S: 1, W: 2, N: 3 };
const DRAGON_ORDER: Record<DragonRank, number> = { red: 0, green: 1, white: 2 };

export function sortTiles(tiles: Tile[]): Tile[] {
	return [...tiles].sort((a, b) => {
		if (a.suit !== b.suit) return SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit];
		if (a.suit === 'wind') return WIND_ORDER[a.rank as WindRank] - WIND_ORDER[b.rank as WindRank];
		if (a.suit === 'dragon') return DRAGON_ORDER[a.rank as DragonRank] - DRAGON_ORDER[b.rank as DragonRank];
		return (a.rank as number) - (b.rank as number);
	});
}

export function windLabel(w: WindRank | null | undefined): string {
	return w ? WIND_NAME[w] : '';
}
