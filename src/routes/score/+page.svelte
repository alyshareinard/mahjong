<script lang="ts">
	import { onMount } from 'svelte';
	import TileComponent from '$lib/components/Tile.svelte';
	import TilePalette from '$lib/components/TilePalette.svelte';
	import { sortTiles, windLabel, type Tile as TileT, type WindRank } from '$lib/tiles';
	import type { Meld } from '$lib/scoring';
	import {
		scoreHand,
		makeTile,
		seatWindFor,
		usageKey,
		expectedWinnerHandSize,
		type PlayerEntry,
		type HandMode
	} from '$lib/scorekeeper';

	type EditorMode = 'hand' | 'meld' | 'flowers';
	type MeldKind = 'chow' | 'pung' | 'kong' | 'pair';
	// Marks a discard win whose winning tile completed a set that was already entered as a declared set.
	const IN_DECLARED_SET = 'in-declared-set';
	type HistoryEntry = {
		hand: number;
		dealerName: string;
		winnerName: string | null;
		named: string | null;
		scores: number[];
		payments: number[];
		prevDealerIndex: number;
	};

	const STORAGE_KEY = 'mahjong-scorekeeper-v1';
	const WINDS: WindRank[] = ['E', 'S', 'W', 'N'];
	const HAND_MODES: { id: HandMode; label: string; blurb: string }[] = [
		{ id: 'beginner', label: 'Beginner', blurb: 'Standard scoring only, no named hands.' },
		{ id: 'shortList', label: 'Short List', blurb: "The book's beginner-friendly named hands." },
		{ id: 'fullList', label: 'Full List', blurb: "The book's complete synopsis of special hands." }
	];

	const emptyEntry = (name: string): PlayerEntry => ({ name, hand: [], melds: [], flowers: [] });

	let players: PlayerEntry[] = $state([1, 2, 3, 4].map((n) => emptyEntry(`Player ${n}`)));
	let totals: number[] = $state([0, 0, 0, 0]);
	let dealerIndex = $state(0);
	let roundWind: WindRank = $state('E');
	let handMode: HandMode = $state('shortList');
	let winnerIndex: number | null = $state(null);
	let selfDraw = $state(true);
	let winningTileId: string | null = $state(null);
	let wonWithLastWallTile = $state(false);
	let wonWithFinalDiscard = $state(false);
	let originalCall = $state(false);
	let history: HistoryEntry[] = $state([]);
	let loaded = $state(false);

	let editing: number | null = $state(null);
	let editorMode: EditorMode = $state('hand');
	let meldKind: MeldKind = $state('pung');
	let meldConcealed = $state(false);

	onMount(() => {
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			if (raw) {
				const s = JSON.parse(raw);
				players = s.players;
				totals = s.totals;
				dealerIndex = s.dealerIndex;
				roundWind = s.roundWind;
				handMode = s.handMode;
				winnerIndex = s.winnerIndex;
				selfDraw = s.selfDraw;
				winningTileId = s.winningTileId;
				wonWithLastWallTile = s.wonWithLastWallTile;
				wonWithFinalDiscard = s.wonWithFinalDiscard;
				originalCall = s.originalCall;
				history = s.history;
			}
		} catch {
			// Corrupt or unavailable storage: start fresh.
		}
		loaded = true;
	});

	$effect(() => {
		const snapshot = JSON.stringify({
			players,
			totals,
			dealerIndex,
			roundWind,
			handMode,
			winnerIndex,
			selfDraw,
			winningTileId,
			wonWithLastWallTile,
			wonWithFinalDiscard,
			originalCall,
			history
		});
		if (!loaded) return;
		try {
			localStorage.setItem(STORAGE_KEY, snapshot);
		} catch {
			// Storage full or blocked: the scorekeeper still works for this session.
		}
	});

	let outcome = $derived(
		scoreHand(players, {
			roundWind,
			dealerIndex,
			handMode,
			winnerIndex,
			selfDraw,
			winningTileId,
			wonWithLastWallTile,
			wonWithFinalDiscard,
			originalCall
		})
	);

	let usage = $derived.by(() => {
		const m: Record<string, number> = {};
		const add = (t: TileT) => {
			const k = usageKey(t);
			m[k] = (m[k] || 0) + 1;
		};
		for (const p of players) {
			p.hand.forEach(add);
			p.melds.forEach((me) => me.tiles.forEach(add));
			p.flowers.forEach(add);
		}
		return m;
	});

	function remaining(t: { suit: string; rank: number | string; kind?: string }): number {
		const cap = t.suit === 'flower' ? 1 : 4;
		return cap - (usage[usageKey(t as TileT)] || 0);
	}

	const isSuit = (s: string) => s === 'characters' || s === 'bamboo' || s === 'dots';

	function isDisabled(t: TileT): boolean {
		if (editing === null) return true;
		const p = players[editing];
		if (editorMode === 'flowers') {
			if (t.suit !== 'flower') return true;
			return remaining(t) <= 0 && !p.flowers.some((f) => usageKey(f) === usageKey(t));
		}
		if (t.suit === 'flower') return true;
		if (editorMode === 'hand') return p.hand.length >= expectedWinnerHandSize(p) || remaining(t) < 1;
		if (meldKind === 'pair') return p.hand.length + 2 > expectedWinnerHandSize(p) || remaining(t) < 2;
		if (p.melds.length >= 4) return true;
		if (meldKind === 'pung') return remaining(t) < 3;
		if (meldKind === 'kong') return remaining(t) < 4;
		if (!isSuit(t.suit) || (t.rank as number) > 7) return true;
		return [0, 1, 2].some((i) => remaining({ suit: t.suit, rank: (t.rank as number) + i }) < 1);
	}

	function onPick(t: TileT) {
		if (editing === null) return;
		const p = players[editing];
		if (editorMode === 'hand') {
			p.hand = sortTiles([...p.hand, makeTile(t.suit, t.rank)]);
		} else if (editorMode === 'flowers') {
			const existing = p.flowers.find((f) => usageKey(f) === usageKey(t));
			p.flowers = existing ? p.flowers.filter((f) => f !== existing) : [...p.flowers, makeTile('flower', t.rank, t.kind)];
		} else if (meldKind === 'pair') {
			// A pair has no scoring of its own to declare; it simply joins the hand tiles.
			p.hand = sortTiles([...p.hand, makeTile(t.suit, t.rank), makeTile(t.suit, t.rank)]);
		} else {
			const tiles =
				meldKind === 'chow'
					? [0, 1, 2].map((i) => makeTile(t.suit, (t.rank as number) + i))
					: Array.from({ length: meldKind === 'kong' ? 4 : 3 }, () => makeTile(t.suit, t.rank));
			const meld: Meld = { type: meldKind, concealed: meldConcealed, tiles };
			p.melds.push(meld);
		}
	}

	function removeHandTile(playerIdx: number, tile: TileT) {
		players[playerIdx].hand = players[playerIdx].hand.filter((t) => t.id !== tile.id);
		if (winningTileId === tile.id) winningTileId = null;
	}

	function removeMeld(playerIdx: number, meldIdx: number) {
		players[playerIdx].melds.splice(meldIdx, 1);
	}

	function clearPlayer(i: number) {
		players[i] = emptyEntry(players[i].name);
		if (winnerIndex === i) winningTileId = null;
	}

	function toggleEditor(i: number) {
		editing = editing === i ? null : i;
	}

	function setWinner(i: number | null) {
		winnerIndex = i;
		winningTileId = null;
	}

	function displayName(i: number): string {
		return players[i].name.trim() || `Player ${i + 1}`;
	}

	function signed(n: number): string {
		return n > 0 ? `+${n}` : String(n);
	}

	function clearHandEntries() {
		players = players.map((p) => emptyEntry(p.name));
		winnerIndex = null;
		winningTileId = null;
		selfDraw = true;
		wonWithLastWallTile = false;
		wonWithFinalDiscard = false;
		originalCall = false;
		editing = null;
	}

	function recordHand() {
		if (outcome.blocking) return;
		const winner = winnerIndex;
		history = [
			{
				hand: history.length + 1,
				dealerName: displayName(dealerIndex),
				winnerName: winner === null ? null : displayName(winner),
				named: winner === null ? null : (outcome.players[winner].result.specialHand ?? null),
				scores: outcome.players.map((p) => p.score),
				payments: [...outcome.payments],
				prevDealerIndex: dealerIndex
			},
			...history
		];
		totals = totals.map((t, i) => t + outcome.payments[i]);
		// Same rule as the live game: the deal passes on only when someone other than the dealer wins.
		if (winner !== null && winner !== dealerIndex) dealerIndex = (dealerIndex + 1) % 4;
		clearHandEntries();
	}

	function undoLastHand() {
		const last = history[0];
		if (!last) return;
		totals = totals.map((t, i) => t - last.payments[i]);
		dealerIndex = last.prevDealerIndex;
		history = history.slice(1);
	}

	function newGame() {
		if (!confirm('Start a new game? This clears all running totals and the hand history.')) return;
		totals = [0, 0, 0, 0];
		history = [];
		dealerIndex = 0;
		roundWind = 'E';
		clearHandEntries();
	}

	function meldLabel(m: Meld): string {
		return `${m.concealed ? 'concealed ' : ''}${m.type}`;
	}
