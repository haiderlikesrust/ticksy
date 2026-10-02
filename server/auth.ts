import { createHash, randomBytes, randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { config } from './config';
import type { Database } from './db';
import { shortWallet } from '../shared/game';
export const hashSession = (token: string) => createHash('sha256').update(token).digest('hex');
export async function challenge(db: Database, wallet: string) {
  new PublicKey(wallet);
  const id = randomUUID(), now = Date.now(), expiresAt = now + 300_000;
  const origin = new URL(config.APP_ORIGIN);
  const message = `${origin.host} wants you to sign in with your Solana account:\n${wallet}\n\nSign in to Ticksy. This does not authorize a transaction.\n\nURI: ${origin.origin}\nVersion: 1\nChain ID: solana:mainnet\nNonce: ${randomBytes(16).toString('hex')}\nIssued At: ${new Date(now).toISOString()}\nExpiration Time: ${new Date(expiresAt).toISOString()}`;
  await db.query('INSERT INTO challenges(id,wallet,message,expires_at) VALUES($1,$2,$3,$4)', [id,wallet,message,expiresAt]);
  return { id,message,expiresAt };
}
export async function verify(db: Database, id: string, signature: string) {
  const row = (await db.query('SELECT * FROM challenges WHERE id=$1 AND consumed=FALSE AND expires_at>$2', [id,Date.now()])).rows[0];
  if (!row) throw new Error('This login request expired or was already used.');
  if (!nacl.sign.detached.verify(new TextEncoder().encode(row.message), bs58.decode(signature), new PublicKey(row.wallet).toBytes())) throw new Error('Wallet signature is invalid.');
  const consumed = await db.query('UPDATE challenges SET consumed=TRUE WHERE id=$1 AND consumed=FALSE RETURNING id',[id]);
  if (!consumed.rows.length) throw new Error('Login request was already used.');
  await db.query('INSERT INTO players(wallet,name,created_at) VALUES($1,$2,$3) ON CONFLICT(wallet) DO NOTHING',[row.wallet,shortWallet(row.wallet),Date.now()]);
  const token = randomBytes(32).toString('hex');
  await db.query('INSERT INTO sessions(id,wallet,expires_at) VALUES($1,$2,$3)',[hashSession(token),row.wallet,Date.now()+86_400_000]);
  return { token, wallet: row.wallet as string };
}
export async function sessionPlayer(db: Database, token?: string) {
  if (!token) return null;
  const player = (await db.query('SELECT p.wallet,p.name FROM sessions s JOIN players p ON p.wallet=s.wallet WHERE s.id=$1 AND s.expires_at>$2',[hashSession(token),Date.now()])).rows[0];
  return player ? { wallet: player.wallet as string,name: player.name as string,owner: player.wallet === config.OWNER_WALLET } : null;
}
