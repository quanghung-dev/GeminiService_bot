import { Injectable } from '@nestjs/common';
import { LanguageCode, type User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface TelegramProfileInput {
  id: number;
  username?: string;
  first_name: string;
  last_name?: string;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async upsertTelegramUser(
    profile: TelegramProfileInput,
    languageCode?: 'vi' | 'en',
  ): Promise<User> {
    const telegramId = BigInt(profile.id);
    const now = new Date();
    const mappedLanguage =
      languageCode === 'vi'
        ? LanguageCode.vi
        : languageCode === 'en'
          ? LanguageCode.en
          : undefined;

    return this.prisma.user.upsert({
      where: { telegramId },
      create: {
        telegramId,
        username: profile.username ?? null,
        firstName: profile.first_name,
        lastName: profile.last_name ?? null,
        languageCode: mappedLanguage ?? null,
        createdAt: now,
        updatedAt: now,
      },
      update: {
        username: profile.username ?? null,
        firstName: profile.first_name,
        lastName: profile.last_name ?? null,
        ...(mappedLanguage ? { languageCode: mappedLanguage } : {}),
        updatedAt: now,
      },
    });
  }
}
