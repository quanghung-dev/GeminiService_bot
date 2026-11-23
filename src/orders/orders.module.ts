import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { OrderExpirationService } from './order-expiration.service.js';
import { OrdersService } from './orders.service.js';

@Module({
  imports: [PrismaModule, NotificationsModule],
  providers: [OrdersService, OrderExpirationService],
  exports: [OrdersService, OrderExpirationService],
})
export class OrdersModule {}
