import { bold, fmt } from 'telegraf/format';
import type { User } from '../generated/prisma/client.js';

const labels = {
  vi: {
    title: '👨‍💼 Hồ sơ',
    name: 'Tên:',
    language: 'Ngôn ngữ:',
    balance: 'Số dư ví:',
  },
  en: {
    title: '👨‍💼 Profile',
    name: 'Name:',
    language: 'Language:',
    balance: 'Wallet balance:',
  },
} as const;

const languageNames = { vi: 'Tiếng Việt', en: 'English' } as const;

export function buildProfileMessage(user: User, menuLanguage: 'vi' | 'en') {
  const copy = labels[menuLanguage];
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ');
  const username = user.username ? `@${user.username}` : '-';
  const language = languageNames[user.languageCode ?? menuLanguage];
  const vnd = user.walletVnd.toLocaleString(menuLanguage === 'vi' ? 'vi-VN' : 'en-US');
  const usdt = user.walletUsdt.toFixed();

  return fmt`${copy.title}

${bold(copy.name)} ${name}
${bold('Username:')} ${username}
${bold('ID:')} ${user.telegramId.toString()}
${bold(copy.language)} ${language}

${copy.balance}
${bold('- VND:')} ${vnd} VND
${bold('- USDT:')} ${usdt} USDT`;
}
