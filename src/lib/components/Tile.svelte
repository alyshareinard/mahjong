<script lang="ts">
	import { tileColorClass, tileMainChar, tileName, tileSuitChar, type Tile } from '$lib/tiles';

	type UnderlineType = 'set' | 'pair' | 'taatsu';

	let {
		tile,
		selected = false,
		highlight = false,
		underlines = [],
		small = false,
		onclick
	}: {
		tile: Tile;
		selected?: boolean;
		highlight?: boolean;
		underlines?: { row: number; type: UnderlineType }[];
		small?: boolean;
		onclick?: () => void;
	} = $props();

	const main = $derived(tileMainChar(tile));
	const suitChar = $derived(tileSuitChar(tile));
	const colorClass = $derived(tileColorClass(tile));
	const sizeClass = $derived(small ? 'w-9 h-13 sm:w-10 sm:h-14' : 'w-12 h-17 sm:w-14 sm:h-20');

	const UNDERLINE_COLOR: Record<UnderlineType, string> = {
		set: 'bg-emerald-500',
		pair: 'bg-purple-500',
		taatsu: 'bg-sky-400'
	};

	const rowCount = $derived(underlines.length > 0 ? Math.max(...underlines.map((u) => u.row)) + 1 : 0);
	const rows = $derived(
		Array.from({ length: rowCount }, (_, row) => underlines.find((u) => u.row === row)?.type ?? null)
	);
</script>

<div class="flex flex-col items-center">
	<button
		type="button"
		class="relative {sizeClass} bg-[#fdfaf3] rounded-md shadow-md border border-black/10 flex flex-col items-center justify-center transition-transform hover:-translate-y-1 focus:outline-none focus:ring-2 focus:ring-amber-400 touch-manipulation"
		class:ring-2={selected || highlight}
		class:ring-amber-400={selected}
		class:-translate-y-2={selected}
		class:ring-yellow-400={highlight}
		title={tileName(tile)}
		aria-label={tileName(tile)}
		{onclick}
	>
		<span class="text-lg sm:text-xl font-bold leading-none {colorClass}">{main}</span>
		{#if suitChar}
			<span class="text-xs sm:text-sm leading-none mt-0.5 {colorClass}">{suitChar}</span>
		{/if}
	</button>
	{#if rowCount > 0}
		<div class="flex flex-col gap-0.5 mt-0.5 w-full">
			{#each rows as type}
				<div class="h-[3px] rounded-full {type ? UNDERLINE_COLOR[type] : 'bg-transparent'}"></div>
			{/each}
		</div>
	{/if}
</div>
