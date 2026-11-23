import { readFile } from 'node:fs/promises';

export const productEmojiMapPath = '.telegram-product-emojis.json';

export interface ProductEmoji {
  image: string;
  id: string;
}

export async function readProductEmojiMap(): Promise<ReadonlyMap<string, ProductEmoji>> {
  try {
    const entries: [string, ProductEmoji][] = JSON.parse(await readFile(productEmojiMapPath, 'utf8'));
    return new Map(entries);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    return new Map();
  }
}
