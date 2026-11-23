import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { TelegramOutboxService } from './telegram-outbox.service.js';

@Module({
  imports: [PrismaModule],
  providers: [TelegramOutboxService],
  exports: [TelegramOutboxService],
})
export class NotificationsModule {}
