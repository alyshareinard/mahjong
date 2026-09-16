<script lang="ts">
	import { goto } from '$app/navigation';
	import { scoringPuzzles } from '$lib/scoringPuzzles';
	import { computeHandScore } from '$lib/scoring';
	import { tileName, windLabel, type Tile as TileT } from '$lib/tiles';
	import TileComponent from '$lib/components/Tile.svelte';

	type Stage = 'basic' | 'doubles' | 'final' | 'done';

	let puzzleIndex = $state(0);
	let stage: Stage = $state('basic');
	let basicInput: number | '' = $state('');
	let doublesInput: number | '' = $state('');
	let finalInput: number | '' = $state('');
	let basicSubmitted = $state(false);
	let doublesSubmitted = $state(false);
	let finalSubmitted = $state(false);
	let basicHintsRevealed = $state(0);
	let doublesHintsRevealed = $state(0);
	let showReference = $state(false);
	let tally = $state({ correct: 0, total: 0 });

	let puzzle = $derived(scoringPuzzles[puzzleIndex]);
	let pairKey = $derived(`${puzzle.pairTiles[0].suit}-${puzzle.pairTiles[0].rank}`);
	let result = $derived(
		computeHandScore({
			melds: puzzle.melds,
			pairKey,
			flowers: puzzle.flowers,
			seatWind: puzzle.seatWind,
			roundWind: puzzle.roundWind,
			selfDraw: puzzle.selfDraw,
			wonWithLastWallTile: puzzle.wonWithLastWallTile,
			wonWithFinalDiscard: puzzle.wonWithFinalDiscard
		})
	);

	// `bind:value` on a type="number" input gives a `number` (or NaN if blank/invalid),
	// not a string — despite the $state('') initial value, so don't assume .trim() works.
	function isBlank(v: unknown): boolean {
		return v === '' || v === null || v === undefined || Number.isNaN(v);
	}

	let basicCorrect = $derived(!isBlank(basicInput) && Number(basicInput) === result.basic);
	let doublesCorrect = $derived(!isBlank(doublesInput) && Number(doublesInput) === result.doubles);
	let finalCorrect = $derived(!isBlank(finalInput) && Number(finalInput) === result.cappedScore);

	function submitBasic() {
		if (isBlank(basicInput) || basicSubmitted) return;
		basicSubmitted = true;
		tally.total += 1;
		if (basicCorrect) tally.correct += 1;
	}
	function submitDoubles() {
		if (isBlank(doublesInput) || doublesSubmitted) return;
		doublesSubmitted = true;
		tally.total += 1;
		if (doublesCorrect) tally.correct += 1;
	}
	function submitFinal() {
		if (isBlank(finalInput) || finalSubmitted) return;
		finalSubmitted = true;
		tally.total += 1;
		if (finalCorrect) tally.correct += 1;
	}

	function nextPuzzle() {
		if (puzzleIndex < scoringPuzzles.length - 1) {
			puzzleIndex += 1;
			resetPuzzleState();
		} else {
			stage = 'done';
		}
	}

	function resetPuzzleState() {
		stage = 'basic';
		basicInput = '';
		doublesInput = '';
		finalInput = '';
		basicSubmitted = false;
		doublesSubmitted = false;
		finalSubmitted = false;
		basicHintsRevealed = 0;
		doublesHintsRevealed = 0;
	}

	function restart() {
		puzzleIndex = 0;
		tally = { correct: 0, total: 0 };
		resetPuzzleState();
	}

	function meldLabel(m: (typeof puzzle.melds)[number]) {
		return `${m.concealed ? 'Concealed' : 'Exposed'} ${m.type}`;
	}
</script>

