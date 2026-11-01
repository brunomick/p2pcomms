import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireMedia, createCall } from '../../src/call.js';

class FakeStream {
  constructor(tracks = []) {
    this.tracks = tracks;
  }
  getTracks() {
    return [...this.tracks];
  }
}

function makeGum(devices = { audio: true, video: true }) {
  const gum = async constraints => {
    gum.calls.push(constraints);
    const tracks = [];
    for (const kind of ['audio', 'video']) {
      if (!constraints[kind]) continue;
      if (!devices[kind]) throw new Error(`NotFoundError: ${kind}`);
      const track = {
        kind,
        enabled: true,
        stopped: false,
        stop() {
          this.stopped = true;
        }
      };
      gum.tracks.push(track);
      tracks.push(track);
    }
    return new FakeStream(tracks);
  };
  gum.calls = [];
  gum.tracks = [];
  return gum;
}

// Fake Trystero room: its single 'call' action delivers synchronously to the other room.
function makeRoom(id) {
  const room = {
    id,
    other: null,
    action: null,
    sent: [],
    added: [],
    removed: [],
    onPeerStream: null,
    makeAction(ns) {
      assert.equal(ns, 'call');
      room.action = {
        onMessage: null,
        send(data, options = {}) {
          room.sent.push({ data, target: options.target });
          room.other.action?.onMessage?.(structuredClone(data), { peerId: id });
          return Promise.resolve();
        }
      };
      return room.action;
    },
    addStream(stream, options) {
      room.added.push({ stream, target: options.target });
      return [Promise.resolve()];
    },
    removeStream(stream, options) {
      room.removed.push({ stream, target: options.target });
    }
  };
  return room;
}

function makePeer(id, otherId, devices) {
  const room = makeRoom(id);
  const gum = makeGum(devices);
  const events = [];
  const call = createCall({
    room,
    peerId: otherId,
    getUserMedia: gum,
    MediaStream: FakeStream,
    onEvent: (type, detail) => events.push({ type, detail })
  });
  return { room, gum, events, call, types: () => events.map(e => e.type) };
}

function setup(devicesA, devicesB) {
  const a = makePeer('A', 'B', devicesA);
  const b = makePeer('B', 'A', devicesB);
  a.room.other = b.room;
  b.room.other = a.room;
  return { a, b };
}

test('acquireMedia requests audio and video separately', async () => {
  const gum = makeGum({ audio: true, video: false });
  const { stream, missing } = await acquireMedia(gum, { audio: true, video: true }, FakeStream);
  assert.deepEqual(gum.calls, [{ audio: true }, { video: true }]);
  assert.deepEqual(missing, ['video']);
  assert.deepEqual(
    stream.getTracks().map(t => t.kind),
    ['audio']
  );
});

test('acquireMedia merges both kinds into one stream', async () => {
  const gum = makeGum();
  const { stream, missing } = await acquireMedia(gum, { audio: true, video: true }, FakeStream);
  assert.deepEqual(missing, []);
  assert.deepEqual(
    stream.getTracks().map(t => t.kind),
    ['audio', 'video']
  );
});

test('acquireMedia with no devices returns null stream', async () => {
  const gum = makeGum({ audio: false, video: false });
  const { stream, missing } = await acquireMedia(gum, { audio: true, video: true }, FakeStream);
  assert.equal(stream, null);
  assert.deepEqual(missing, ['audio', 'video']);
});

test('acquireMedia only asks for the requested kinds', async () => {
  const gum = makeGum();
  const { stream, missing } = await acquireMedia(gum, { audio: true, video: false }, FakeStream);
  assert.deepEqual(gum.calls, [{ audio: true }]);
  assert.deepEqual(missing, []);
  assert.equal(stream.getTracks().length, 1);
});

test('receiving an invite never touches getUserMedia', async () => {
  const { a, b } = setup();
  await a.call.invite('video');
  assert.equal(b.gum.calls.length, 0);
  assert.equal(b.call.state, 'incoming');
  assert.equal(a.call.state, 'outgoing');
  assert.deepEqual(b.events, [{ type: 'incoming', detail: { kind: 'video' } }]);
  assert.deepEqual(a.room.sent, [{ data: { t: 'invite', kind: 'video' }, target: 'B' }]);
});

test('invite acquires media, adds the stream to the peer and warns on missing devices', async () => {
  const { a } = setup({ audio: true, video: false });
  await a.call.invite('video');
  assert.deepEqual(a.gum.calls, [{ audio: true }, { video: true }]);
  assert.equal(a.room.added.length, 1);
  assert.equal(a.room.added[0].target, 'B');
  const warning = a.events.find(e => e.type === 'media-warning');
  assert.deepEqual(warning.detail, { missing: ['video'] });
  assert.equal(a.events.find(e => e.type === 'local-stream').detail.stream, a.room.added[0].stream);
});

