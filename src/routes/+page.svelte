<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import SpecialHandsModal from '$lib/components/SpecialHandsModal.svelte';
	import { FULL_LIST_HANDS } from '$lib/specialHandsData';

	let playerName = $state('');
	let roomCode = $state('');
	let playerId = $state('');
	let showSpecialHands = $state(false);

	const NAME_KEY = 'mahjong-player-name';
	const ID_KEY = 'mahjong-player-id';

	function generateId() {
		return Math.random().toString(36).slice(2) + Date.now().toString(36);
	}

	function savePlayer() {
		// sessionStorage (not localStorage): each browser tab/window gets its own
		// identity, so opening several windows lets one person sit in multiple
		// seats for testing, while a refresh within a window still reconnects
		// correctly since sessionStorage survives that.
		sessionStorage.setItem(NAME_KEY, playerName || 'Player 1');
		sessionStorage.setItem(ID_KEY, playerId);
	}

	onMount(() => {
		playerName = sessionStorage.getItem(NAME_KEY) || '';
		playerId = sessionStorage.getItem(ID_KEY) || generateId();
	});

	function generateCode(length = 6) {
		const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
		let code = '';
		for (let i = 0; i < length; i++) code += chars[Math.floor(Math.random() * chars.length)];
		return code;
	}

	function createGame() {
		const code = generateCode();
		savePlayer();
		goto(`/game/${code}?name=${encodeURIComponent(playerName || 'Player 1')}&pid=${playerId}`);
	}

	function joinGame() {
		if (!roomCode.trim()) return;
		savePlayer();
		goto(`/game/${roomCode.trim().toUpperCase()}?name=${encodeURIComponent(playerName || 'Player 1')}&pid=${playerId}`);
	}
</script>

<div class="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-emerald-950 to-slate-900 text-white p-6">
	<h1 class="text-4xl md:text-5xl font-extrabold mb-2 text-center">
		<span class="text-red-500">麻</span><span class="text-emerald-400">將</span>
		Mahjong
	</h1>
	<p class="text-emerald-100 mb-8 text-center max-w-md">
		Chinese Mahjong for four, playable in any browser — Apple and Android friends welcome.
	</p>

	<div class="bg-white/10 backdrop-blur rounded-2xl p-8 max-w-sm w-full shadow-2xl border border-white/10">
		<label for="name" class="block mb-2 text-sm font-medium">Your name</label>
		<input
			id="name"
			bind:value={playerName}
			class="w-full mb-6 px-3 py-2 rounded-lg bg-black/20 border border-white/20 placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-emerald-400"
			placeholder="Player 1"
		/>

		<button
			onclick={createGame}
			class="w-full mb-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 rounded-lg font-semibold transition-colors touch-manipulation"
		>
			Create a table
		</button>

		<div class="h-px bg-white/20 my-4"></div>

		<label for="room" class="block mb-2 text-sm font-medium">Room code</label>
		<input
			id="room"
			bind:value={roomCode}
			class="w-full mb-3 px-3 py-2 rounded-lg bg-black/20 border border-white/20 placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-emerald-400 uppercase"
			placeholder="ABCDEF"
		/>
		<button
			onclick={joinGame}
			class="w-full py-2.5 bg-slate-700 hover:bg-slate-600 rounded-lg font-semibold transition-colors touch-manipulation"
		>
			Join table
		</button>
	</div>

	<p class="text-emerald-200/60 text-xs mt-8 text-center max-w-sm">
		Mahjong is played with 4 players. Share your room code with three friends, or add practice seats in the table if you have fewer.
	</p>

	<a
		href="/learn-scoring"
		class="mt-6 inline-flex items-center gap-2 px-4 py-2 bg-sky-500/10 hover:bg-sky-500/20 border border-sky-400/30 rounded-lg text-sm text-sky-200 hover:text-sky-100 transition-colors touch-manipulation"
	>
		📚 Learn scoring
	</a>

	<button
		onclick={() => (showSpecialHands = true)}
		class="mt-3 inline-flex items-center gap-2 px-4 py-2 bg-purple-500/10 hover:bg-purple-500/20 border border-purple-400/30 rounded-lg text-sm text-purple-200 hover:text-purple-100 transition-colors touch-manipulation"
	>
		🀄 Special hands
	</button>

	<a
		href="https://buymeacoffee.com/tech.aly"
		target="_blank"
		rel="noopener noreferrer"
		class="mt-3 inline-flex items-center gap-2 px-4 py-2 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-400/30 rounded-lg text-sm text-amber-200 hover:text-amber-100 transition-colors touch-manipulation"
	>
		☕ Buy me a coffee
	</a>
</div>

{#if showSpecialHands}
	<SpecialHandsModal
		hands={FULL_LIST_HANDS}
		subtitle="All named hands from the book, both the Short List and the Full List additions. A table can play with just the Short List, or none at all — see 'Hand rules' when you create a table."
		onclose={() => (showSpecialHands = false)}
	/>
{/if}
