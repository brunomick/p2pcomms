import test, { mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  WAIT_TIMEOUT_MS,
  CONNECT_TIMEOUT_MS,
  stripTurn,
  makeTrackedPeerConnection,
  createSession
} from '../../src/session.js';
import { APP_ID, deriveRoomSecrets } from '../../src/code.js';
import { WORDS } from '../../src/wordlist.js';

const CODE = [WORDS[0], WORDS[1], WORDS[2], WORDS[3]].join('-');
const ITER = 1000;

class FakeBase extends EventTarget {
  static instances = [];
  constructor(config) {
    super();
    this.config = config;
    this.connectionState = 'new';
    this.closed = false;
    FakeBase.instances.push(this);
  }
  dispatch(state) {
    this.connectionState = state;
    this.dispatchEvent(new Event('connectionstatechange'));
  }
  close() {
    this.closed = true;
  }
}

function setup(opts = {}) {
  FakeBase.instances = [];
  const events = [];
  const joins = [];
  const room = {
    leaves: 0,
    peers: {},
    getPeers() {
      return this.peers;
    },
    async leave() {
      this.leaves++;
      // Peers must still be open when Trystero leaves (they are closed after leave resolves).
      this.closedAtLeave = Object.values(this.peers).some(pc => pc.closed);
    }
  };

  const closedSockets = [];
  const calls = { pause: 0, resume: 0, order: [] };
  const makeSocket = url => ({ url, close: () => closedSockets.push(url) });
  const sockets = { 'wss://a': makeSocket('wss://a'), 'wss://b': makeSocket('wss://b') };
  const trystero = {
    joinRoom(config, roomId, callbacks) {
      calls.order.push('join');
      joins.push({ config, roomId, callbacks });
      return room;
    },
    getRelaySockets: () => sockets,
    pauseRelayReconnection: () => {
      calls.pause++;
    },
    resumeRelayReconnection: () => {
      calls.resume++;
      calls.order.push('resume');
    }
  };
  const session = createSession({
    trystero,
    RTCPeerConnection: FakeBase,
    deriveIterations: ITER,
    onEvent: (type, detail) => events.push({ type, detail }),
    ...opts
  });
  const types = () => events.map(e => e.type);
  const tracked = () => joins[0].config.rtcPolyfill;
  return { session, room, joins, events, types, closedSockets, calls, tracked };
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
};

async function started(opts) {
  const ctx = setup(opts);
  await ctx.session.start(CODE);
  return ctx;
}

test('stripTurn removes turn and turns urls only', () => {
  const input = {
    iceTransportPolicy: 'all',
    iceServers: [
      { urls: 'stun:stun.example.com' },
      { urls: ['stun:a.example.com', 'turn:t.example.com', 'turns:t.example.com:443'] },
      { urls: 'turn:only.example.com', username: 'u', credential: 'c' },
      { urls: ['TURNS:upper.example.com'] },
      { urls: ['stun:s2.example.com', 'turn:t2.example.com'] }
    ]
  };
  const out = stripTurn(input);
  assert.deepEqual(out.iceServers, [
    { urls: 'stun:stun.example.com' },
    { urls: ['stun:a.example.com'] },
    { urls: ['stun:s2.example.com'] }
  ]);
  assert.equal(out.iceTransportPolicy, 'all');
  assert.equal(input.iceServers.length, 5, 'input is not mutated');
  assert.deepEqual(stripTurn({}), { iceServers: [] });
  assert.deepEqual(stripTurn(undefined), { iceServers: [] });
});

test('tracked PC strips TURN and reports state changes', () => {
  FakeBase.instances = [];
  const seen = [];
  const Tracked = makeTrackedPeerConnection(FakeBase, (pc, state) => seen.push([pc, state]));
  const pc = new Tracked({ iceServers: [{ urls: ['stun:x', 'turn:y'] }, { urls: 'turns:z' }] });
  assert.ok(pc instanceof FakeBase);
  assert.deepEqual(pc.config.iceServers, [{ urls: ['stun:x'] }]);
  pc.dispatch('connecting');
  pc.dispatch('failed');
  assert.deepEqual(seen, [[pc, 'connecting'], [pc, 'failed']]);
});

test('invalid code emits invalid-code and never joins', async () => {
  const { session, joins, types } = setup();
  await session.start('hola mundo');
  assert.deepEqual(types(), ['invalid-code']);
  assert.equal(joins.length, 0);
});

test('start twice joins once', async () => {
  const { session, joins } = setup();
  await Promise.all([session.start(CODE), session.start(CODE)]);
  await session.start(CODE);
  assert.equal(joins.length, 1);
});

