import http from 'http';
import { randomUUID } from 'crypto';
import { URL } from 'url';
import fs from 'fs';
import path from 'path';

interface Room {
  state: 'created' | 'offer_set' | 'answer_set' | 'expired';
  offerSDP?: string;
  answerSDP?: string;
  createdAt: number;
  ttlMs: number;
}

const rooms = new Map<string, Room>();
const ROOM_TTL_MS = 120_000; // 120s
const MAX_BODY_SIZE = 1_000_000; // 1 MB

const rateLimits = new Map<string, { count: number; reset: number }>();

function cleanup() {
  const now = Date.now();
  for (const [token, room] of rooms) {
    if (now - room.createdAt > room.ttlMs) {
      rooms.delete(token);
    }
  }
  for (const [ip, info] of rateLimits) {
    if (now > info.reset) {
      rateLimits.delete(ip);
    }
  }
}
setInterval(cleanup, 5_000);

function sendJson(res: any, status: number, data: any) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

function sendStatus(res: any, status: number) {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end();
}

function checkRate(req: any, res: any): boolean {
  const ip = req.socket.remoteAddress || '';
  const now = Date.now();
  let info = rateLimits.get(ip);
  if (!info || now > info.reset) {
    info = { count: 0, reset: now + 60_000 };
    rateLimits.set(ip, info);
  }
  info.count++;
  if (info.count > 60) {
    sendStatus(res, 429);
    return false;
  }
  return true;
}

function getRoom(token: string): Room | undefined {
  const room = rooms.get(token);
  if (!room) return undefined;
  if (Date.now() - room.createdAt > room.ttlMs) {
    rooms.delete(token);
    return undefined;
  }
  return room;
}

async function readJson(req: any, res: any): Promise<any | null> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk: any) => {
      data += chunk;
      if (data.length > MAX_BODY_SIZE) {
        sendStatus(res, 413);
        req.destroy();
        resolve(null);
      }
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        sendStatus(res, 400);
        resolve(null);
      }
    });
  });
}

const PUBLIC_DIR = path.join(__dirname, '../../public');

const server = http.createServer(async (req: any, res: any) => {
  if (!req.url) return sendStatus(res, 404);
  if (!checkRate(req, res)) return;

  if (req.method === 'OPTIONS') {
    return sendStatus(res, 204);
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith('/v1/rooms')) {
    const match = url.pathname.match(/^\/v1\/rooms\/?$/);
    if (match && req.method === 'POST') {
      const token = randomUUID();
      const room: Room = { state: 'created', createdAt: Date.now(), ttlMs: ROOM_TTL_MS };
      rooms.set(token, room);
      const origin = `http://${req.headers.host}`;
      sendJson(res, 201, { token, joinUrl: `${origin}/room/${token}`, expiresInSec: ROOM_TTL_MS / 1000 });
      return;
    }

    const subMatch = url.pathname.match(/^\/v1\/rooms\/([a-zA-Z0-9-]+)(?:\/(offer|answer|status))?$/);
    if (subMatch) {
      const token = subMatch[1];
      const action = subMatch[2];
      const room = getRoom(token);
      if (!room) {
        return sendStatus(res, 404);
      }

      if (action === 'offer') {
        if (req.method === 'PUT') {
          if (room.state !== 'created') return sendStatus(res, 409);
          const body = await readJson(req, res);
          if (!body) return;
          room.offerSDP = body.sdp;
          room.state = 'offer_set';
          sendStatus(res, 204);
        } else if (req.method === 'GET') {
          if (room.state === 'offer_set' || room.state === 'answer_set') {
            sendJson(res, 200, { sdp: room.offerSDP });
          } else {
            sendStatus(res, 404);
          }
        } else {
          sendStatus(res, 405);
        }
        return;
      }

      if (action === 'answer') {
        if (req.method === 'PUT') {
          if (room.state !== 'offer_set' || room.answerSDP) return sendStatus(res, 409);
          const body = await readJson(req, res);
          if (!body) return;
          room.answerSDP = body.sdp;
          room.state = 'answer_set';
          sendStatus(res, 204);
        } else if (req.method === 'GET') {
          if (room.state === 'answer_set') {
            sendJson(res, 200, { sdp: room.answerSDP });
          } else {
            sendStatus(res, 404);
          }
        } else {
          sendStatus(res, 405);
        }
        return;
      }

      if (action === 'status') {
        if (req.method === 'GET') {
          const expiresInSec = Math.max(0, Math.floor((room.createdAt + room.ttlMs - Date.now()) / 1000));
          sendJson(res, 200, { state: room.state, expiresInSec });
        } else {
          sendStatus(res, 405);
        }
        return;
      }
    }

    return sendStatus(res, 404);
  }

  // Static files
  const serveIndex = () => {
    const file = path.join(PUBLIC_DIR, 'index.html');
    fs.createReadStream(file).pipe(res);
  };

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.setHeader('Content-Type', 'text/html');
    return serveIndex();
  }
  if (url.pathname.startsWith('/room/')) {
    res.setHeader('Content-Type', 'text/html');
    return serveIndex();
  }

  const filePath = path.join(PUBLIC_DIR, url.pathname);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    const type = ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'text/plain';
    res.setHeader('Content-Type', type);
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  sendStatus(res, 404);
});

const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
