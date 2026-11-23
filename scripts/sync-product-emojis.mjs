import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import { Telegram, TelegramError } from 'telegraf';
import { PrismaService } from '../dist/prisma/prisma.service.js';
import { ProductsService } from '../dist/products/products.service.js';
import { prepareProductEmoji } from '../dist/telegram/catalog-image.js';
import { productEmojiMapPath, readProductEmojiMap } from '../dist/telegram/product-emoji-map.js';

const ownerValue = process.env.TELEGRAM_EMOJI_OWNER_ID?.trim();
const ownerId = Number(ownerValue);
const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!ownerValue || !/^\d+$/.test(ownerValue) || !Number.isSafeInteger(ownerId) || ownerId < 1 || !token) {
  console.error('Set TELEGRAM_EMOJI_OWNER_ID and TELEGRAM_BOT_TOKEN before syncing.');
  process.exit(1);
}

const telegram = new Telegram(token);
const prisma = new PrismaService();
try {
  const products = await new ProductsService(prisma).listActiveProducts();
  const previous = await readProductEmojiMap();
  const entries = new Map();
  const pending = [];
  for (const product of products) {
    if (!product.image) continue;
    const existing = previous.get(product.id);
    if (existing?.image === product.image) entries.set(product.id, existing);
    else pending.push(product);
  }

  if (pending.length) {
    const bot = await telegram.getMe();
    for (let start = 0; start < pending.length; start += 50) {
      const batch = [];
      for (const product of pending.slice(start, start + 50)) {
        const source = await prepareProductEmoji(product.image);
        if (!source) {
          console.error(`Unable to read product image for ${product.slug}.`);
          continue;
        }
        const upload = await telegram.uploadStickerFile(ownerId, { source, filename: 'logo.png' }, 'static');
        batch.push({ product, sticker: upload.file_id });
      }
      if (!batch.length) continue;

      const name = `products_${randomBytes(6).toString('hex')}_by_${bot.username.toLowerCase()}`;
      await telegram.createNewStickerSet(ownerId, name, 'GeminiService Product Logos', {
        sticker_type: 'custom_emoji',
        stickers: batch.map(({ sticker }) => ({ sticker, format: 'static', emoji_list: ['🏷️'] })),
      });
      const pack = await telegram.getStickerSet(name);
      if (pack.stickers.length !== batch.length || pack.stickers.some(sticker => !sticker.custom_emoji_id)) {
        throw new Error('Telegram returned an incomplete custom emoji pack.');
      }
      batch.forEach(({ product }, index) => {
        entries.set(product.id, { image: product.image, id: pack.stickers[index].custom_emoji_id });
      });
    }
  }

  const tempPath = `${productEmojiMapPath}.${process.pid}.tmp`;
  await writeFile(tempPath, JSON.stringify([...entries], null, 2) + '\n');
  await rename(tempPath, productEmojiMapPath);
  console.log(`Synced ${entries.size} of ${products.length} product logos.`);
} catch (error) {
  const detail = error instanceof TelegramError ? error.description : error.code ?? error.name;
  console.error('Product emoji sync failed.', detail);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