test('joins with derived roomId/password and appId p2pcomms-v1, then emits waiting', async () => {
  const { session, joins, types, tracked } = setup();
  await session.start(CODE.toUpperCase().replaceAll('-', ' '));
  const { roomId, password } = await deriveRoomSecrets(CODE, ITER);
  assert.equal(joins.length, 1);
  assert.equal(joins[0].roomId, roomId);
  assert.equal(joins[0].config.appId, APP_ID);
  assert.equal(joins[0].config.appId, 'p2pcomms-v1');
  assert.equal(joins[0].config.password, password);
  assert.deepEqual(joins[0].config.relayConfig, { manualReconnection: true });
  assert.equal(typeof joins[0].callbacks.onJoinError, 'function');
  assert.ok(new (tracked())({}) instanceof FakeBase);
  assert.deepEqual(types(), ['waiting']);
});

test('waiting expires after 600000 ms → leave + expired', async () => {
  const { session, room, types } = await started();
  assert.equal(WAIT_TIMEOUT_MS, 600000);
  mock.timers.tick(WAIT_TIMEOUT_MS - 1);
  assert.deepEqual(types(), ['waiting']);
  mock.timers.tick(1);
  assert.deepEqual(types(), ['waiting', 'expired']);
  assert.equal(room.leaves, 1);
  // finished: nothing more happens, and a fresh start works
  mock.timers.tick(CONNECT_TIMEOUT_MS * 20);
  assert.deepEqual(types(), ['waiting', 'expired']);
  await session.start(CODE);
  assert.deepEqual(types(), ['waiting', 'expired', 'waiting']);
});

test('connecting then no peer within 60000 ms → leave + failed timeout', async () => {
  const { room, types, events, tracked } = await started();
  assert.equal(CONNECT_TIMEOUT_MS, 60000);
  const pc = new (tracked())({});
  pc.dispatch('connecting');
  assert.deepEqual(types(), ['waiting', 'connecting']);
  // a second PC reaching connecting does not re-arm or re-emit
  mock.timers.tick(30000);
  new (tracked())({}).dispatch('connecting');
  assert.deepEqual(types(), ['waiting', 'connecting']);
  mock.timers.tick(CONNECT_TIMEOUT_MS - 30000 - 1);
  assert.deepEqual(types(), ['waiting', 'connecting']);
  mock.timers.tick(1);
  assert.deepEqual(types(), ['waiting', 'connecting', 'failed']);
  assert.deepEqual(events[2].detail, { reason: 'timeout' });
  assert.equal(room.leaves, 1);
  // wait timer was cleared: no expired later
  mock.timers.tick(WAIT_TIMEOUT_MS);
  assert.deepEqual(types(), ['waiting', 'connecting', 'failed']);
});

test('pc failed state → failed ice-failed', async () => {
  const { room, types, events, tracked } = await started();
  const pc = new (tracked())({});
  pc.dispatch('connecting');
  pc.dispatch('failed');
  assert.deepEqual(types(), ['waiting', 'connecting', 'failed']);
  assert.deepEqual(events[2].detail, { reason: 'ice-failed' });
  assert.equal(room.leaves, 1);
  // timers cleared, further events ignored
  pc.dispatch('failed');
  mock.timers.tick(WAIT_TIMEOUT_MS);
  assert.equal(room.leaves, 1);
  assert.equal(types().length, 3);
});

test('failed on a PC that never connected also fails the session', async () => {
  const { room, types, events, tracked } = await started();
  new (tracked())({}).dispatch('failed');
  assert.deepEqual(types(), ['waiting', 'failed']);
  assert.deepEqual(events[1].detail, { reason: 'ice-failed' });
  assert.equal(room.leaves, 1);
});

test('onJoinError → failed join-error', async () => {
  const { room, joins, types, events } = await started();
  joins[0].callbacks.onJoinError({ error: 'bad password' });
  assert.deepEqual(types(), ['waiting', 'failed']);
  assert.deepEqual(events[1].detail, { reason: 'join-error' });
  assert.equal(room.leaves, 1);
});

test('peer join → connected, timers cleared, all relay sockets closed, reconnection paused', async () => {
  const { session, room, types, events, closedSockets, calls, tracked } = await started();
  const pc = new (tracked())({});
  room.peers.p1 = pc;
  pc.dispatch('connecting');
  room.onPeerJoin('p1');
  assert.deepEqual(types(), ['waiting', 'connecting', 'connected']);
  assert.deepEqual(events[2].detail, { peerId: 'p1' });
  assert.deepEqual(closedSockets.sort(), ['wss://a', 'wss://b']);
  assert.equal(calls.pause, 1);
  assert.equal(session.peerId, 'p1');
  assert.equal(session.room, room);
  assert.equal(session.getPeerConnection(), pc);
  // timers cleared
  mock.timers.tick(WAIT_TIMEOUT_MS);
  assert.deepEqual(types(), ['waiting', 'connecting', 'connected']);
  assert.equal(room.leaves, 0);
  // PC state changes after connect are ignored here
  pc.dispatch('failed');
  assert.deepEqual(types(), ['waiting', 'connecting', 'connected']);
  assert.equal(room.leaves, 0);
});

