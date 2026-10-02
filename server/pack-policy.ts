import { ComputeBudgetProgram, PublicKey, TransactionMessage, type VersionedTransaction } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import nacl from 'tweetnacl';
import { ReviewRequired } from './jobs';
import { PACK_TIERS } from '../shared/game';
import { config } from './config';

export const PACK_MEMO_PROGRAMS = new Set(['MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo']);

/** Validate intent, not just net balance changes. Never alter a provider-signed message. */
export function validatePackPayment(tx: VersionedTransaction, treasury: PublicKey, recipient: PublicKey, mint: PublicKey, amount: bigint, memo: string) {
  if (amount<=0n || amount>10_000_000_000n || !memo.startsWith(`${config.COLLECTOR_CRYPT_MEMO_PREFIX}-`) || !/^[a-zA-Z0-9_-]{1,80}$/.test(memo)) throw new ReviewRequired('Invalid pack purchase intent.');
  if (tx.message.addressTableLookups.length) throw new ReviewRequired('Pack address tables require review.');
  const message = TransactionMessage.decompile(tx.message);
  const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures);
  const sponsored = message.payerKey.equals(recipient);
  const providerIndex = signers.findIndex(k => k.equals(recipient));
  // Funded players pay the fee, but Collector Crypt still co-signs the memo.
  // Verify its signature in either payer order and allow no other signer.
  if ((!sponsored && !message.payerKey.equals(treasury)) || signers.length < 1 || signers.length > 2 || (sponsored && signers.length !== 2) || !signers.some(k => k.equals(treasury)) || signers.some(k => !k.equals(treasury) && !k.equals(recipient))) throw new ReviewRequired(`Pack requests an unexpected signer or fee payer. Configured payment wallet: ${recipient.toBase58()}. Provider fee payer: ${message.payerKey.toBase58()}. Check COLLECTOR_CRYPT_PAYMENT_WALLET.`);
  if (providerIndex >= 0) {
    if (!nacl.sign.detached.verify(tx.message.serialize(), tx.signatures[providerIndex], recipient.toBytes())) throw new ReviewRequired('Pack provider signature is missing or invalid.');
  }
  const source = getAssociatedTokenAddressSync(mint, treasury);
  const destination = getAssociatedTokenAddressSync(mint, recipient);
  let payments = 0, memos = 0, creates = 0, units = 200_000, microLamports = 0n;
  const budgets = new Set<number>();
  for (const ix of message.instructions) {
    if (ix.programId.equals(TOKEN_PROGRAM_ID)) {
      const checked = ix.data[0] === 12, transfer = ix.data[0] === 3;
      const keyCount = checked ? 4 : 3;
      // Collector Crypt repeats the treasury authority in the optional signer list.
      // Permit that exact duplicate only, never an additional authority or recipient.
      if ((!checked && !transfer) || ix.data.length !== (checked ? 10 : 9) || ix.keys.length < keyCount || ix.keys.length > keyCount + 1 || ix.keys.slice(keyCount).some(k => !k.pubkey.equals(treasury) || !k.isSigner)) throw new ReviewRequired('Unsupported pack token operation.');
      const to = ix.keys[checked ? 2 : 1], authority = ix.keys[checked ? 3 : 2];
      if (!ix.keys[0].pubkey.equals(source) || !to.pubkey.equals(destination) || !authority.pubkey.equals(treasury) || !authority.isSigner || ix.data.readBigUInt64LE(1) !== amount || (checked && (!ix.keys[1].pubkey.equals(mint) || ix.data[9] !== 6))) throw new ReviewRequired('Pack payment asset, recipient or amount mismatch.');
      payments++;
    } else if (PACK_MEMO_PROGRAMS.has(ix.programId.toBase58())) {
      if (ix.data.toString('utf8') !== `${memo}:open` || ix.keys.some(k => !k.pubkey.equals(treasury) && !k.pubkey.equals(recipient))) throw new ReviewRequired('Pack memo does not match the reserved purchase and open mode.');
      memos++;
    } else if (ix.programId.equals(ComputeBudgetProgram.programId)) {
      const op = ix.data[0];
      if (ix.keys.length || budgets.has(op)) throw new ReviewRequired('Invalid pack compute budget.');
      budgets.add(op);
      if (op === 2 && ix.data.length === 5) units = ix.data.readUInt32LE(1);
      else if (op === 3 && ix.data.length === 9) microLamports = ix.data.readBigUInt64LE(1);
      else throw new ReviewRequired('Unsupported pack compute budget.');
    } else if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      // Only an idempotent creation of the verified recipient's USDC ATA is needed.
      const expected = [message.payerKey, destination, recipient, mint, PublicKey.default, TOKEN_PROGRAM_ID];
      if (ix.data.length !== 1 || ix.data[0] !== 1 || ix.keys.length !== 6 || ix.keys.some((k, i) => !k.pubkey.equals(expected[i]))) throw new ReviewRequired('Unexpected pack token account creation.');
      creates++;
    } else throw new ReviewRequired('Unexpected pack instruction.');
  }
  if (payments !== 1 || memos !== 1 || creates > 1 || units < 1 || units > 400_000 || BigInt(units) * microLamports / 1_000_000n > 1_000_000n) throw new ReviewRequired('Pack payment shape or fee exceeds policy.');
}
