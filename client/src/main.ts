const statusEl = document.getElementById('status') as HTMLElement;
const copyBtn = document.getElementById('copyBtn') as HTMLButtonElement;
const endBtn = document.getElementById('endBtn') as HTMLButtonElement;

let pc: RTCPeerConnection | null = null;
let localStream: MediaStream | null = null;
let roomToken: string | null = null;
const ROOM_TTL_MS = 120000;

function updateStatus(text: string) {
  statusEl.textContent = text;
}

function cleanup() {
  if (pc) {
    pc.onconnectionstatechange = null;
    pc.close();
    pc = null;
  }
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
}

endBtn.addEventListener('click', () => {
  cleanup();
  updateStatus('Call ended');
});

async function getMic(): Promise<MediaStream | null> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  } catch {
    updateStatus('Microphone access required');
    return null;
  }
}

function waitForIce(pc: RTCPeerConnection): Promise<void> {
  return new Promise(resolve => {
    if (pc.iceGatheringState === 'complete') return resolve();
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') resolve();
    });
  });
}

async function poll(url: string, ttl: number): Promise<any> {
  let delay = 500;
  const end = Date.now() + ttl;
  while (Date.now() < end) {
    const resp = await fetch(url);
    if (resp.status === 200) {
      return await resp.json();
    }
    if (resp.status !== 404) {
      throw new Error('error');
    }
    await new Promise(r => setTimeout(r, delay));
    delay = Math.min(delay * 2, 2000);
  }
  throw new Error('timeout');
}

async function startInitiator() {
  const resp = await fetch('/v1/rooms', { method: 'POST' });
  const data = await resp.json();
  roomToken = data.token;
  const joinUrl = data.joinUrl;
  await navigator.clipboard.writeText(joinUrl);
  updateStatus('Ready. Send the link to your partner');
  copyBtn.style.display = 'none';
  endBtn.style.display = 'inline-block';

  const stream = await getMic();
  if (!stream) return;
  localStream = stream;

  pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  const remoteAudio = new Audio();
  remoteAudio.autoplay = true;
  pc.ontrack = ev => { remoteAudio.srcObject = ev.streams[0]; };
  stream.getTracks().forEach(t => pc!.addTrack(t, stream));

  await pc.setLocalDescription(await pc.createOffer());
  await waitForIce(pc);
  await fetch(`/v1/rooms/${roomToken}/offer`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sdp: pc.localDescription!.sdp })
  });

  updateStatus('Waiting for answer...');
  try {
    const ans = await poll(`/v1/rooms/${roomToken}/answer`, ROOM_TTL_MS);
    await pc.setRemoteDescription({ type: 'answer', sdp: ans.sdp });
    updateStatus('Establishing connection...');
  } catch (e: any) {
    updateStatus(e.message === 'timeout' ? 'Link expired' : 'Connection failed');
    cleanup();
    return;
  }

  pc.onconnectionstatechange = () => {
    if (!pc) return;
    if (pc.connectionState === 'connected') {
      updateStatus('Connection established');
    } else if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
      updateStatus('Call ended');
    }
  };
}

async function startReceiver(token: string) {
  roomToken = token;
  copyBtn.style.display = 'none';
  endBtn.style.display = 'inline-block';
  updateStatus('Connecting...');

  const stream = await getMic();
  if (!stream) return;
  localStream = stream;

  let offerData: any;
  try {
    offerData = await poll(`/v1/rooms/${token}/offer`, ROOM_TTL_MS);
  } catch (e: any) {
    updateStatus(e.message === 'timeout' ? 'Link expired' : 'Connection failed');
    return;
  }

  pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  const remoteAudio = new Audio();
  remoteAudio.autoplay = true;
  pc.ontrack = ev => { remoteAudio.srcObject = ev.streams[0]; };
  stream.getTracks().forEach(t => pc!.addTrack(t, stream));

  await pc.setRemoteDescription({ type: 'offer', sdp: offerData.sdp });
  await pc.setLocalDescription(await pc.createAnswer());
  await waitForIce(pc);
  const putResp = await fetch(`/v1/rooms/${token}/answer`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sdp: pc.localDescription!.sdp })
  });
  if (putResp.status === 409) {
    updateStatus('Room occupied');
    cleanup();
    return;
  }
  if (!putResp.ok) {
    updateStatus('Link expired');
    cleanup();
    return;
  }
  updateStatus('Establishing connection...');

  pc.onconnectionstatechange = () => {
    if (!pc) return;
    if (pc.connectionState === 'connected') {
      updateStatus('Connection established');
    } else if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
      updateStatus('Call ended');
    }
  };
}

function init() {
  endBtn.style.display = 'none';
  const path = window.location.pathname;
  if (path.startsWith('/room/')) {
    const token = path.split('/')[2];
    startReceiver(token);
  } else {
    updateStatus('');
    copyBtn.style.display = 'inline-block';
    copyBtn.addEventListener('click', () => {
      startInitiator();
    });
  }
}

init();