test('accept solo audio requests no camera', async () => {
  const { a, b } = setup();
  await a.call.invite('video');
  await b.call.accept(false);
  assert.deepEqual(b.gum.calls, [{ audio: true }]);
  assert.equal(b.call.state, 'active');
  assert.equal(a.call.state, 'active');
  assert.deepEqual(b.room.sent, [{ data: { t: 'accept', video: false }, target: 'A' }]);
});

test('accept with video requests camera separately', async () => {
  const { a, b } = setup();
  await a.call.invite('audio');
  await b.call.accept(true);
  assert.deepEqual(b.gum.calls, [{ audio: true }, { video: true }]);
  assert.deepEqual(b.room.sent[0].data, { t: 'accept', video: true });
});

test('accept without any device still activates the call', async () => {
  const { a, b } = setup(undefined, { audio: false, video: false });
  await a.call.invite('audio');
  await b.call.accept(true);
  assert.equal(b.call.state, 'active');
  assert.equal(a.call.state, 'active');
  assert.deepEqual(b.events.find(e => e.type === 'media-warning').detail, { missing: ['audio', 'video'] });
  assert.equal(b.room.added.length, 0);
  assert.equal(b.events.some(e => e.type === 'local-stream'), false);
  assert.deepEqual(b.room.sent, [{ data: { t: 'accept', video: true }, target: 'A' }]);
  assert.ok(b.types().includes('active'));
  assert.ok(a.types().includes('active'));
});

test('remote stream is held until active', async () => {
  const { a, b } = setup();
  const remote = new FakeStream();
  await a.call.invite('audio');
  b.room.onPeerStream(remote, 'A');
  assert.equal(b.types().includes('remote-stream'), false);
  await b.call.accept(false);
  const ev = b.events.filter(e => e.type === 'remote-stream');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].detail.stream, remote);

  // Caller side: stream arriving before the accept is held too, then later ones pass straight through.
  const early = new FakeStream();
  const caller = makePeer('A', 'B');
  const callee = makePeer('B', 'A');
  caller.room.other = callee.room;
  callee.room.other = caller.room;
  await caller.call.invite('audio');
  caller.room.onPeerStream(early, 'B');
  assert.equal(caller.types().includes('remote-stream'), false);
  await callee.call.accept(false);
  assert.equal(caller.events.find(e => e.type === 'remote-stream').detail.stream, early);
  const later = new FakeStream();
  caller.room.onPeerStream(later, 'B');
  assert.equal(caller.events.filter(e => e.type === 'remote-stream').at(-1).detail.stream, later);
});

test('remote streams from other peers or while idle are ignored', async () => {
  const { a, b } = setup();
  b.room.onPeerStream(new FakeStream(), 'A'); // idle
  await a.call.invite('audio');
  await b.call.accept(false);
  const before = b.events.filter(e => e.type === 'remote-stream').length;
  b.room.onPeerStream(new FakeStream(), 'Z'); // wrong peer
  assert.equal(b.events.filter(e => e.type === 'remote-stream').length, before);
  assert.equal(before, 0);
});

test('a stale remote stream is not replayed on the next call', async () => {
  const { a, b } = setup();
  await a.call.invite('audio');
  b.room.onPeerStream(new FakeStream(), 'A');
  b.call.reject();
  await a.call.invite('audio');
  await b.call.accept(false);
  assert.equal(b.types().includes('remote-stream'), false);
});

test('reject returns both sides to idle and stops caller tracks', async () => {
  const { a, b } = setup();
  await a.call.invite('video');
  const callerStream = a.room.added[0].stream;
  b.call.reject();
  assert.equal(b.call.state, 'idle');
  assert.equal(a.call.state, 'idle');
  assert.deepEqual(b.room.sent, [{ data: { t: 'reject' }, target: 'A' }]);
  assert.ok(a.gum.tracks.length > 0 && a.gum.tracks.every(t => t.stopped));
  assert.equal(a.room.removed[0].stream, callerStream);
  assert.equal(a.room.removed[0].target, 'B');
  assert.ok(a.types().includes('rejected'));
  assert.equal(b.gum.calls.length, 0);
});

