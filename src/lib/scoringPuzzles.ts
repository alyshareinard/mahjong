import type { Tile, WindRank } from './tiles';
import type { Meld } from './scoring';

export interface ScoringPuzzle {
	id: string;
	title: string;
	blurb: string;
	melds: Meld[];
	pairTiles: [Tile, Tile];
	flowers: Tile[];
	seatWind: WindRank;
	roundWind: WindRank;
	selfDraw: boolean;
	wonWithLastWallTile?: boolean;
	wonWithFinalDiscard?: boolean;
}

let idc = 0;
function tile(suit: string, rank: number | string): Tile {
	return { id: `q-${suit}-${rank}-${idc++}`, suit: suit as Tile['suit'], rank: rank as Tile['rank'] };
}
function flowerTile(kind: 'flower' | 'season', rank: number): Tile {
	return { id: `q-flower-${kind}-${rank}-${idc++}`, suit: 'flower', rank: rank as Tile['rank'], kind };
}
function chow(suit: string, startRank: number, concealed: boolean): Meld {
	return { type: 'chow', concealed, tiles: [tile(suit, startRank), tile(suit, startRank + 1), tile(suit, startRank + 2)] };
}
function pung(suit: string, rank: number | string, concealed: boolean): Meld {
	return { type: 'pung', concealed, tiles: [tile(suit, rank), tile(suit, rank), tile(suit, rank)] };
}
function pair(suit: string, rank: number | string): [Tile, Tile] {
	return [tile(suit, rank), tile(suit, rank)];
}

export const scoringPuzzles: ScoringPuzzle[] = [
	{
		id: 'floor',
		title: '1. Just the basics',
		blurb: "You won off someone else's discard (not a self-draw), calling one of your chows from an earlier discard. Nothing fancy here — start by finding the floor.",
		melds: [chow('characters', 1, false), chow('characters', 4, true), chow('bamboo', 2, true), chow('dots', 5, true)],
		pairTiles: pair('dots', 9),
		flowers: [],
		seatWind: 'S',
		roundWind: 'E',
		selfDraw: false
	},
	{
		id: 'first-pung',
		title: '2. A single pung',
		blurb: 'You drew the winning tile yourself. One of your four sets is a pung you built without ever calling anyone — but you did call one chow earlier this hand, from a discard.',
		melds: [chow('characters', 1, false), chow('bamboo', 4, true), chow('dots', 2, true), pung('bamboo', 5, true)],
		pairTiles: pair('characters', 2),
		flowers: [],
		seatWind: 'W',
		roundWind: 'E',
		selfDraw: true
	},
	{
		id: 'fully-concealed',
		title: '3. All your own work',
		blurb: 'Same shape as last time, but this time you never called a single tile from anyone — every meld came from your own draws.',
		melds: [chow('characters', 1, true), chow('bamboo', 4, true), chow('dots', 2, true), pung('bamboo', 5, true)],
		pairTiles: pair('characters', 2),
		flowers: [],
		seatWind: 'W',
		roundWind: 'E',
		selfDraw: true
	},
	{
		id: 'double-wind',
		title: '4. Being the dealer pays off',
		blurb: "You're East, and it's an East round — your seat wind and the round wind are the same. You self-drew the winning tile.",
		melds: [chow('bamboo', 3, true), chow('dots', 6, true), chow('characters', 5, true), pung('wind', 'E', true)],
		pairTiles: pair('dots', 4),
		flowers: [],
		seatWind: 'E',
		roundWind: 'E',
		selfDraw: true
	},
	{
		id: 'dragons',
		title: '5. Dragon hoard',
		blurb: 'You have a concealed pung of one dragon, and your pair happens to be a different dragon. You called one pung from a discard; everything else is your own. Not a self-draw.',
		melds: [chow('bamboo', 2, true), pung('dragon', 'red', true), pung('characters', 8, false), chow('dots', 3, true)],
		pairTiles: pair('dragon', 'white'),
		flowers: [],
		seatWind: 'N',
		roundWind: 'E',
		selfDraw: false
	},
	{
		id: 'flowers',
		title: '6. A flowery hand',
		blurb: "You're South. Over the hand you picked up three bonus tiles, including the one that matches your own seat. You self-drew the winning tile.",
		melds: [chow('characters', 3, true), chow('bamboo', 5, true), chow('dots', 1, true), chow('characters', 6, true)],
		pairTiles: pair('wind', 'W'),
		flowers: [flowerTile('flower', 2), flowerTile('season', 4), flowerTile('season', 1)],
		seatWind: 'S',
		roundWind: 'E',
		selfDraw: true
	},
	{
		id: 'full-set-flowers',
		title: '7. The full bouquet',
		blurb: "Rare but glorious: over the course of play you picked up all four flower tiles. You're North. Not a self-draw this time.",
		melds: [chow('bamboo', 1, true), chow('bamboo', 4, true), pung('dots', 7, true), chow('characters', 2, false)],
		pairTiles: pair('dots', 2),
		flowers: [flowerTile('flower', 1), flowerTile('flower', 2), flowerTile('flower', 3), flowerTile('flower', 4)],
		seatWind: 'N',
		roundWind: 'E',
		selfDraw: false
	},
	{
		id: 'flush',
		title: '8. One suit to rule them all',
		blurb: "Every numbered tile in your hand is Characters — you've mixed in winds and dragons too, so it's a mixed (not pure) flush. Self-drawn.",
		melds: [chow('characters', 1, true), chow('characters', 4, true), pung('dragon', 'green', true), pung('wind', 'S', true)],
		pairTiles: pair('characters', 9),
		flowers: [],
		seatWind: 'S',
		roundWind: 'E',
		selfDraw: true
	},
	{
		id: 'book-example',
		title: "9. Straight from the book",
		blurb: "This is the exact hand from The Mah Jong Player's Companion's own worked example (p.24) — West went Mah-Jong, self-drawn, in a South round. See how many doubles you can find.",
		melds: [pung('characters', 6, false), pung('dragon', 'white', false), pung('characters', 9, true), pung('wind', 'S', false)],
		pairTiles: pair('dragon', 'red'),
		flowers: [flowerTile('flower', 3), flowerTile('season', 4)],
		seatWind: 'W',
		roundWind: 'S',
		selfDraw: true
	}
];
