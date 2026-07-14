import { useEffect, useLayoutEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '../store/authStore';

let globalSocket: Socket | null = null;

export function getSocket(): Socket | null {
  return globalSocket;
}

export function useSocket(
  events: Record<string, (data: unknown) => void>
): void {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const eventsRef = useRef(events);
  useLayoutEffect(() => { eventsRef.current = events; });

  useEffect(() => {
    if (!isAuthenticated) {
      // Drop the shared socket on logout so a later login reconnects with a fresh token.
      if (globalSocket) {
        globalSocket.disconnect();
        globalSocket = null;
      }
      return;
    }

    if (!globalSocket) {
      globalSocket = io('/', {
        path: '/socket.io',
        auth: { token: useAuthStore.getState().token },
        transports: ['websocket'],
        reconnection: true,
        reconnectionDelay: 2000,
      });
    }

    const socket = globalSocket;
    const handlers: Array<[string, (d: unknown) => void]> = [];

    for (const [event, handler] of Object.entries(eventsRef.current)) {
      const wrapped = (data: unknown) => handler(data);
      socket.on(event, wrapped);
      handlers.push([event, wrapped]);
    }

    return () => {
      for (const [event, handler] of handlers) {
        socket.off(event, handler);
      }
    };
  }, [isAuthenticated]);
}
