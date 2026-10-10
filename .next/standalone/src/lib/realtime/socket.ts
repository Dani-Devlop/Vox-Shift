// ─────────────────────────────────────────────────────────────────────────────
// Realtime socket client — singleton connection to the translation mini
// service through the gateway. NEVER hardcode a port in the URL path:
// the gateway routes via the XTransformPort query parameter.
// ─────────────────────────────────────────────────────────────────────────────

import { io, type Socket } from 'socket.io-client'

let socketInstance: Socket | null = null

export function getTranslatorSocket(): Socket {
  if (!socketInstance) {
    socketInstance = io('/?XTransformPort=3003', {
      transports: ['websocket', 'polling'],
      forceNew: false,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 800,
      reconnectionDelayMax: 4000,
      timeout: 10000,
    })
  }
  return socketInstance
}

export function disconnectTranslatorSocket() {
  socketInstance?.disconnect()
  socketInstance = null
}
