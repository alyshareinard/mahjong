import { browser } from '$app/environment';
import type { Socket } from 'socket.io-client';

let socket: Socket | null = null;

export async function getSocket() {
	if (!browser) return null;
	if (socket) return socket;
	const { io } = await import('socket.io-client');
	socket = io();
	return socket;
}
