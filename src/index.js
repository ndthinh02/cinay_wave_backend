import 'dotenv/config';
import mongoose from 'mongoose';
import { createApp } from './app.js';
import { User, Session, Favorite, History, Review } from './models.js';
if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
mongoose.set('bufferCommands', false);
let initialized = false;
const app = createApp({ secret: process.env.JWT_SECRET, trustProxyHops: Number(process.env.TRUST_PROXY_HOPS || 0), isDatabaseReady: () => initialized && mongoose.connection.readyState === 1 });
const server = app.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('CinayWave API listening'));
let closing = false;
function databaseError(error) {
  const message = String(error?.message || 'Unknown database error')
    .replace(/mongodb(?:\+srv)?:\/\/[^\s'"<>]+/gi, '[MongoDB URI hidden]')
    .replace(/[\r\n]+/g, ' ').slice(0, 700);
  return { name: error?.name, code: error?.code, message };
}
async function connect() {
  while (!closing) {
    let stage = 'connection';
    try {
      await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
      stage = 'indexes';
      await Promise.all([User.init(), Session.init(), Favorite.init(), History.init(), Review.init()]);
      initialized = true;
      console.log('MongoDB connected');
      return;
    } catch (error) {
      initialized = false;
      console.error('MongoDB unavailable; retrying in 5 seconds', JSON.stringify({ stage, ...databaseError(error) }));
      const servers = error?.reason?.servers;
      if (servers instanceof Map) for (const [host, server] of servers) {
        if (server.error) console.error('MongoDB node connection failed', JSON.stringify({ host, ...databaseError(server.error) }));
      }
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}
void connect();
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { closing = true; server.close(async () => { await mongoose.disconnect(); process.exit(0); }); });
