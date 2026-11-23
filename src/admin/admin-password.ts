import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const deriveKey = promisify(scrypt);
const keyLength = 64;

export async function hashAdminPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = await deriveKey(password, salt, keyLength) as Buffer;
  return `${salt}:${key.toString('hex')}`;
}

export async function verifyAdminPassword(password: string, passwordHash: string): Promise<boolean> {
  const [salt, hash] = passwordHash.split(':');
  if (!/^[0-9a-f]{32}$/.test(salt) || !/^[0-9a-f]{128}$/.test(hash)) return false;

  const key = await deriveKey(password, salt, keyLength) as Buffer;
  return timingSafeEqual(key, Buffer.from(hash, 'hex'));
}
