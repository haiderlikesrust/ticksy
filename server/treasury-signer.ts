import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

/** Backend only. Never include the supplied secret in an error or log. */
export function treasurySigner(privateKey: string): Keypair | null {
  const value = privateKey.trim();
  if (!value) return null;

  try {
    if (value.length > 4096) throw new Error();
    let bytes: Uint8Array;
    if (value.startsWith('[')) {
      const parsed: unknown = JSON.parse(value);
      if (!Array.isArray(parsed) || parsed.length !== 64 ||
          !parsed.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
        throw new Error();
      }
      bytes = Uint8Array.from(parsed);
    } else {
      bytes = bs58.decode(value);
    }
    if (bytes.length !== 64) throw new Error();
    // Keep web3's public/secret key consistency validation enabled.
    return Keypair.fromSecretKey(bytes);
  } catch {
    throw new Error('TREASURY_PRIVATE_KEY is invalid. Use a base58-encoded 64-byte Solana private key or a JSON array of 64 byte values.');
  }
}
