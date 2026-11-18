// Vercel serverless function: the whole backend for the quiz.
// Storage: a Redis database connected in Vercel (Upstash). No npm packages needed.
// Env vars are added automatically when you connect the database (KV_REST_API_URL / _TOKEN, or UPSTASH_REDIS_REST_URL / _TOKEN).

const ADMIN = process.env.QUIZ_ADMIN || 'illumi13'; // can be overridden with an env var in Vercel
const TTL = 6 * 3600;                               // everything auto-expires after 6 hours
const HB = 15;                                      // host heartbeat: if the host's screen goes quiet for 15 s, the game is over
const K = {hb: 'gtq:hb', s: 'gtq:state', p: 'gtq:players', sc: 'gtq:scores', a: 'gtq:ans:'};

function conf() {
  const e = process.env;
  const uk = Object.keys(e).find(k => /(_REST_API_URL|REDIS_REST_URL)$/.test(k) && e[k]);
  if (!uk) return null;
  const tk = uk.replace(/URL$/, 'TOKEN');
  return e[tk] ? {url: e[uk].replace(/\/$/, ''), token: e[tk]} : null;
}

// one HTTP round trip to Redis, many commands
async function rp(cmds) {
  const c = conf();
  if (!c) throw new Error('no-redis');
  const r = await fetch(c.url + '/pipeline', {
    method: 'POST',
    headers: {Authorization: 'Bearer ' + c.token, 'content-type': 'application/json'},
    body: JSON.stringify(cmds)
  });
  const j = await r.json();
  if (!r.ok || !Array.isArray(j)) throw new Error('redis-http');
  return j.map(x => { if (x.error) throw new Error(x.error); return x.result; });
}

const qi = v => { const n = Number(v); return Number.isInteger(n) && n >= 0 && n < 50 ? n : null; };
const idOk = v => typeof v === 'string' && /^[a-z0-9]{4,20}$/i.test(v);
const nm = v => String(v || '').trim().slice(0, 16);
const PHASES = ['lobby', 'meme', 'open', 'reveal', 'between', 'done'];

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ok: false});
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};
  const adm = b.adm === ADMIN;

  try {
    switch (b.a) {
      case 'ping': {
        if (!conf()) return res.json({ok: false, e: 'no-db'});
        await rp([['PING']]);
        return res.json({ok: true});
      }

      // every device calls this once a second: 1 Redis command for players, 3 for the admin
      case 'poll': {
        const cmds = [['MGET', K.s, K.hb]];
        if (adm) {
          cmds.push(['SET', K.hb, '1', 'EX', HB]);           // the host's poll doubles as its heartbeat
          cmds.push(['HLEN', K.p]);
          const i = qi(b.i);
          if (i !== null) cmds.push(['HVALS', K.a + i]);
        }
        const out = await rp(cmds);
        const raw = out[0][0], alive = out[0][1];
        let s = raw ? JSON.parse(raw) : null;
        if (!adm && s && !alive && s.phase !== 'lobby' && s.phase !== 'done') s = Object.assign({}, s, {phase: 'ended'});
        const av = adm && Array.isArray(out[3]) ? out[3] : [];
        const d = [0, 1, 2, 3].map(j => av.filter(v => Number(v) === j).length);   // how many picked each option (host only)
        return res.json({ok: true, s, np: adm ? out[2] || 0 : 0, na: av.length, d});
      }

      case 'join': {
        const name = nm(b.name);
        if (!idOk(b.id) || !name) return res.json({ok: false});
        await rp([['HSET', K.p, b.id, name], ['EXPIRE', K.p, TTL]]);
        return res.json({ok: true});
      }

      case 'ans': {
        const i = qi(b.i), k = Number(b.k);
        if (i === null || !idOk(b.id) || ![0, 1, 2, 3].includes(k)) return res.json({ok: false});
        await rp([['HSETNX', K.a + i, b.id, k], ['EXPIRE', K.a + i, TTL]]); // first answer wins
        return res.json({ok: true});
      }

      case 'state': {
        if (!adm) return res.status(403).json({ok: false});
        const i = Number(b.i);
        if (!Number.isInteger(i) || i < -1 || i > 49 || !PHASES.includes(b.phase)) return res.json({ok: false});
        const [cur] = await rp([['GET', K.s]]);
        const g = cur ? JSON.parse(cur).g : undefined;       // keep the quiz "generation" across questions
        const n = Number(b.n) > 0 ? Number(b.n) : Date.now();
        const cmds = [['SET', K.s, JSON.stringify({i, phase: b.phase, n, g}), 'EX', TTL]];
        if (b.phase === 'open') cmds.push(['DEL', K.a + i]);
        await rp(cmds);
        return res.json({ok: true});
      }

      case 'score': {
        const s = Math.round(Number(b.score));
        if (!idOk(b.id) || !nm(b.name) || !(s >= 0 && s <= 100000)) return res.json({ok: false});
        await rp([['HSET', K.sc, b.id, JSON.stringify({n: nm(b.name), s, c: Math.min(50, Math.max(0, Math.round(Number(b.c)) || 0))})], ['EXPIRE', K.sc, TTL]]);
        return res.json({ok: true});
      }

      case 'board': {
        const [flat] = await rp([['HGETALL', K.sc]]);
        const rows = [];
        for (let x = 1; x < (flat || []).length; x += 2) { try { const r = JSON.parse(flat[x]); r.id = flat[x - 1]; rows.push(r); } catch (e) {} }
        rows.sort((p, q) => q.s - p.s);
        const w = rows.find(r => r.id === b.id);
        const me = w ? {r: rows.filter(r => r.s > w.s).length + 1, s: w.s, c: w.c} : null;   // ties share a rank
        return res.json({ok: true, b: rows.slice(0, 50).map(r => ({n: r.n, s: r.s, c: r.c})), t: rows.length, me});
      }

      case 'reset': {
        if (!adm) return res.status(403).json({ok: false});
        const g = Math.random().toString(36).slice(2, 8);     // new generation: every phone wipes its old score
        const cmds = [['DEL', K.p, K.sc]];
        for (let i = 0; i < 50; i++) cmds.push(['DEL', K.a + i]);
        cmds.push(['SET', K.s, JSON.stringify({i: -1, phase: 'lobby', n: Date.now(), g}), 'EX', TTL]);
        cmds.push(['SET', K.hb, '1', 'EX', HB]);
        await rp(cmds);
        return res.json({ok: true});
      }

      default:
        return res.json({ok: false});
    }
  } catch (e) {
    return res.status(500).json({ok: false, e: String(e.message || e)});
  }
};