test('hangup stops local tracks on both sides', async () => {
  const { a, b } = setup();
  await a.call.invite('video');
  await b.call.accept(true);
  a.call.hangup();
  assert.equal(a.call.state, 'idle');
  assert.equal(b.call.state, 'idle');
  assert.ok(a.gum.tracks.length === 2 && a.gum.tracks.every(t => t.stopped));
  assert.ok(b.gum.tracks.length === 2 && b.gum.tracks.every(t => t.stopped));
  assert.equal(a.room.removed.length, 1);
  assert.equal(b.room.removed.length, 1);
  assert.ok(a.types().includes('ended'));
  assert.ok(b.types().includes('ended'));
  assert.deepEqual(a.room.sent.at(-1), { data: { t: 'hangup' }, target: 'B' });
});

test('hangup while outgoing cancels the invite', async () => {
  const { a, b } = setup();
  await a.call.invite('audio');
  a.call.hangup();
  assert.equal(a.call.state, 'idle');
  assert.equal(b.call.state, 'idle');
  assert.ok(a.gum.tracks.every(t => t.stopped));
  assert.ok(a.types().includes('ended'));
  assert.ok(b.types().includes('ended'));
});

test('hangup before media is acquired discards the late tracks and sends no invite', async () => {
  const { a } = setup();
  const pending = a.call.invite('audio');
  a.call.hangup();
  await pending;
  assert.equal(a.call.state, 'idle');
  assert.ok(a.gum.tracks.every(t => t.stopped));
  assert.equal(a.room.added.length, 0);
  assert.equal(a.room.sent.some(m => m.data.t === 'invite'), false);
});

test('dispose stops tracks without sending', async () => {
  const { a, b } = setup();
  await a.call.invite('video');
  await b.call.accept(true);
  const sentBefore = a.room.sent.length;
  a.call.dispose();
  assert.equal(a.call.state, 'idle');
  assert.ok(a.gum.tracks.every(t => t.stopped));
  assert.equal(a.room.sent.length, sentBefore);
  assert.equal(b.call.state, 'active');
});

test('mute and camera toggles flip track.enabled', async () => {
  const { a } = setup();
  await a.call.invite('video');
  const [audio, video] = a.gum.tracks;
  a.call.setMicEnabled(false);
  assert.equal(audio.enabled, false);
  assert.equal(video.enabled, true);
  a.call.setCameraEnabled(false);
  assert.equal(video.enabled, false);
  a.call.setMicEnabled(true);
  a.call.setCameraEnabled(true);
  assert.equal(audio.enabled, true);
  assert.equal(video.enabled, true);
});

test('an invite while busy gets a reject and keeps the current state', async () => {
  const { a, b } = setup();
  await a.call.invite('audio');
  await b.call.accept(false);
  a.room.action.onMessage({ t: 'invite', kind: 'video' }, { peerId: 'B' });
  assert.deepEqual(a.room.sent.at(-1), { data: { t: 'reject' }, target: 'B' });
  assert.equal(a.call.state, 'active');
  assert.equal(b.call.state, 'active');
});

test('messages that do not fit the state, or come from another peer, are ignored', async () => {
  const { a } = setup();
  const send = msg => a.room.action.onMessage(msg, { peerId: 'B' });
  send({ t: 'accept', video: true });
  send({ t: 'reject' });
  send({ t: 'hangup' });
  send({ t: 'bogus' });
  send(null);
  assert.equal(a.call.state, 'idle');
  assert.equal(a.events.length, 0);
  a.room.action.onMessage({ t: 'invite', kind: 'audio' }, { peerId: 'Z' });
  assert.equal(a.call.state, 'idle');
  assert.equal(a.room.sent.length, 0);
});

test('invite is a no-op unless idle; accept and reject only act when incoming', async () => {
  const { a } = setup();
  await a.call.invite('audio');
  const gumCalls = a.gum.calls.length;
  await a.call.invite('video');
  assert.equal(a.gum.calls.length, gumCalls);
  await a.call.accept(true);
  a.call.reject();
  assert.equal(a.call.state, 'outgoing');
  assert.equal(a.room.sent.length, 1);
});

test('a second accept while the first is acquiring does nothing', async () => {
  const { a, b } = setup();
  await a.call.invite('audio');
  await Promise.all([b.call.accept(false), b.call.accept(false)]);
  assert.equal(b.gum.calls.length, 1);
  assert.equal(b.room.sent.filter(m => m.data.t === 'accept').length, 1);
});

test('reject while accept is acquiring discards the late tracks', async () => {
  const { a, b } = setup();
  await a.call.invite('audio');
  const pending = b.call.accept(false);
  b.call.reject();
  await pending;
  assert.equal(b.call.state, 'idle');
  assert.ok(b.gum.tracks.every(t => t.stopped));
  assert.equal(b.room.sent.some(m => m.data.t === 'accept'), false);
});
