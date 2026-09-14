<script lang="ts">
	import { tileColorClass, tileMainChar, tileName, tileSuitChar, type Tile } from '$lib/tiles';

	let {
		tile,
		selected = false,
		highlight = false,
		small = false,
		onclick
	}: {
		tile: Tile;
		selected?: boolean;
		highlight?: boolean;
		small?: boolean;
		onclick?: () => void;
	} = $props();

	const main = $derived(tileMainChar(tile));
	const suitChar = $derived(tileSuitChar(tile));
	const colorClass = $derived(tileColorClass(tile));
	const sizeClass = $derived(small ? 'w-9 h-13 sm:w-10 sm:h-14' : 'w-12 h-17 sm:w-14 sm:h-20');
</script>

<button
	type="button"
	class="relative {sizeClass} bg-[#fdfaf3] rounded-md shadow-md border border-black/10 flex flex-col items-center justify-center transition-transform hover:-translate-y-1 focus:outline-none focus:ring-2 focus:ring-amber-400 touch-manipulation"
	class:ring-2={selected}
	class:ring-amber-400={selected}
	class:-translate-y-2={selected}
	class:ring-emerald-400={highlight}
	aria-label={tileName(tile)}
	{onclick}
>
	<span class="text-lg sm:text-xl font-bold leading-none {colorClass}">{main}</span>
	{#if suitChar}
		<span class="text-xs sm:text-sm leading-none mt-0.5 {colorClass}">{suitChar}</span>
	{/if}
</button>