test('second peer is closed and does not replace the first', async () => {
  const { session, room, types, closedSockets, calls, tracked } = await started();
  const pc1 = new (tracked())({});
  const pc2 = new (tracked())({});
  room.peers = { p1: pc1, p2: pc2 };
  room.onPeerJoin('p1');
  room.onPeerJoin('p2');
  assert.equal(pc2.closed, true);
  assert.equal(pc1.closed, false);
  assert.equal(session.peerId, 'p1');
  assert.equal(session.getPeerConnection(), pc1);
  assert.deepEqual(types(), ['waiting', 'connected']);
  assert.equal(closedSockets.length, 2);
  assert.equal(calls.pause, 1);
  assert.equal(room.leaves, 0);
  // the intruder leaving is not a peer-left
  room.onPeerLeave('p2');
  assert.deepEqual(types(), ['waiting', 'connected']);
});

test('connected peer leaving → peer-left + leave', async () => {
  const { session, room, types } = await started();
  room.peers.p1 = new (makeTrackedPeerConnection(FakeBase, () => {}))({});
  room.onPeerJoin('p1');
  room.onPeerLeave('p1');
  assert.deepEqual(types(), ['waiting', 'connected', 'peer-left']);
  assert.equal(room.leaves, 1);
  room.onPeerLeave('p1');
  assert.equal(types().length, 3);
  assert.equal(room.leaves, 1);
  // can start again
  await session.start(CODE);
  assert.equal(types().at(-1), 'waiting');
});

test('leave() clears timers, leaves the room and emits nothing', async () => {
  const { session, room, types, tracked } = await started();
  new (tracked())({}).dispatch('connecting');
  await session.leave();
  assert.equal(room.leaves, 1);
  mock.timers.tick(WAIT_TIMEOUT_MS);
  assert.deepEqual(types(), ['waiting', 'connecting']);
  assert.equal(room.leaves, 1);
  assert.equal(session.room, undefined);
  assert.equal(session.getPeerConnection(), undefined);
  // leave before start is harmless
  await setup().session.leave();
});

test('leave() while deriving secrets prevents the join', async () => {
  const { session, joins, types } = setup();
  const p = session.start(CODE);
  await session.leave();
  await p;
  await flush();
  assert.equal(joins.length, 0);
  assert.deepEqual(types(), []);
});

test('onJoinError after a peer is connected is ignored', async () => {
  const { session, room, joins, types } = await started();
  room.peers.p1 = new (makeTrackedPeerConnection(FakeBase, () => {}))({});
  room.onPeerJoin('p1');
  joins[0].callbacks.onJoinError({ error: 'third party handshake failed' });
  assert.deepEqual(types(), ['waiting', 'connected']);
  assert.equal(room.leaves, 0);
  assert.equal(session.peerId, 'p1');
});

test('start after a finished call resumes relay reconnection before joining', async () => {
  const { session, room, calls, types } = await started();
  assert.deepEqual(calls.order, ['resume', 'join']);
  room.peers.p1 = new (makeTrackedPeerConnection(FakeBase, () => {}))({});
  room.onPeerJoin('p1');
  room.onPeerLeave('p1');
  await session.start(CODE);
  assert.deepEqual(calls.order, ['resume', 'join', 'resume', 'join']);
  assert.equal(calls.resume, 2);
  assert.equal(types().at(-1), 'waiting');
});

test('leave() closes the peer connections after leaving the room', async () => {
  const { session, room, tracked } = await started();
  const pc1 = new (tracked())({});
  room.peers = { p1: pc1 };
  room.onPeerJoin('p1');
  await session.leave();
  assert.equal(room.leaves, 1);
  assert.equal(room.closedAtLeave, false);
  assert.equal(pc1.closed, true);
});

test('finish (expired) closes pending peer connections', async () => {
  const { room, types, tracked } = await started();
  const pc = new (tracked())({});
  room.peers = { p1: pc };
  mock.timers.tick(WAIT_TIMEOUT_MS);
  await flush();
  assert.deepEqual(types(), ['waiting', 'expired']);
  assert.equal(room.closedAtLeave, false);
  assert.equal(pc.closed, true);
});

test('peer-left closes the connected peer connection even though Trystero already dropped it', async () => {
  const { room, types, tracked } = await started();
  const pc = new (tracked())({});
  room.peers = { p1: pc };
  room.onPeerJoin('p1');
  room.peers = {};
  room.onPeerLeave('p1');
  await flush();
  assert.deepEqual(types(), ['waiting', 'connected', 'peer-left']);
  assert.equal(pc.closed, true);
});

test('a peer connection that throws on close does not break leave()', async () => {
  const { session, room, tracked } = await started();
  const bad = new (tracked())({});
  bad.close = () => {
    throw new Error('boom');
  };
  const good = new (tracked())({});
  room.peers = { p1: bad, p2: good };
  await session.leave();
  assert.equal(good.closed, true);
});

beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
afterEach(() => mock.timers.reset());
