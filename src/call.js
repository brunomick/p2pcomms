// Call controller on top of a Trystero room. Messages: invite / accept / reject / hangup.
// The callee's devices are only requested after they accept; mic and camera are requested separately
// so a machine without one of them can still take part (e.g. receive audio with no devices at all).

export async function acquireMedia(getUserMedia, { audio, video }, MediaStreamCtor = globalThis.MediaStream) {
  const tracks = [];
  const missing = [];
  for (const [kind, wanted] of [['audio', audio], ['video', video]]) {
    if (!wanted) continue;
    try {
      const stream = await getUserMedia({ [kind]: true });
      tracks.push(...stream.getTracks());
    } catch {
      missing.push(kind);
    }
  }
  return { stream: tracks.length > 0 ? new MediaStreamCtor(tracks) : null, missing };
}

export function createCall({ room, peerId, getUserMedia, MediaStream, onEvent = () => {} }) {
  const action = room.makeAction('call');
  let state = 'idle';
  let localStream = null;
  let remoteStream = null;
  let accepting = false;
  // Bumped on every return to idle so a getUserMedia that resolves late can tell it was cancelled.
  let epoch = 0;

  const send = data => {
    try {
      Promise.resolve(action.send(data, { target: peerId })).catch(() => {});
    } catch {
      // peer already gone
    }
  };

  const stopLocal = () => {
    localStream?.getTracks().forEach(t => t.stop());
    localStream = null;
  };

  const toIdle = () => {
    const stream = localStream;
    if (stream) {
      try {
        room.removeStream(stream, { target: peerId });
      } catch {
        // peer already gone
      }
    }
    stopLocal();
    remoteStream = null;
    state = 'idle';
    accepting = false;
    epoch++;
  };

  // Returns false (after discarding the tracks) if the call was cancelled while waiting for devices.
  const acquire = async (opts, token) => {
    const { stream, missing } = await acquireMedia(getUserMedia, opts, MediaStream);
    if (token !== epoch) {
      stream?.getTracks().forEach(t => t.stop());
      return false;
    }
    if (missing.length > 0) onEvent('media-warning', { missing });
    if (stream) {
      localStream = stream;
      onEvent('local-stream', { stream });
      try {
        for (const p of room.addStream(stream, { target: peerId })) Promise.resolve(p).catch(() => {});
      } catch {
        // peer already gone
      }
    }
    return true;
  };

  const goActive = () => {
    state = 'active';
    onEvent('active');
    if (remoteStream) onEvent('remote-stream', { stream: remoteStream });
  };

  action.onMessage = (data, context) => {
    if (context?.peerId !== peerId || !data || typeof data !== 'object') return;
    switch (data.t) {
      case 'invite':
        if (state !== 'idle') {
          send({ t: 'reject' });
          return;
        }
        state = 'incoming';
        onEvent('incoming', { kind: data.kind === 'video' ? 'video' : 'audio' });
        break;
      case 'accept':
        if (state === 'outgoing') goActive();
        break;
      case 'reject':
        if (state === 'outgoing') {
          toIdle();
          onEvent('rejected');
        }
        break;
      case 'hangup':
        if (state === 'incoming' || state === 'active') {
          toIdle();
          onEvent('ended');
        }
        break;
    }
  };

  room.onPeerStream = (stream, id) => {
    if (id !== peerId || state === 'idle') return;
    remoteStream = stream;
    if (state === 'active') onEvent('remote-stream', { stream });
  };

  const setEnabled = (kind, on) => {
    localStream
      ?.getTracks()
      .filter(t => t.kind === kind)
      .forEach(t => {
        t.enabled = on;
      });
  };

  return {
    async invite(kind) {
      if (state !== 'idle') return;
      state = 'outgoing';
      const token = epoch;
      if (!(await acquire({ audio: true, video: kind === 'video' }, token))) return;
      send({ t: 'invite', kind });
    },
    async accept(withVideo) {
      if (state !== 'incoming' || accepting) return;
      accepting = true;
      const token = epoch;
      if (!(await acquire({ audio: true, video: withVideo === true }, token))) return;
      accepting = false;
      send({ t: 'accept', video: withVideo === true });
      goActive();
    },
    reject() {
      if (state !== 'incoming') return;
      send({ t: 'reject' });
      toIdle();
    },
    hangup() {
      if (state !== 'outgoing' && state !== 'active') return;
      send({ t: 'hangup' });
      toIdle();
      onEvent('ended');
    },
    setMicEnabled: on => setEnabled('audio', on),
    setCameraEnabled: on => setEnabled('video', on),
    dispose() {
      stopLocal();
      remoteStream = null;
      state = 'idle';
      accepting = false;
      epoch++;
      action.onMessage = null;
      room.onPeerStream = null;
    },
    get state() {
      return state;
    }
  };
}
