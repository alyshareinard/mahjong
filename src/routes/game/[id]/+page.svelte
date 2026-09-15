<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { getSocket } from '$lib/socket';
	import { sortTiles, tileName, windLabel, type Tile as TileT, type WindRank } from '$lib/tiles';
	import { analyzeHand, assignHandGroups, computeUkeire, suggestDiscards, evaluateClaimOptions, shantenLabel } from '$lib/shanten';
	import TileComponent from '$lib/components/Tile.svelte';
	import { onMount, onDestroy } from 'svelte';
	import type { Socket } from 'socket.io-client';

	type AssistMode = 'regular' | 'hint' | 'learning';

	type Meld = { type: 'chow' | 'pung' | 'kong'; tiles: TileT[]; concealed: boolean; claimedFrom: string | null; promoted?: boolean };

	type PlayerPublic = {
		id: string;
		name: string;
		seatWind: WindRank | null;
		handCount: number;
		melds: Meld[];
		flowers: TileT[];
		assistMode: AssistMode;
		isDealer: boolean;
		isCurrent: boolean;
		disconnected: boolean;
		totalScore: number;
	};

	type ClaimOptions = { canHu: boolean; canPong: boolean; canKong: boolean; chiOptions: [string, string][] };

	type PendingClaim = {
		discardTile: TileT;
		discarderName: string;
		myOptions: ClaimOptions | null;
		responded: boolean | null;
		waitingOn: string[];
	};

	type ScoreDetail = { name: string; value: number };
	type DoubleDetail = { name: string; count: number };

	type PlayerScore = {
		playerId: string;
		name: string;
		score: number;
		basic: number;
		doubles: number;
		rawScore: number;
		detail: ScoreDetail[];
		doubleDetail: DoubleDetail[];
		payment: number;
	};

	type RevealedHand = { id: string; name: string; hand: TileT[]; melds: Meld[]; flowers: TileT[] };

	type HandResult = {
		draw: boolean;
		winnerId: string | null;
		winnerName: string | null;
		selfDraw: boolean;
		discarderId: string | null;
		discarderName: string | null;
		winningTile: TileT | null;
		handNumber: number;
		scores: PlayerScore[];
		revealedHands: RevealedHand[];
	};

	type ChatMessage = { playerId: string; name: string; text: string; timestamp: number };

	type GameState = {
		id: string;
		status: 'waiting' | 'playing' | 'roundOver';
		myPlayerId: string;
		myHand: TileT[];
		myMelds: Meld[];
		myFlowers: TileT[];
		mySeatWind: WindRank | null;
		myAssistMode: AssistMode;
		myLastDrawnTileId: string | null;
		isMyTurn: boolean;
		turnPhase: 'awaitingDraw' | 'awaitingDiscard' | 'awaitingClaims';
		canDeclareSelfDrawWin: boolean;
		availableConcealedKongs: { suit: string; rank: number | string }[];
		availablePromotedKongs: { meldIndex: number; suit: string; rank: number | string }[];
		pendingClaim: PendingClaim | null;
		players: PlayerPublic[];
		dealerPlayerId: string | null;
		roundWind: WindRank;
		handNumber: number;
		wallCount: number;
		discards: { tile: TileT; playerId: string }[];
		result: HandResult | null;
		log: string[];
		chat: ChatMessage[];
	};

	let roomId = $derived(page.params.id);
	let playerName = $derived(page.url.searchParams.get('name') || 'Player');
	let playerId = $derived(page.url.searchParams.get('pid') || '');

	let gameState: GameState | null = $state(null);
	let connected = $state(false);
	let client: Socket | null = $state(null);
	let nameTaken = $state(false);
	let nameInput = $state('');
	let confirmRemovePlayerId: string | null = $state(null);
	let showRules = $state(false);
	let chatOpen = $state(false);
	let chatInput = $state('');
	let chatUnreadCount = $state(0);
	let chatLastSeenTimestamp = $state(0);
	let showDiscardHint = $state(false);
	let showClaimHint = $state(false);

	let myMeldsNeeded = $derived.by(() => {
		const g = gameState;
		return g ? 4 - g.myMelds.length : 4;
	});
	let myAnalysis = $derived.by(() => {
		const g = gameState;
		return g ? analyzeHand(g.myHand, myMeldsNeeded) : { shanten: 0, groups: [] };
	});
	let myShanten = $derived(myAnalysis.shanten);
	let myGroupMap = $derived.by(() => {
		const g = gameState;
		return g ? assignHandGroups(g.myHand, myAnalysis.groups) : new Map<string, 'set' | 'pair' | 'taatsu'>();
	});
	let myUkeire = $derived.by(() => {
		const g = gameState;
		return g ? computeUkeire(g.myHand, myMeldsNeeded) : [];
	});
	let myDiscardSuggestions = $derived.by(() => {
		const g = gameState;
		if (!(g && g.isMyTurn && g.turnPhase === 'awaitingDiscard')) return [];
		return suggestDiscards(g.myHand, myMeldsNeeded);
	});
	let myClaimHint = $derived.by(() => {
		const g = gameState;
		const opts = g?.pendingClaim?.myOptions;
		if (!g || !opts) return null;
		return evaluateClaimOptions(g.myHand, g.myMelds.length, g.pendingClaim!.discardTile, opts);
	});

	$effect(() => {
		const g = gameState;
		if (!(g?.isMyTurn && g.turnPhase === 'awaitingDiscard')) showDiscardHint = false;
	});
	$effect(() => {
		if (!gameState?.pendingClaim?.myOptions) showClaimHint = false;
	});

	onMount(async () => {
		const socket = await getSocket();
		client = socket;
		if (!socket) return;
		if (socket.connected) {
			connected = true;
			socket.emit('join', { roomId, playerName, playerId });
		}
		socket.on('connect', () => {
			connected = true;
			socket.emit('join', { roomId, playerName, playerId });
		});
		socket.on('disconnect', () => {
			connected = false;
		});
		socket.on('state', (s: GameState) => {
			const newMessages = s.chat.filter((m) => m.timestamp > chatLastSeenTimestamp && m.playerId !== s.myPlayerId);
			if (!chatOpen && newMessages.length > 0) chatUnreadCount = newMessages.length;
			gameState = s;
		});
		socket.on('nameTaken', () => {
			nameTaken = true;
			nameInput = playerName;
		});
		socket.on('error', (msg: string) => {
			alert(msg);
		});
	});

	onDestroy(() => {
		if (!client) return;
		client.off('connect');
		client.off('disconnect');
		client.off('state');
		client.off('nameTaken');
		client.off('error');
	});

	function start() {
		client?.emit('start');
	}

	function removePlayerAction(targetPlayerId: string) {
		client?.emit('removePlayer', { targetPlayerId });
	}

	function draw() {
		client?.emit('draw');
	}

	function discard(tileId: string) {
		client?.emit('discard', { tileId });
	}

	function respondClaim(type: 'pass' | 'hu' | 'pong' | 'kong') {
		client?.emit('respondClaim', { type });
	}

	function respondChi(tileIds: [string, string]) {
		client?.emit('respondClaim', { type: 'chi', tileIds });
	}

	function declareConcealedKong(suit: string, rank: number | string) {
		client?.emit('declareConcealedKong', { suit, rank });
	}

	function declarePromotedKong(meldIndex: number) {
		client?.emit('declarePromotedKong', { meldIndex });
	}

	function winSelfDraw() {
		client?.emit('winSelfDraw');
	}

	function nextHand() {
		client?.emit('nextHand');
	}

	function sendChat() {
		const text = chatInput.trim();
		if (!text || text.length > 200) return;
		client?.emit('chatMessage', { text });
		chatInput = '';
	}

	function toggleChat() {
		chatOpen = !chatOpen;
		if (chatOpen) {
			chatUnreadCount = 0;
			chatLastSeenTimestamp = Date.now();
		}
	}

	function leaveRoom() {
		client?.emit('leave');
		goto('/');
	}

	function rejoinWithName() {
		if (!nameInput.trim()) return;
		nameTaken = false;
		client?.emit('join', { roomId, playerName: nameInput.trim() });
	}

	function handleHandTileClick(tileId: string) {
		const g = gameState;
		if (!g) return;
		if (g.isMyTurn && g.turnPhase === 'awaitingDiscard') discard(tileId);
	}

	function sortedHand() {
		return gameState ? sortTiles(gameState.myHand) : [];
	}

	function otherPlayers() {
		if (!gameState) return [];
		return gameState.players.filter((p) => p.id !== gameState!.myPlayerId);
	}

	function playerNameById(id: string | null | undefined) {
		return gameState?.players.find((p) => p.id === id)?.name ?? 'Unknown';
	}

	function statusText() {
		const g = gameState;
		if (!g) return 'Connecting...';
		if (g.status === 'roundOver') return g.result?.draw ? 'Hand over — wall exhausted' : 'Hand over!';
		if (g.pendingClaim) {
			if (g.pendingClaim.myOptions) return `${g.pendingClaim.discarderName} discarded — respond!`;
			if (g.pendingClaim.responded) return `Waiting on ${g.pendingClaim.waitingOn.join(', ') || 'others'}...`;
			return `Waiting for a response to ${g.pendingClaim.discarderName}'s discard...`;
		}
		if (g.isMyTurn) {
			if (g.turnPhase === 'awaitingDraw') return 'Your turn — draw a tile';
			if (g.turnPhase === 'awaitingDiscard') return 'Your turn — choose a tile to discard';
		}
		const current = g.players.find((p) => p.isCurrent);
		return current ? `Waiting for ${current.name}` : 'Waiting...';
	}

	function scoreFor(result: HandResult, playerId: string): PlayerScore | undefined {
		return result.scores.find((s) => s.playerId === playerId);
	}

	function setAssistMode(mode: AssistMode) {
		client?.emit('setAssistMode', { mode });
	}

	function modeLabel(mode: AssistMode): string {
		if (mode === 'learning') return '🎓 Learning';
		if (mode === 'hint') return '💡 Hint';
		return '';
	}

	function visibleCount(suit: string, rank: number | string): number {
		const g = gameState;
		if (!g) return 0;
		const matches = (t: TileT) => t.suit === suit && t.rank === rank;
		let count = g.myHand.filter(matches).length;
		for (const m of g.myMelds) count += m.tiles.filter(matches).length;
		for (const p of g.players) for (const m of p.melds) count += m.tiles.filter(matches).length;
		count += g.discards.filter((d) => matches(d.tile)).length;
		return count;
	}

	function remainingCount(suit: string, rank: number | string): number {
		return Math.max(0, 4 - visibleCount(suit, rank));
	}

	function drawnTileSuggestion() {
		const g = gameState;
		if (!g || !g.myLastDrawnTileId) return null;
		const drawnTile = g.myHand.find((t) => t.id === g.myLastDrawnTileId);
		if (!drawnTile) return null;
		return myDiscardSuggestions.find((s) => s.tile.suit === drawnTile.suit && s.tile.rank === drawnTile.rank) ?? null;
	}
