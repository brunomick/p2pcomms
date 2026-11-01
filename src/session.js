import { APP_ID, normalizeCode, deriveRoomSecrets } from './code.js';

export const WAIT_TIMEOUT_MS = 600000;
export const CONNECT_TIMEOUT_MS = 60000;

const isTurn = url => /^turns?:/i.test(url);

export function stripTurn(rtcConfig) {
  const iceServers = [];
  for (const server of rtcConfig?.iceServers ?? []) {
    const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(
      u => typeof u === 'string' && !isTurn(u)
    );
    if (urls.length === 0) continue;
    iceServers.push({ ...server, urls: Array.isArray(server.urls) ? urls : urls[0] });
  }
  return { ...rtcConfig, iceServers };
}

export function makeTrackedPeerConnection(Base, onState) {
  return class TrackedPeerConnection extends Base {
    constructor(config, ...rest) {
      super(stripTurn(config), ...rest);
      this.addEventListener('connectionstatechange', () => onState(this, this.connectionState));
    }
  };
}

export function createSession({
  trystero: { joinRoom, getRelaySockets, pauseRelayReconnection, resumeRelayReconnection },
  RTCPeerConnection,
  timers = globalThis,
  deriveIterations,
  onEvent = () => {},
}) {
  // One object per start() call; every callback checks it is still the current, unfinished attempt.
  let attempt = null;

  const clearTimers = a => {
    timers.clearTimeout(a.waitTimer);
    timers.clearTimeout(a.connectTimer);
    a.waitTimer = a.connectTimer = undefined;
  };

  // Trystero 0.26 shares the physical peer connections per appId and keeps them open for ~2 min
  // after room.leave(), so close them ourselves once the room is left.
  const leaveRoom = a => {
    if (!a.room) return Promise.resolve();
    // By the time onPeerLeave fires, Trystero has already removed the peer from getPeers().
    const pcs = new Set(Object.values(a.room.getPeers()));
    if (a.pc) pcs.add(a.pc);
    return a.room
      .leave()
      .catch(() => {})
      .then(() => {
        for (const pc of pcs) {
          try {
            pc.close();
          } catch {
            // already closed
          }
        }
      });
  };

  const finish = (a, type, detail) => {
    if (a.finished) return;
    a.finished = true;
    clearTimers(a);
    leaveRoom(a);
    onEvent(type, detail);
  };

  const onPcState = (a, state) => {
    if (a.finished || a.peerId !== undefined) return;
    if (state === 'failed') {
      finish(a, 'failed', { reason: 'ice-failed' });
    } else if (state === 'connecting' && !a.connecting) {
      a.connecting = true;
      // From here the connect timer decides the outcome, so the wait timer must not expire mid-attempt.
      timers.clearTimeout(a.waitTimer);
      a.waitTimer = undefined;
      onEvent('connecting');
      a.connectTimer = timers.setTimeout(() => finish(a, 'failed', { reason: 'timeout' }), CONNECT_TIMEOUT_MS);
    }
  };

  const onPeerJoin = (a, id) => {
    if (a.finished) return;
    if (a.peerId !== undefined) {
      a.room.getPeers()[id]?.close();
      return;
    }
    a.peerId = id;
    a.pc = a.room.getPeers()[id];
    clearTimers(a);
    // Pause first so closing the sockets cannot trigger a reconnect.
    // Verified by tests/e2e (relays-closed): with just this, every relay WebSocket is closed and no
    // frame is sent after connecting, so neither `passive: true` nor a patch to Trystero is needed.
    pauseRelayReconnection();
    for (const socket of Object.values(getRelaySockets())) socket.close();
    onEvent('connected', { peerId: id });
  };

  const onPeerLeave = (a, id) => {
    if (a.finished || id !== a.peerId) return;
    a.finished = true;
    leaveRoom(a);
    onEvent('peer-left');
  };

  async function start(codeInput) {
    if (attempt && !attempt.finished) return;
    const code = normalizeCode(codeInput);
    if (code === null) {
      onEvent('invalid-code');
      return;
    }
    const a = (attempt = { finished: false, connecting: false });
    const { roomId, password } = await deriveRoomSecrets(code, deriveIterations);
    if (attempt !== a || a.finished) return;

    // A previous connected call paused reconnection; undo it so the new join gets live relay clients.
    resumeRelayReconnection();
    const tracked = makeTrackedPeerConnection(RTCPeerConnection, (_pc, state) => onPcState(a, state));
    // manualReconnection: without it Trystero reopens every relay (and resumes announcing) whenever
    // the browser fires 'online', even after we closed them on connect. Its only effect is to skip
    // that listener; our explicit pause/resume calls are unaffected.
    const relayConfig = { manualReconnection: true };
    const room = joinRoom({ appId: APP_ID, password, rtcPolyfill: tracked, relayConfig }, roomId, {
      // Trystero reports join errors per peer; once our peer is connected they are not ours to act on.
      onJoinError: () => {
        if (a.peerId === undefined) finish(a, 'failed', { reason: 'join-error' });
      }
    });
    a.room = room;
    if (a.finished) {
      // onJoinError fired synchronously, before the room existed.
      leaveRoom(a);
      return;
    }
    room.onPeerJoin = id => onPeerJoin(a, id);
    room.onPeerLeave = id => onPeerLeave(a, id);
    onEvent('waiting');
    a.waitTimer = timers.setTimeout(() => finish(a, 'expired'), WAIT_TIMEOUT_MS);
  }

  async function leave() {
    const a = attempt;
    attempt = null;
    if (!a) return;
    a.finished = true;
    clearTimers(a);
    await leaveRoom(a);
  }

  return {
    start,
    leave,
    get room() {
      return attempt?.room;
    },
    get peerId() {
      return attempt?.peerId;
    },
    getPeerConnection() {
      const a = attempt;
      return a?.peerId === undefined ? undefined : a.room.getPeers()[a.peerId];
    }
  };
}
