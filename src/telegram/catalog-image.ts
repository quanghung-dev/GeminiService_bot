import sharp from 'sharp';

const imageHosts = new Set([
  'unpkg.com', 'cdn.jsdelivr.net', 'is1-ssl.mzstatic.com',
  ...(process.env.PRODUCT_IMAGE_HOSTS ?? '').split(',').map(host => host.trim().toLowerCase()),
]);
const maxBytes = 5 * 1024 * 1024;

export async function prepareProductEmoji(source: string): Promise<Buffer | undefined> {
  try {
    let url = new URL(source);
    const signal = AbortSignal.timeout(5000);
    for (let hop = 0; hop < 4; hop++) {
      if (url.protocol !== 'https:' || url.username || url.password || url.port || !imageHosts.has(url.hostname)) return;
      const response = await fetch(url, { signal, redirect: 'manual' });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        url = new URL(location, url);
        continue;
      }
      if (!response.ok || !response.body || Number(response.headers.get('content-length')) > maxBytes) {
        await response.body?.cancel();
        return;
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maxBytes) return;
        chunks.push(chunk);
      }
      return await sharp(Buffer.concat(chunks), { limitInputPixels: 25_000_000 })
        .rotate()
        .resize(100, 100, { fit: 'contain', background: '#00000000' })
        .png()
        .toBuffer();
    }
  } catch {
    return;
  }
}