</script>

<div class="min-h-screen bg-emerald-950 text-white">
	<header class="flex items-center justify-between gap-2 p-3 sm:p-4 bg-black/30 flex-wrap">
		<div class="flex items-center gap-3">
			<a href="/" class="text-emerald-200 hover:text-white text-sm">← Home</a>
			<h1 class="font-bold text-base sm:text-lg">🧮 Table scorekeeper</h1>
		</div>
		<button onclick={newGame} class="text-xs px-3 py-1.5 bg-black/30 hover:bg-black/40 rounded-lg text-emerald-100 touch-manipulation">New game</button>
	</header>

	<main class="max-w-2xl mx-auto p-3 sm:p-4 space-y-4">
		<p class="text-emerald-100/70 text-xs">
			For physical tiles on a real table: enter each player's tiles and this works out every hand's score and who pays whom. Everything is saved on this device.
		</p>

		<section class="bg-black/25 rounded-xl p-3 space-y-3">
			<div class="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
				<label class="flex items-center gap-2">
					<span class="text-emerald-100/80">Round wind</span>
					<select bind:value={roundWind} class="bg-black/30 rounded px-2 py-1 border border-white/10">
						{#each WINDS as w}
							<option value={w}>{windLabel(w)}</option>
						{/each}
					</select>
				</label>
				<label class="flex items-center gap-2">
					<span class="text-emerald-100/80">Dealer (East)</span>
					<select bind:value={dealerIndex} class="bg-black/30 rounded px-2 py-1 border border-white/10">
						{#each players as _p, i}
							<option value={i}>{displayName(i)}</option>
						{/each}
					</select>
				</label>
			</div>
			<div>
				<div class="inline-flex rounded-lg overflow-hidden border border-white/15 text-sm">
					{#each HAND_MODES as m}
						<button
							onclick={() => (handMode = m.id)}
							class="px-3 py-1.5 transition-colors touch-manipulation {handMode === m.id ? 'bg-sky-600 text-white' : 'bg-black/20 text-emerald-200 hover:bg-black/30'}"
						>{m.label}</button>
					{/each}
				</div>
				<p class="text-xs text-emerald-200/60 mt-1.5">{HAND_MODES.find((m) => m.id === handMode)?.blurb}</p>
			</div>
		</section>

{#snippet summary(i: number, player: PlayerEntry)}
				<div class="flex flex-wrap gap-2 items-end text-xs">
					{#each player.melds as meld, mi}
						<div class="flex flex-col items-start gap-0.5 bg-black/30 rounded p-1">
							<div class="flex gap-0.5">
								{#each meld.tiles as t}
									<TileComponent tile={t} small />
								{/each}
							</div>
							<button onclick={() => removeMeld(i, mi)} class="text-[11px] text-red-300 hover:text-red-200 px-1 touch-manipulation">
								{meldLabel(meld)} ✕
							</button>
						</div>
					{/each}
					{#if player.hand.length > 0}
						<div class="flex flex-wrap gap-0.5">
							{#each player.hand as t (t.id)}
								<TileComponent tile={t} small onclick={() => removeHandTile(i, t)} />
							{/each}
						</div>
					{/if}
				</div>
				{#if player.flowers.length > 0}
					<p class="text-xs text-fuchsia-200">
						Flowers/seasons:
						{#each player.flowers as f}
							<span class="inline-block mr-1"><TileComponent tile={f} small /></span>
						{/each}
					</p>
				{/if}
				{#if player.hand.length === 0 && player.melds.length === 0 && player.flowers.length === 0}
					<p class="text-xs text-emerald-200/50">No tiles entered yet.</p>
				{:else}
					<p class="text-[11px] text-emerald-200/50">Tap a tile to remove it. {player.hand.length} tiles in hand{player.melds.length ? `, ${player.melds.length} set${player.melds.length === 1 ? '' : 's'} declared` : ''}.</p>
				{/if}

	{#if player.hand.length || player.melds.length || player.flowers.length}
		<button onclick={() => clearPlayer(i)} class="text-[11px] text-red-300 hover:text-red-200 touch-manipulation">Clear all tiles</button>
	{/if}
{/snippet}

		{#each players as player, i}
			<section class="bg-black/25 rounded-xl p-3 space-y-2.5 {winnerIndex === i ? 'ring-2 ring-amber-400' : ''}">
				<div class="flex items-center gap-2">
					<span class="shrink-0 w-14 text-center text-xs font-bold rounded px-1.5 py-1 {outcome.seatWinds[i] === 'E' ? 'bg-red-700' : 'bg-black/40'}">
						{windLabel(outcome.seatWinds[i])}
					</span>
					<input
						bind:value={player.name}
						class="flex-1 min-w-0 px-2 py-1 rounded bg-black/20 border border-white/15 focus:outline-none focus:ring-2 focus:ring-emerald-400"
						aria-label="Player {i + 1} name"
					/>
					<span class="shrink-0 text-sm font-semibold tabular-nums {totals[i] < 0 ? 'text-red-300' : 'text-emerald-300'}">{signed(totals[i])}</span>
				</div>

{#if editing !== i}
{@render summary(i, player)}
{/if}
				<button
					onclick={() => toggleEditor(i)}
					class="w-full py-1.5 rounded-lg text-sm font-semibold transition-colors touch-manipulation {editing === i ? 'bg-sky-700 hover:bg-sky-600' : 'bg-black/30 hover:bg-black/40'}"
				>{editing === i ? 'Done entering tiles' : 'Enter tiles'}</button>

				{#if editing === i}
					<div class="space-y-2.5 border-t border-white/10 pt-2.5">
						<div class="inline-flex rounded-lg overflow-hidden border border-white/15 text-xs">
							{#each [['hand', 'Hand tiles'], ['meld', 'Declared set'], ['flowers', 'Flowers']] as [id, label]}
								<button
									onclick={() => (editorMode = id as EditorMode)}
									class="px-3 py-1.5 touch-manipulation {editorMode === id ? 'bg-sky-600' : 'bg-black/20 hover:bg-black/30'}"
								>{label}</button>
							{/each}
						</div>
						{#if editorMode === 'hand'}
							<p class="text-xs text-emerald-200/70">
								Tap tiles to add the ones held in the hand (not already declared sets). A winner has {expectedWinnerHandSize(player)} including the winning tile.
							</p>
						{:else if editorMode === 'meld'}
							<div class="flex flex-wrap items-center gap-3 text-xs">
								<div class="inline-flex rounded-lg overflow-hidden border border-white/15">
									{#each ['chow', 'pung', 'kong', 'pair'] as k}
										<button
											onclick={() => (meldKind = k as MeldKind)}
											class="px-3 py-1.5 capitalize touch-manipulation {meldKind === k ? 'bg-sky-600' : 'bg-black/20 hover:bg-black/30'}"
										>{k}</button>
									{/each}
								</div>
								{#if meldKind !== 'pair'}
									<label class="flex items-center gap-1.5"><input type="checkbox" bind:checked={meldConcealed} /> concealed (not taken from a discard)</label>
								{/if}
							</div>
							<p class="text-xs text-emerald-200/70">
								{#if meldKind === 'pair'}
									Tap a tile to add a pair. It goes in with the hand tiles.
								{:else}
									{meldKind === 'chow' ? 'Tap the lowest tile of the run.' : `Tap the tile to add a ${meldKind}.`} Tick "concealed" for a set you built yourself rather than claimed from a discard; leave it unticked for an exposed set. Sets can also just be entered as hand tiles.
								{/if}
							</p>
						{:else}
							<p class="text-xs text-emerald-200/70">Tap a flower or season to add it; tap it again to remove it.</p>
						{/if}
						<TilePalette {isDisabled} onpick={onPick} />
					</div>
					<div class="space-y-2.5 border-t border-white/10 pt-2.5">
{@render summary(i, player)}
					</div>
				{/if}

				<div class="flex items-center justify-between gap-2 text-sm pt-1">
					<label class="flex items-center gap-2 touch-manipulation">
						<input type="radio" name="winner" checked={winnerIndex === i} onchange={() => setWinner(i)} />
						Went Mah-Jong
					</label>
					<span class="font-semibold">
						{outcome.players[i].score} pts
						{#if outcome.players[i].result.specialHand}
							<span class="text-amber-200 text-xs font-normal">· {outcome.players[i].result.specialHand}</span>
						{/if}
					</span>
				</div>
			</section>
		{/each}

		<section class="bg-black/25 rounded-xl p-3 space-y-2.5 text-sm">
			<label class="flex items-center gap-2 touch-manipulation">
				<input type="radio" name="winner" checked={winnerIndex === null} onchange={() => setWinner(null)} />
				Nobody won (wall ran out)
			</label>

			{#if winnerIndex !== null}
				<div class="border-t border-white/10 pt-2.5 space-y-2.5">
					<p class="font-semibold">{displayName(winnerIndex)} went Mah-Jong</p>
					<div class="flex flex-wrap gap-x-5 gap-y-1.5">
						<label class="flex items-center gap-2"><input type="radio" name="how" checked={selfDraw} onchange={() => { selfDraw = true; winningTileId = null; }} /> Drew it from the wall</label>
						<label class="flex items-center gap-2"><input type="radio" name="how" checked={!selfDraw} onchange={() => (selfDraw = false)} /> Won off a discard</label>
					</div>
					{#if !selfDraw}
						<div>
							<p class="text-xs text-emerald-200/70 mb-1">Tap the winning tile in their hand (a set completed by someone else's discard counts as exposed):</p>
							<div class="flex flex-wrap gap-0.5">
								{#each players[winnerIndex].hand as t (t.id)}
									<TileComponent tile={t} small highlight={winningTileId === t.id} onclick={() => (winningTileId = t.id)} />
								{/each}
							</div>
							{#if players[winnerIndex].melds.length > 0}
								<button
									onclick={() => (winningTileId = IN_DECLARED_SET)}
									class="mt-1.5 text-xs px-3 py-1.5 rounded-lg touch-manipulation {winningTileId === IN_DECLARED_SET ? 'bg-sky-600' : 'bg-black/30 hover:bg-black/40'}"
								>It completed a set I entered as a declared set (mark that set exposed)</button>
							{/if}
						</div>
					{/if}
					<div class="flex flex-wrap gap-x-5 gap-y-1.5 text-xs">
						{#if selfDraw}
							<label class="flex items-center gap-2"><input type="checkbox" bind:checked={wonWithLastWallTile} /> Won with the last tile in the wall</label>
						{:else}
							<label class="flex items-center gap-2"><input type="checkbox" bind:checked={wonWithFinalDiscard} /> Won with the final discard</label>
						{/if}
						<label class="flex items-center gap-2"><input type="checkbox" bind:checked={originalCall} /> Unbroken Original Call</label>
					</div>
				</div>
			{/if}
		</section>

		<section class="bg-black/25 rounded-xl p-3 space-y-3">
			<h2 class="font-bold">This hand</h2>
			<div class="space-y-2">
				{#each players as _p, i}
					{@const r = outcome.players[i].result}
					<details class="bg-black/20 rounded-lg px-3 py-2">
						<summary class="flex items-center justify-between gap-2 cursor-pointer text-sm">
							<span>
								{displayName(i)}
								<span class="text-emerald-200/60 text-xs">({windLabel(outcome.seatWinds[i])}{winnerIndex === i ? ', winner' : ''})</span>
							</span>
							<span class="tabular-nums">
								<span class="font-semibold">{outcome.players[i].score}</span>
								<span class="text-xs {outcome.payments[i] < 0 ? 'text-red-300' : 'text-emerald-300'}"> → {signed(outcome.payments[i])}</span>
							</span>
						</summary>
						<div class="mt-2 text-xs space-y-1 text-emerald-100/80">
							{#if r.specialHand}
								<p class="text-amber-200">Named hand: {r.specialHand}. Fixed score, replaces the ordinary calculation.</p>
							{/if}
							{#each r.detail as d}
								<p>{d.name}: +{d.value}</p>
							{/each}
							{#each r.doubleDetail as d}
								<p>{d.name}: ×{2 ** d.count}</p>
							{/each}
							<p class="text-emerald-200/60">
								{r.basic} basic × 2<sup>{r.doubles}</sup> = {r.rawScore}{r.rawScore > r.cappedScore && !r.specialHand ? `, capped at ${r.cappedScore}` : ''}
							</p>
							{#if outcome.players[i].issue}
								<p class="text-red-300">{outcome.players[i].issue}</p>
							{/if}
						</div>
					</details>
				{/each}
			</div>
			<p class="text-xs text-emerald-200/60">
				{#if winnerIndex !== null}
					The winner collects their full score from each opponent; the other players settle the difference between their own scores. Any payment to or from East is doubled.
				{:else}
					With no winner, every pair of players settles the difference between their scores. Any payment to or from East is doubled.
				{/if}
			</p>
			{#if outcome.blocking}
				<p class="text-sm text-amber-200">{outcome.blocking}</p>
			{/if}
			<button
				onclick={recordHand}
				disabled={outcome.blocking !== null}
				class="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:hover:bg-emerald-600 rounded-lg font-semibold transition-colors touch-manipulation"
			>Record hand &amp; start next</button>
		</section>

		{#if history.length > 0}
			<section class="bg-black/25 rounded-xl p-3 space-y-2">
				<div class="flex items-center justify-between">
					<h2 class="font-bold">Hand history</h2>
					<button onclick={undoLastHand} class="text-xs px-3 py-1.5 bg-black/30 hover:bg-black/40 rounded-lg touch-manipulation">Undo last hand</button>
				</div>
				<div class="space-y-1.5 text-xs">
					{#each history as h}
						<div class="bg-black/20 rounded-lg px-3 py-2">
							<p class="font-semibold">
								Hand {h.hand}: {h.winnerName ? `${h.winnerName} won${h.named ? ` (${h.named})` : ''}` : 'no winner'}
								<span class="text-emerald-200/50 font-normal">· {h.dealerName} dealt</span>
							</p>
							<p class="text-emerald-100/70 tabular-nums">
								{#each players as _p, i}
									<span class="mr-3">{displayName(i)} <span class={h.payments[i] < 0 ? 'text-red-300' : 'text-emerald-300'}>{signed(h.payments[i])}</span></span>
								{/each}
							</p>
						</div>
					{/each}
				</div>
			</section>
		{/if}
	</main>
</div>
