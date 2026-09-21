<script lang="ts">
	let {
		hands,
		subtitle,
		onclose
	}: {
		hands: { name: string; winning: number; fishing: number; description: string }[];
		subtitle: string;
		onclose: () => void;
	} = $props();
</script>

<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onclick={onclose}>
	<div class="bg-slate-800 rounded-2xl p-6 shadow-2xl max-w-lg w-full max-h-[85vh] overflow-y-auto text-sm" onclick={(e) => e.stopPropagation()}>
		<h2 class="font-bold text-lg mb-1">🀄 Special Hands</h2>
		<p class="text-slate-400 text-xs mb-3">{subtitle}</p>
		<div class="space-y-2.5">
			{#each hands as hand}
				<div class="bg-black/20 rounded-lg px-3 py-2">
					<p class="flex items-baseline justify-between gap-2">
						<span class="font-semibold text-amber-200">{hand.name}</span>
						<span class="text-slate-400 text-xs whitespace-nowrap">{hand.winning} / {hand.fishing} pts</span>
					</p>
					<p class="text-slate-300 text-xs mt-0.5">{hand.description}</p>
				</div>
			{/each}
		</div>
		<button onclick={onclose} class="mt-4 w-full py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg font-semibold transition-colors touch-manipulation">
			Got it
		</button>
	</div>
</div>