<div class="min-h-screen flex flex-col items-center bg-gradient-to-br from-emerald-950 to-slate-900 text-white p-4 sm:p-6">
	<div class="w-full max-w-2xl flex items-center justify-between mb-4">
		<button onclick={() => goto('/')} class="text-sm text-emerald-200/70 hover:text-emerald-100 transition-colors touch-manipulation">← Home</button>
		<h1 class="text-lg font-bold">Learn Scoring</h1>
		<span class="text-sm text-emerald-200/70">Score: {tally.correct}/{tally.total}</span>
	</div>

	{#if stage === 'done'}
		<div class="bg-white/10 backdrop-blur rounded-2xl p-8 max-w-md w-full text-center shadow-2xl border border-white/10">
			<p class="text-2xl font-bold mb-2">🎉 All done!</p>
			<p class="text-emerald-100 mb-6">You scored {tally.correct} out of {tally.total} across all {scoringPuzzles.length} hands.</p>
			<button onclick={restart} class="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 rounded-lg font-semibold transition-colors touch-manipulation">Start over</button>
		</div>
	{:else}
		<div class="w-full max-w-2xl bg-white/10 backdrop-blur rounded-2xl p-4 sm:p-6 shadow-2xl border border-white/10">
			<div class="flex items-center justify-between mb-2">
				<h2 class="font-bold text-lg">{puzzle.title}</h2>
				<span class="text-xs text-emerald-200/60">Hand {puzzleIndex + 1} of {scoringPuzzles.length}</span>
			</div>
			<p class="text-sm text-emerald-100 mb-4">{puzzle.blurb}</p>

			<div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-emerald-200/80 mb-4">
				<span>Seat wind: <strong class="text-white">{windLabel(puzzle.seatWind)}</strong></span>
				<span>Round wind: <strong class="text-white">{windLabel(puzzle.roundWind)}</strong></span>
				<span>Self-drawn: <strong class="text-white">{puzzle.selfDraw ? 'Yes' : 'No'}</strong></span>
				{#if puzzle.wonWithLastWallTile}<span class="text-amber-200">Last tile from the wall</span>{/if}
				{#if puzzle.wonWithFinalDiscard}<span class="text-amber-200">Final discard</span>{/if}
			</div>

			<div class="flex flex-wrap gap-3 mb-3">
				{#each puzzle.melds as meld}
					<div class="flex flex-col items-center gap-1">
						<div class="flex gap-0.5 bg-black/20 rounded p-1.5">
							{#each meld.tiles as t}<TileComponent tile={t} small />{/each}
						</div>
						<span class="text-[10px] uppercase tracking-wide text-emerald-200/60">{meldLabel(meld)}</span>
					</div>
				{/each}
				<div class="flex flex-col items-center gap-1">
					<div class="flex gap-0.5 bg-black/20 rounded p-1.5">
						{#each puzzle.pairTiles as t}<TileComponent tile={t} small />{/each}
					</div>
					<span class="text-[10px] uppercase tracking-wide text-emerald-200/60">Pair</span>
				</div>
			</div>

			{#if puzzle.flowers.length > 0}
				<div class="flex items-center gap-2 mb-4">
					<span class="text-[10px] uppercase tracking-wide text-emerald-200/60">Flowers/Seasons</span>
					<div class="flex gap-0.5">
						{#each puzzle.flowers as t}<TileComponent tile={t} small />{/each}
					</div>
				</div>
			{/if}

			<button onclick={() => (showReference = !showReference)} class="text-xs text-sky-300 hover:text-sky-200 transition-colors touch-manipulation mb-4">
				{showReference ? 'Hide' : 'Show'} scoring reference
			</button>
			{#if showReference}
				<div class="bg-black/20 rounded-lg p-3 mb-4 text-xs text-slate-200 space-y-2">
					<div>
						<p class="font-semibold text-slate-100">Basic score</p>
						<ul class="list-disc list-inside space-y-0.5 text-slate-300">
							<li>Pung, minor (2-8): 2 exposed / 4 concealed</li>
							<li>Pung, major (1s, 9s, winds, dragons): 4 exposed / 8 concealed</li>
							<li>Kong, minor: 8 exposed / 16 concealed</li>
							<li>Kong, major: 16 exposed / 32 concealed</li>
							<li>Chow: 0</li>
							<li>Pair of your own wind, the round wind, or any dragon: 2 each</li>
							<li>Each flower or season held: 4</li>
							<li>Going Mah-Jong: 20 (+2 more if self-drawn)</li>
						</ul>
					</div>
					<div>
						<p class="font-semibold text-slate-100">Doubles (score ×2 each)</p>
						<ul class="list-disc list-inside space-y-0.5 text-slate-300">
							<li>Pung/kong of your own wind, the round wind, or any dragon</li>
							<li>Holding your own flower or season</li>
							<li>A complete set of all 4 flowers, or all 4 seasons: 2 doubles</li>
							<li>No chows in the hand</li>
							<li>All one suit (with winds/dragons allowed)</li>
							<li>All 1s, 9s, winds and dragons</li>
							<li>Fully concealed hand</li>
							<li>Won with the last tile from the wall, or the final discard</li>
						</ul>
					</div>
					<p class="text-slate-400">Final score = basic × 2^doubles, capped at 1000.</p>
				</div>
			{/if}

			{#if stage === 'basic'}
				<div class="border-t border-white/10 pt-4">
					<p class="font-semibold mb-2">Step 1 — What's the basic score?</p>
					<div class="flex gap-2 items-center mb-2">
						<input
							type="number"
							bind:value={basicInput}
							disabled={basicSubmitted}
							onkeydown={(e) => e.key === 'Enter' && submitBasic()}
							class="w-28 px-3 py-2 rounded-lg bg-black/20 border border-white/20 disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-emerald-400"
							placeholder="0"
						/>
						{#if !basicSubmitted}
							<button onclick={submitBasic} class="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg font-semibold transition-colors touch-manipulation">Check</button>
						{/if}
					</div>
					{#if !basicSubmitted}
						{#if basicHintsRevealed < result.detail.length}
							<button onclick={() => (basicHintsRevealed += 1)} class="text-xs px-3 py-1.5 bg-sky-700 hover:bg-sky-600 rounded-lg transition-colors touch-manipulation">💡 Hint ({basicHintsRevealed}/{result.detail.length} revealed)</button>
						{/if}
						{#if basicHintsRevealed > 0}
							<div class="mt-2 flex flex-wrap gap-1">
								{#each result.detail.slice(0, basicHintsRevealed) as d}
									<span class="inline-block bg-sky-950/60 border border-sky-500/30 rounded px-2 py-0.5 text-xs text-sky-100">{d.name}: +{d.value}</span>
								{/each}
							</div>
						{/if}
					{:else}
						<p class={basicCorrect ? 'text-emerald-300 font-semibold' : 'text-red-300 font-semibold'}>
							{basicCorrect ? '✅ Correct!' : `❌ Not quite — the basic score is ${result.basic}.`}
						</p>
						<div class="mt-2 flex flex-wrap gap-1 mb-3">
							{#each result.detail as d}
								<span class="inline-block bg-black/30 rounded px-2 py-0.5 text-xs text-slate-200">{d.name}: +{d.value}</span>
							{/each}
						</div>
						<button onclick={() => (stage = 'doubles')} class="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg font-semibold transition-colors touch-manipulation">Next: doubles →</button>
					{/if}
				</div>
			{:else if stage === 'doubles'}
				<div class="border-t border-white/10 pt-4">
					<p class="text-xs text-emerald-200/70 mb-2">Confirmed basic score: <strong class="text-white">{result.basic}</strong></p>
					<p class="font-semibold mb-2">Step 2 — How many doubles apply?</p>
					<p class="text-xs text-emerald-200/60 mb-2">Count each one separately — a wind pung that matches both your seat <em>and</em> the round wind counts as two.</p>
					<div class="flex gap-2 items-center mb-2">
						<input
							type="number"
							bind:value={doublesInput}
							disabled={doublesSubmitted}
							onkeydown={(e) => e.key === 'Enter' && submitDoubles()}
							class="w-28 px-3 py-2 rounded-lg bg-black/20 border border-white/20 disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-emerald-400"
							placeholder="0"
						/>
						{#if !doublesSubmitted}
							<button onclick={submitDoubles} class="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg font-semibold transition-colors touch-manipulation">Check</button>
						{/if}
					</div>
					{#if !doublesSubmitted}
						{#if doublesHintsRevealed < result.doubleDetail.length}
							<button onclick={() => (doublesHintsRevealed += 1)} class="text-xs px-3 py-1.5 bg-sky-700 hover:bg-sky-600 rounded-lg transition-colors touch-manipulation">💡 Hint ({doublesHintsRevealed}/{result.doubleDetail.length} revealed)</button>
						{:else if result.doubleDetail.length === 0}
							<p class="text-xs text-emerald-200/60">Hint: this hand doesn't have any doubles.</p>
						{/if}
						{#if doublesHintsRevealed > 0}
							<div class="mt-2 flex flex-wrap gap-1">
								{#each result.doubleDetail.slice(0, doublesHintsRevealed) as d}
									<span class="inline-block bg-purple-950/60 border border-purple-500/30 rounded px-2 py-0.5 text-xs text-purple-100">{d.name}{d.count > 1 ? ` (×${d.count})` : ''}</span>
								{/each}
							</div>
						{/if}
					{:else}
						<p class={doublesCorrect ? 'text-emerald-300 font-semibold' : 'text-red-300 font-semibold'}>
							{doublesCorrect ? '✅ Correct!' : `❌ Not quite — there ${result.doubles === 1 ? 'is' : 'are'} ${result.doubles} double${result.doubles === 1 ? '' : 's'}.`}
						</p>
						<div class="mt-2 flex flex-wrap gap-1 mb-3">
							{#if result.doubleDetail.length === 0}
								<span class="text-xs text-slate-400">No doubles apply to this hand.</span>
							{/if}
							{#each result.doubleDetail as d}
								<span class="inline-block bg-black/30 rounded px-2 py-0.5 text-xs text-slate-200">{d.name}{d.count > 1 ? ` (×${d.count})` : ''}</span>
							{/each}
						</div>
						<button onclick={() => (stage = 'final')} class="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg font-semibold transition-colors touch-manipulation">Next: final score →</button>
					{/if}
				</div>
			{:else if stage === 'final'}
				<div class="border-t border-white/10 pt-4">
					<p class="text-xs text-emerald-200/70 mb-2">
						Basic score: <strong class="text-white">{result.basic}</strong> · Doubles: <strong class="text-white">{result.doubles}</strong>
					</p>
					<p class="font-semibold mb-2">Step 3 — What's the final score?</p>
					<p class="text-xs text-emerald-200/60 mb-2">Formula: basic × 2^doubles, capped at 1000.</p>
					<div class="flex gap-2 items-center mb-2">
						<input
							type="number"
							bind:value={finalInput}
							disabled={finalSubmitted}
							onkeydown={(e) => e.key === 'Enter' && submitFinal()}
							class="w-28 px-3 py-2 rounded-lg bg-black/20 border border-white/20 disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-emerald-400"
							placeholder="0"
						/>
						{#if !finalSubmitted}
							<button onclick={submitFinal} class="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg font-semibold transition-colors touch-manipulation">Check</button>
						{/if}
					</div>
					{#if finalSubmitted}
						<p class={finalCorrect ? 'text-emerald-300 font-semibold' : 'text-red-300 font-semibold'}>
							{finalCorrect ? '✅ Correct!' : `❌ Not quite — the final score is ${result.cappedScore}.`}
						</p>
						<p class="text-xs text-slate-300 mt-1 mb-3">
							{result.basic} × 2^{result.doubles} = {result.rawScore}{result.rawScore !== result.cappedScore ? ` → capped at ${result.cappedScore}` : ''}
						</p>
						<button onclick={nextPuzzle} class="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg font-semibold transition-colors touch-manipulation">
							{puzzleIndex < scoringPuzzles.length - 1 ? 'Next hand →' : 'Finish'}
						</button>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>
