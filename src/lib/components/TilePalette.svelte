<script lang="ts">
	import { tileColorClass, tileMainChar, tileName, tileSuitChar, type Tile } from '$lib/tiles';

	let { isDisabled, onpick }: { isDisabled: (tile: Tile) => boolean; onpick: (tile: Tile) => void } = $props();

	function t(suit: Tile['suit'], rank: Tile['rank'], kind?: 'flower' | 'season'): Tile {
		return { id: `pal-${suit}-${rank}-${kind ?? ''}`, suit, rank, ...(kind ? { kind } : {}) };
	}

	const rows: { label: string; tiles: Tile[] }[] = [
		{ label: 'Characters', tiles: Array.from({ length: 9 }, (_, i) => t('characters', i + 1)) },
		{ label: 'Bamboo', tiles: Array.from({ length: 9 }, (_, i) => t('bamboo', i + 1)) },
		{ label: 'Dots', tiles: Array.from({ length: 9 }, (_, i) => t('dots', i + 1)) },
		{
			label: 'Winds & Dragons',
			tiles: [...(['E', 'S', 'W', 'N'] as const).map((w) => t('wind', w)), ...(['red', 'green', 'white'] as const).map((d) => t('dragon', d))]
		},
		{
			label: 'Flowers & Seasons',
			tiles: [1, 2, 3, 4].flatMap((n) => [t('flower', n, 'flower'), t('flower', n, 'season')])
		}
	];
</script>

<div class="space-y-1.5">
	{#each rows as row}
		<div class="flex flex-wrap gap-1" aria-label={row.label}>
			{#each row.tiles as tile}
				<button
					type="button"
					disabled={isDisabled(tile)}
					onclick={() => onpick(tile)}
					title={tileName(tile)}
					aria-label={tileName(tile)}
					class="w-8 h-11 sm:w-9 sm:h-12 bg-[#fdfaf3] rounded shadow border border-black/10 flex flex-col items-center justify-center leading-none touch-manipulation enabled:hover:-translate-y-0.5 transition-transform disabled:opacity-25"
				>
					<span class="text-base font-bold {tileColorClass(tile)}">{tileMainChar(tile)}</span>
					{#if tileSuitChar(tile)}
						<span class="text-[10px] mt-0.5 {tileColorClass(tile)}">{tileSuitChar(tile)}</span>
					{/if}
				</button>
			{/each}
		</div>
	{/each}
</div>
