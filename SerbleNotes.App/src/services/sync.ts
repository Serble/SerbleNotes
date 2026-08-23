import type { PresenceEntry, SyncEvent } from '../types';
import { deviceId, getToken } from './api';
import { socketUrl } from './platform';

/**
 * How often this client says "are you there".
 *
 * Not a keepalive - the server sends those. This is the client's own liveness check, and it exists
 * because of the one failure a WebSocket cannot report: the path dies without either end sending a
 * close frame. That is the normal way a mobile connection ends - a NAT entry expires, a handover
 * drops the flow - and the socket object stays `OPEN` forever afterwards. `onclose` never fires, so
 * nothing reconnects, and the client sits there believing it is live while receiving nothing. That
 * was "I have to reload the page for it to notice edits from my other device".
 */
const PING_EVERY_MS = 20000;

/**
 * How long without hearing anything at all before the socket is presumed dead.
 *
 * Every ping is answered with a pong, so a healthy connection is never quiet for longer than
 * `PING_EVERY_MS`. Two missed answers is a dead path, not a slow one.
 */
const SILENCE_LIMIT_MS = 45000;

/** First reconnect delay, and the ceiling it backs off to. */
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 15000;

export interface SyncHandlers {
  /** A vault moved on, with the rows that moved it. */
  onChange: (event: SyncEvent) => void;
  /** Which of this account's other devices are where. Empty means this one is alone. */
  onPresence: (present: PresenceEntry[]) => void;
  /** The connection came back after having been lost. Never fires for the first connect. */
  onReopen: () => void;
}

/**
 * The sync socket. It carries notifications and the encrypted rows behind them - the server can no
 * more read what crosses this connection than what it stores.
 */
export class SyncSocket {
  private socket: WebSocket | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  private closed = false;

  /** True once a connection has been lost, so the next open is a reconnection, not the first. */
  private reopening = false;

  private pingTimer: number | null = null;
  private lastHeard = 0;

  /** What this device has open, resent on every reconnect so presence survives a drop. */
  private watching: { vaultId: string | null; noteId: string | null } = {
    vaultId: null,
    noteId: null,
  };

  constructor(private readonly handlers: SyncHandlers) {}

  connect(): void {
    const token = getToken();
    if (!token || this.closed || this.socket) {
      return;
    }

    // A browser can't put an Authorization header on a WebSocket handshake, so the token goes in the
    // query string; the backend accepts it there for this endpoint only. The device id rides along
    // so the server can say which device a presence entry belongs to.
    const socket = new WebSocket(
      socketUrl(
        `/sync?access_token=${encodeURIComponent(token)}&device_id=${encodeURIComponent(deviceId())}`,
      ),
    );
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.lastHeard = Date.now();
      this.startPinging();
      // Presence is per connection on the server, so a reconnect has to say again what it holds.
      this.sendWatch();

      if (this.reopening) {
        this.reopening = false;
        this.handlers.onReopen();
      }
    };

    socket.onmessage = (message) => {
      // Anything at all counts as proof of life, including a frame we go on to ignore.
      this.lastHeard = Date.now();

      let event: SyncEvent;
      try {
        event = JSON.parse(message.data as string) as SyncEvent;
      } catch {
        // A malformed frame is not worth tearing the connection down for.
        return;
      }

      switch (event.kind) {
        case 'pong':
          return;
        case 'presence':
          this.handlers.onPresence(event.present ?? []);
          return;
        default:
          // Our own writes come back to us; acting on them would undo the cursor rules that keep a
          // device from claiming to have seen more than it has.
          if (event.originDeviceId === deviceId()) {
            return;
          }
          this.handlers.onChange(event);
      }
    };

    socket.onclose = () => {
      this.stopPinging();
      this.socket = null;
      if (this.closed) {
        return;
      }
      this.reopening = true;
      window.setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    };

    // An error is always followed by a close, which is where the reconnect lives.
    socket.onerror = () => {};
  }

  /**
   * Says what this device is looking at, so the account's other devices can show it.
   *
   * Remembered rather than only sent, because a socket that drops and comes back has to say it
   * again - the server holds presence against the connection, and that connection is gone.
   */
  watch(vaultId: string | null, noteId: string | null): void {
    if (this.watching.vaultId === vaultId && this.watching.noteId === noteId) {
      return;
    }
    this.watching = { vaultId, noteId };
    this.sendWatch();
  }

  private sendWatch(): void {
    this.send({ kind: 'watch', ...this.watching });
  }

  private send(command: object): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      this.socket.send(JSON.stringify(command));
    } catch {
      // The socket died between the check and the send. The close handler will reconnect.
    }
  }

  private startPinging(): void {
    this.stopPinging();
    this.pingTimer = window.setInterval(() => {
      if (Date.now() - this.lastHeard > SILENCE_LIMIT_MS) {
        // Nothing has come back for two pings. `close()` is what makes `onclose` fire, which is what
        // schedules the reconnect - the socket will never do it for us, because as far as it is
        // concerned it is still open.
        this.stopPinging();
        this.socket?.close();
        return;
      }
      this.send({ kind: 'ping' });
    }, PING_EVERY_MS);
  }

  private stopPinging(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  close(): void {
    this.closed = true;
    this.stopPinging();
    this.socket?.close();
    this.socket = null;
  }
}
