const HOSTS = ['arweave.net', 'ipfs.io', 'nftstorage.link', 'collectorcrypt.com', 'cloudfront.net'];

export function metadataUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !HOSTS.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) throw new Error('Metadata host is not allowed.');
  return url;
}

export async function fetchMetadata(value: string) {
  const url = metadataUrl(value);
  // No redirects: an allowed host must not forward server requests to private services.
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok || !response.body) throw new Error('Metadata is unavailable.');
  const max = 256 * 1024;
  if (Number(response.headers.get('content-length')) > max) { await response.body.cancel(); throw new Error('Metadata is too large.'); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) { await reader.cancel(); throw new Error('Metadata is too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