</script>

<div class="min-h-screen flex flex-col bg-emerald-950 text-white">
	<header class="flex items-center justify-between p-3 sm:p-4 bg-black/30 flex-wrap gap-2">
		<h1 class="font-bold text-base sm:text-lg">Table: {roomId}</h1>
		<div class="flex items-center gap-2 sm:gap-3">
			<span class="text-emerald-100 text-sm hidden sm:inline">{playerName}</span>
			<span class="text-xs uppercase tracking-wider {connected ? 'text-emerald-400' : 'text-red-400'}">
				{connected ? 'Online' : 'Offline'}
			</span>
			<button
				onclick={() => (showRules = true)}
				class="p-2 bg-black/30 hover:bg-black/40 rounded-full transition-colors touch-manipulation text-xs font-bold"
				aria-label="Scoring guide"
			>
				?
			</button>
			<button
				onclick={toggleChat}
				class="relative p-2 bg-black/30 hover:bg-black/40 rounded-full transition-colors touch-manipulation"
				aria-label="Chat"
			>
				<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-emerald-100" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
				</svg>
				{#if chatUnreadCount > 0}
					<span class="absolute -top-1 -right-1 bg-red-500 text-white text-xs font-bold rounded-full min-w-[1.25rem] h-5 flex items-center justify-center px-1">
						{chatUnreadCount > 9 ? '9+' : chatUnreadCount}
					</span>
				{/if}
			</button>
			<button onclick={leaveRoom} class="px-3 py-1 text-xs bg-red-800/60 hover:bg-red-700 rounded transition-colors touch-manipulation">Leave</button>
		</div>
	</header>

	<main class="flex-1 flex flex-col items-center p-2 sm:p-4 gap-4 overflow-auto">
		{#if nameTaken}
			<div class="bg-black/30 rounded-2xl p-8 max-w-sm w-full text-center flex flex-col gap-4">
				<p class="text-red-300 font-semibold">That name is already taken in this room.</p>
				<input
					bind:value={nameInput}
					onkeydown={(e) => e.key === 'Enter' && rejoinWithName()}
					class="w-full px-3 py-2 rounded-lg bg-black/20 border border-white/20 placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-emerald-400"
					placeholder="Your name"
				/>
				<button onclick={rejoinWithName} class="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 rounded-lg font-semibold transition-colors touch-manipulation">
					Join as {nameInput || '…'}
				</button>
			</div>
		{:else if !gameState}
			<p class="text-emerald-100">Connecting...</p>
		{:else if gameState.status === 'waiting'}
			<div class="text-center w-full max-w-sm">
				<p class="mb-4 text-emerald-100">Waiting for players ({gameState.players.length}/4)...</p>
				<div class="bg-black/20 rounded-lg p-4 mb-6">
					<ul class="space-y-1">
						{#each gameState.players as player}
							<li class="text-emerald-100 font-medium flex items-center justify-center gap-2">
								{player.name}{player.id === gameState.myPlayerId ? ' (you)' : ''}
								{#if gameState.players.length < 4}
									<button
										onclick={() => (confirmRemovePlayerId = player.id)}
										class="w-5 h-5 flex items-center justify-center bg-red-600/70 hover:bg-red-500 rounded-full text-xs leading-none touch-manipulation"
										aria-label="Remove {player.name}"
									>×</button>
								{/if}
							</li>
						{/each}
					</ul>
				</div>
				{#if gameState.players.length === 4}
					<button onclick={start} class="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 rounded-lg font-semibold shadow transition-colors touch-manipulation">
						Start game
					</button>
				{:else}
					<p class="text-emerald-200/70 text-sm">Need {4 - gameState.players.length} more player{4 - gameState.players.length === 1 ? '' : 's'} — share the room code.</p>
				{/if}
			</div>
		{:else}
			<p class="text-emerald-100 font-medium text-center">{statusText()}</p>

			<div class="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-emerald-200/80">
				<span>Hand {gameState.handNumber}</span>
				<span>{windLabel(gameState.roundWind)} round</span>
				<span>Dealer: {playerNameById(gameState.dealerPlayerId)}</span>
				<span>Wall: {gameState.wallCount} tiles</span>
			</div>

			<!-- opponents -->
			<div class="grid grid-cols-1 sm:grid-cols-3 gap-2 w-full max-w-3xl">
				{#each otherPlayers() as player}
					<div class="bg-black/20 rounded-xl p-3 {player.isCurrent ? 'ring-2 ring-emerald-400' : ''}">
						<div class="flex items-center justify-between mb-1 flex-wrap gap-1">
							<h3 class="font-bold text-sm">{player.name}</h3>
							<div class="flex items-center gap-1 flex-wrap">
								{#if player.seatWind}<span class="text-xs bg-slate-600/50 px-1.5 py-0.5 rounded">{player.seatWind}</span>{/if}
								{#if player.isDealer}<span class="text-xs bg-yellow-500/30 text-yellow-200 px-1.5 py-0.5 rounded">Dealer</span>{/if}
								{#if player.disconnected}<span class="text-xs bg-red-500/30 text-red-300 px-1.5 py-0.5 rounded">Away</span>{/if}
								{#if modeLabel(player.assistMode)}<span class="text-xs bg-sky-500/20 text-sky-200 px-1.5 py-0.5 rounded">{modeLabel(player.assistMode)}</span>{/if}
							</div>
						</div>
						<p class="text-xs text-emerald-200 mb-2">{player.totalScore} pts · {player.handCount} tiles</p>
						{#if player.melds.length > 0}
							<div class="flex flex-wrap gap-2 mb-2">
								{#each player.melds as meld}
									<div class="flex gap-0.5 bg-black/20 rounded p-1">
										{#each meld.tiles as tile}<TileComponent {tile} small />{/each}
									</div>
								{/each}
							</div>
						{/if}
						{#if player.flowers.length > 0}
							<div class="flex flex-wrap gap-0.5">
								{#each player.flowers as tile}<TileComponent {tile} small />{/each}
							</div>
						{/if}
					</div>
				{/each}
			</div>

			<!-- discard pile -->
			<div class="flex flex-col items-center w-full max-w-3xl">
				<h3 class="text-xs uppercase tracking-wider text-emerald-200/70 mb-2">Discards</h3>
				{#if gameState.discards.length === 0}
					<p class="text-emerald-200/50 text-sm">No discards yet</p>
				{:else}
					<div class="flex flex-wrap gap-1 justify-center max-h-40 overflow-y-auto bg-black/10 rounded-lg p-2">
						{#each gameState.discards as d, i}
							<TileComponent tile={d.tile} small highlight={i === gameState.discards.length - 1} />
						{/each}
					</div>
				{/if}
			</div>

			<!-- claim response bar -->
			{#if gameState.pendingClaim?.myOptions}
				{@const opts = gameState.pendingClaim.myOptions}
				<div class="flex flex-col items-center gap-3 bg-amber-900/40 border border-amber-400/40 rounded-xl p-4 max-w-md w-full">
					<p class="text-amber-200 font-semibold text-sm">
						{gameState.pendingClaim.discarderName} discarded {tileName(gameState.pendingClaim.discardTile)}
					</p>
					<TileComponent tile={gameState.pendingClaim.discardTile} />
					<div class="flex flex-wrap gap-2 justify-center">
						{#if opts.canHu}
							<button onclick={() => respondClaim('hu')} class="px-4 py-2 bg-red-600 hover:bg-red-500 rounded-lg font-bold animate-pulse transition-colors touch-manipulation">Win!</button>
						{/if}
						{#if opts.canKong}
							<button onclick={() => respondClaim('kong')} class="px-4 py-2 bg-purple-600 hover:bg-purple-500 rounded-lg font-semibold transition-colors touch-manipulation">Kong</button>
						{/if}
						{#if opts.canPong}
							<button onclick={() => respondClaim('pong')} class="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg font-semibold transition-colors touch-manipulation">Pong</button>
						{/if}
						<button onclick={() => respondClaim('pass')} class="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg font-semibold transition-colors touch-manipulation">Pass</button>
					</div>
					{#if opts.chiOptions.length > 0}
						<div class="flex flex-col gap-1 items-center">
							<p class="text-xs text-amber-200">Chi options:</p>
							{#each opts.chiOptions as pair}
								<button onclick={() => respondChi(pair)} class="flex items-center gap-1 px-2 py-1 bg-teal-700 hover:bg-teal-600 rounded-lg transition-colors touch-manipulation">
									{#each pair as tid}
										{@const t = gameState.myHand.find((h) => h.id === tid)}
										{#if t}<TileComponent tile={t} small />{/if}
									{/each}
									<span class="text-xs ml-1">Chi</span>
								</button>
							{/each}
						</div>
					{/if}

					{#if gameState.myAssistMode === 'hint'}
						{#if !showClaimHint}
							<button onclick={() => (showClaimHint = true)} class="text-xs px-3 py-1.5 bg-sky-700 hover:bg-sky-600 rounded-lg transition-colors touch-manipulation">💡 Hint</button>
						{:else if myClaimHint}
							<div class="w-full bg-sky-950/60 border border-sky-500/30 rounded-lg p-3 text-xs text-sky-100 space-y-1">
								<p>Pass: stay at <strong>{shantenLabel(myClaimHint.currentShanten)}</strong></p>
								{#each myClaimHint.evaluations as ev}
									<p class={ev.resultingShanten < myClaimHint.currentShanten ? 'text-emerald-300 font-semibold' : ''}>
										{ev.type === 'chi' ? 'Chi' : ev.type === 'pong' ? 'Pong' : 'Kong'}: → <strong>{shantenLabel(ev.resultingShanten)}</strong>
										{#if ev.resultingShanten < myClaimHint.currentShanten}(improves your hand){:else if ev.resultingShanten > myClaimHint.currentShanten}(sets you back){:else}(no change){/if}
									</p>
								{/each}
							</div>
						{/if}
					{/if}
				</div>
			{/if}

			<!-- my area -->
			<div class="w-full max-w-3xl mt-auto flex flex-col items-center gap-2 bg-black/20 rounded-xl p-3">
				<div class="flex items-center justify-between w-full flex-wrap gap-1">
					<h3 class="font-bold text-sm">
						You{gameState.mySeatWind ? ` (${gameState.mySeatWind})` : ''}
					</h3>
					<div class="flex items-center gap-2">
						<span class="text-xs text-emerald-200">{gameState.players.find((p) => p.id === gameState!.myPlayerId)?.totalScore ?? 0} pts</span>
						<div class="flex rounded-lg overflow-hidden border border-white/10 text-xs">
							{#each [['regular', 'Regular'], ['hint', 'Hint'], ['learning', 'Learning']] as [mode, label]}
								<button
									onclick={() => setAssistMode(mode as AssistMode)}
									class="px-2 py-1 transition-colors touch-manipulation {gameState.myAssistMode === mode ? 'bg-sky-600 text-white' : 'bg-black/20 text-emerald-200 hover:bg-black/30'}"
								>{label}</button>
							{/each}
						</div>
					</div>
				</div>

				{#if gameState.myAssistMode === 'learning'}
					<div class="w-full bg-sky-950/50 border border-sky-500/30 rounded-lg p-3 text-xs text-sky-100">
						<p class="font-semibold">🎓 {shantenLabel(myShanten)}</p>
						{#if myShanten > -1 && myUkeire.length > 0}
							<p class="mt-1 text-sky-200/80">Tiles that would help, and how many are still unseen:</p>
							<div class="flex flex-wrap gap-1 mt-1">
								{#each myUkeire as u}
									<span class="inline-block bg-black/30 rounded px-1.5 py-0.5">
										{tileName({ suit: u.tile.suit, rank: u.tile.rank } as TileT)} ({remainingCount(u.tile.suit, u.tile.rank)} left)
									</span>
								{/each}
							</div>
						{:else if myShanten <= -1}
							<p class="mt-1 text-emerald-300">Your hand is already complete!</p>
						{/if}
						<p class="mt-2 text-sky-300/60">Named-hand odds will show here once those are added.</p>
					</div>
				{/if}

				{#if gameState.myMelds.length > 0 || gameState.myFlowers.length > 0}
					<div class="flex flex-wrap gap-2 w-full">
						{#each gameState.myMelds as meld, meldIndex}
							<div class="flex gap-0.5 bg-black/20 rounded p-1 items-center">
								{#each meld.tiles as tile}<TileComponent {tile} small />{/each}
								{#if gameState.availablePromotedKongs.some((k) => k.meldIndex === meldIndex)}
									<button onclick={() => declarePromotedKong(meldIndex)} class="ml-1 px-2 py-1 text-xs bg-purple-600 hover:bg-purple-500 rounded transition-colors touch-manipulation">+Kong</button>
								{/if}
							</div>
						{/each}
						{#if gameState.myFlowers.length > 0}
							<div class="flex gap-0.5">
								{#each gameState.myFlowers as tile}<TileComponent {tile} small />{/each}
							</div>
						{/if}
					</div>
				{/if}

				<div class="flex flex-wrap gap-1 justify-center">
					{#each sortedHand() as tile}
						<TileComponent
							{tile}
							highlight={tile.id === gameState.myLastDrawnTileId}
							groupType={gameState.myAssistMode === 'learning' ? (myGroupMap.get(tile.id) ?? null) : null}
							onclick={() => handleHandTileClick(tile.id)}
						/>
					{/each}
				</div>
				{#if gameState.myAssistMode === 'learning' && myAnalysis.groups.length > 0}
					<p class="text-xs text-sky-200/70 flex flex-wrap gap-x-3 gap-y-0.5 justify-center">
						<span><span class="inline-block w-2.5 h-2.5 rounded-full bg-emerald-500 mr-1 align-middle"></span>complete set</span>
						<span><span class="inline-block w-2.5 h-2.5 rounded-full bg-purple-500 mr-1 align-middle"></span>your pair</span>
						<span><span class="inline-block w-2.5 h-2.5 rounded-full border-2 border-dashed border-sky-400 mr-1 align-middle"></span>partial (taatsu)</span>
					</p>
				{/if}

				<div class="flex flex-wrap gap-2 justify-center mt-2">
					{#if gameState.isMyTurn && gameState.turnPhase === 'awaitingDraw'}
						<button onclick={draw} class="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 rounded-lg font-semibold shadow transition-colors touch-manipulation">Draw tile</button>
					{/if}
					{#if gameState.canDeclareSelfDrawWin}
						<button onclick={winSelfDraw} class="px-5 py-2.5 bg-red-600 hover:bg-red-500 rounded-lg font-bold shadow animate-pulse transition-colors touch-manipulation">Win! (self-draw)</button>
					{/if}
					{#each gameState.availableConcealedKongs as k}
						<button onclick={() => declareConcealedKong(k.suit, k.rank)} class="px-3 py-2 bg-purple-600 hover:bg-purple-500 rounded-lg text-sm font-semibold transition-colors touch-manipulation">
							Kong {tileName({ suit: k.suit, rank: k.rank } as TileT)}
						</button>
					{/each}
				</div>
				{#if gameState.isMyTurn && gameState.turnPhase === 'awaitingDiscard'}
					<p class="text-xs text-emerald-200/70">Tap a tile above to discard it</p>
					{#if gameState.myAssistMode === 'hint'}
						{#if !showDiscardHint}
							<button onclick={() => (showDiscardHint = true)} class="text-xs px-3 py-1.5 bg-sky-700 hover:bg-sky-600 rounded-lg transition-colors touch-manipulation">💡 Hint</button>
						{:else if myDiscardSuggestions.length > 0}
							{@const best = myDiscardSuggestions[0]}
							{@const drawn = drawnTileSuggestion()}
							<div class="w-full max-w-md bg-sky-950/60 border border-sky-500/30 rounded-lg p-3 text-xs text-sky-100 space-y-1">
								<p>
									Best discard: <strong>{tileName(best.tile)}</strong> → {shantenLabel(best.resultingShanten)}
									({best.ukeireCount} tile type{best.ukeireCount === 1 ? '' : 's'} would help after)
								</p>
								{#if drawn && drawn.tile.suit === best.tile.suit && drawn.tile.rank === best.tile.rank}
									<p class="text-emerald-300">That's the tile you just drew — go ahead and discard it.</p>
								{:else if drawn}
									<p class="text-amber-200">
										Keep what you drew — discarding it instead would leave you at {shantenLabel(drawn.resultingShanten)}.
									</p>
								{/if}
							</div>
						{/if}
					{/if}
				{/if}
			</div>

			{#if gameState.log.length > 0}
				<div class="w-full max-w-md bg-black/20 rounded-lg p-3 text-sm text-emerald-50">
					{#each gameState.log.slice(-5) as entry}
						<div>{entry}</div>
					{/each}
				</div>
			{/if}
		{/if}
	</main>
</div>

{#if gameState?.status === 'roundOver' && gameState.result}
	{@const result = gameState.result}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
		<div class="flex flex-col items-center gap-4 bg-slate-800 rounded-2xl p-6 sm:p-8 shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
			{#if result.draw}
				<p class="text-2xl font-bold text-center">Wall exhausted — no winner</p>
				<p class="text-sm text-emerald-200 text-center">Everyone settles on what they were holding.</p>
			{:else}
				<p class="text-2xl font-bold text-amber-300 text-center">
					{result.winnerName} wins {result.selfDraw ? 'by self-draw' : `off ${result.discarderName}'s discard`}!
				</p>
				<p class="text-lg text-emerald-200">{scoreFor(result, result.winnerId ?? '')?.score} points</p>
			{/if}

			<div class="w-full space-y-2">
				{#each result.scores as s}
					<div class="bg-black/20 rounded-lg p-3 text-sm">
						<div class="flex items-center justify-between font-semibold">
							<span>
								{s.name}{s.playerId === gameState.myPlayerId ? ' (you)' : ''}
								{#if s.playerId === result.winnerId}<span class="text-amber-300"> · winner</span>{/if}
							</span>
							<span class:text-emerald-300={s.payment > 0} class:text-red-300={s.payment < 0}>
								{s.payment > 0 ? '+' : ''}{s.payment}
							</span>
						</div>
						<p class="text-xs text-slate-300 mt-1">
							Score: {s.basic} basic{s.doubles > 0 ? ` × 2^${s.doubles}` : ''} = {s.rawScore}{s.rawScore !== s.score ? ` (capped at ${s.score})` : ''}
						</p>
						<div class="text-xs text-slate-400 mt-1">
							{#each s.detail as d}
								<span class="inline-block bg-black/30 rounded px-1.5 py-0.5 m-0.5">{d.name} +{d.value}</span>
							{/each}
							{#each s.doubleDetail as d}
								<span class="inline-block bg-purple-900/40 rounded px-1.5 py-0.5 m-0.5">{d.name} ×2{d.count > 1 ? ` (${d.count})` : ''}</span>
							{/each}
						</div>
						<p class="text-xs text-emerald-200 mt-1">Running total: {gameState.players.find((p) => p.id === s.playerId)?.totalScore ?? 0}</p>
					</div>
				{/each}
			</div>

			<div class="w-full">
				<p class="text-emerald-200 text-xs text-center mb-2 uppercase tracking-wider">Revealed hands</p>
				<div class="flex flex-col gap-2">
					{#each result.revealedHands as rh}
						<div class="bg-black/20 rounded-lg p-2">
							<p class="text-xs font-semibold mb-1">{rh.name}{rh.id === gameState.myPlayerId ? ' (you)' : ''}</p>
							<div class="flex flex-wrap gap-0.5">
								{#each sortTiles(rh.hand) as tile}<TileComponent {tile} small />{/each}
								{#each rh.melds as meld}
									{#each meld.tiles as tile}<TileComponent {tile} small />{/each}
								{/each}
								{#each rh.flowers as tile}<TileComponent {tile} small />{/each}
							</div>
						</div>
					{/each}
				</div>
			</div>

			<button onclick={nextHand} class="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 rounded-lg font-semibold shadow transition-colors touch-manipulation">
				Next hand
			</button>
		</div>
	</div>
{/if}

{#if showRules}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onclick={() => (showRules = false)}>
		<div class="bg-slate-800 rounded-2xl p-6 shadow-2xl max-w-md w-full max-h-[85vh] overflow-y-auto text-sm" onclick={(e) => e.stopPropagation()}>
			<h2 class="font-bold text-lg mb-3">Scoring guide</h2>
			<p class="text-slate-300 mb-2">From <em>The Mah Jong Player's Companion</em>. Every hand — winner or not — is scored, then everyone settles up.</p>

			<p class="font-semibold text-slate-100 mt-3 mb-1">Basic score (per meld/pair)</p>
			<ul class="space-y-0.5 text-slate-200 text-xs">
				<li>Pung, minor (2-8): 2 exposed / 4 concealed</li>
				<li>Pung, major (1s, 9s, winds, dragons): 4 exposed / 8 concealed</li>
				<li>Kong, minor: 8 exposed / 16 concealed</li>
				<li>Kong, major: 16 exposed / 32 concealed</li>
				<li>Chow: 0</li>
				<li>Pair of your own wind, the round wind, or any dragon: 2 each</li>
				<li>Each flower or season held: 4</li>
				<li>Going Mah-Jong: 20 (+2 more if self-drawn)</li>
			</ul>

			<p class="font-semibold text-slate-100 mt-3 mb-1">Doubles (basic score × 2 per double)</p>
			<ul class="space-y-0.5 text-slate-200 text-xs">
				<li>Pung/kong of your own wind, the round wind, or any dragon</li>
				<li>Holding your own flower or season</li>
				<li>A complete set of all 4 flowers, or all 4 seasons: 2 doubles</li>
				<li>Winner only: no chows in the hand</li>
				<li>Winner only: all one suit (with winds/dragons allowed)</li>
				<li>Winner only: all 1s, 9s, winds and dragons</li>
				<li>Winner only: fully concealed hand</li>
				<li>Winner only: won with the last tile from the wall, or the final discard</li>
			</ul>
			<p class="mt-2 text-slate-300 text-xs">Score is capped at a limit of 1000 points.</p>

			<p class="font-semibold text-slate-100 mt-3 mb-1">Settling up</p>
			<p class="text-slate-300 text-xs">The winner collects their full score from each of the other three players. If nobody wins (wall exhausted), all four players instead settle the <em>difference</em> between their own scores with each other. Any payment to or from East Wind is doubled.</p>

			<p class="mt-3 text-amber-200/80 text-xs">Not yet implemented: "fishing" (calling-hand) bonuses, robbing the kong, and the book's ~150 named special hands — those score via this same basic system for now.</p>
			<button onclick={() => (showRules = false)} class="mt-4 w-full py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg font-semibold transition-colors touch-manipulation">Got it</button>
		</div>
	</div>
{/if}

{#if confirmRemovePlayerId}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onclick={() => (confirmRemovePlayerId = null)}>
		<div class="flex flex-col items-center gap-4 bg-slate-800 rounded-2xl p-8 shadow-2xl max-w-sm w-full mx-4" onclick={(e) => e.stopPropagation()}>
			<p class="font-semibold text-lg text-center">Remove {playerNameById(confirmRemovePlayerId)}?</p>
			<div class="flex gap-3 w-full">
				<button onclick={() => (confirmRemovePlayerId = null)} class="flex-1 py-2 bg-slate-600 hover:bg-slate-500 rounded-lg font-semibold transition-colors touch-manipulation">Cancel</button>
				<button
					onclick={() => {
						if (confirmRemovePlayerId) removePlayerAction(confirmRemovePlayerId);
						confirmRemovePlayerId = null;
					}}
					class="flex-1 py-2 bg-red-600 hover:bg-red-500 rounded-lg font-semibold transition-colors touch-manipulation"
				>Remove</button>
			</div>
		</div>
	</div>
{/if}

{#if chatOpen}
	<div class="fixed inset-0 z-40 flex flex-col justify-end bg-black/50" onclick={() => (chatOpen = false)}>
		<div class="flex flex-col h-[70vh] max-h-[500px] bg-slate-800 rounded-t-2xl shadow-2xl mx-2 sm:mx-auto sm:w-full sm:max-w-md" onclick={(e) => e.stopPropagation()}>
			<div class="flex items-center justify-between p-3 border-b border-white/10">
				<h3 class="font-semibold text-emerald-100">Chat</h3>
				<button onclick={() => (chatOpen = false)} class="p-1 text-emerald-200 hover:text-white transition-colors touch-manipulation" aria-label="Close chat">
					<svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			</div>
			<div class="flex-1 overflow-y-auto p-3 space-y-2">
				{#if gameState && gameState.chat.length > 0}
					{#each gameState.chat as message}
						<div class="flex flex-col {message.playerId === gameState.myPlayerId ? 'items-end' : 'items-start'}">
							<span class="text-xs text-emerald-300 px-1">{message.name}</span>
							<span class="text-sm bg-black/20 text-white px-3 py-1.5 rounded-lg max-w-[80%]">{message.text}</span>
						</div>
					{/each}
				{:else}
					<p class="text-sm text-emerald-200/60 text-center mt-4">No messages yet</p>
				{/if}
			</div>
			<div class="p-3 border-t border-white/10">
				<form
					class="flex gap-2"
					onsubmit={(e) => {
						e.preventDefault();
						sendChat();
					}}
				>
					<input
						bind:value={chatInput}
						placeholder="Type a message..."
						maxlength="200"
						class="flex-1 px-3 py-2 rounded-lg bg-black/20 border border-white/20 text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-emerald-400"
					/>
					<button
						type="submit"
						disabled={!chatInput.trim()}
						class="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-600/40 disabled:text-white/40 rounded-lg font-semibold transition-colors touch-manipulation"
					>Send</button>
				</form>
			</div>
		</div>
	</div>
{/if}
