import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { ProductsModule } from '../products/products.module.js';
import { UsersModule } from '../users/users.module.js';
import { TelegramService } from './telegram.service.js';

@Module({
  imports: [ProductsModule, UsersModule, OrdersModule, PaymentsModule, NotificationsModule],
  providers: [TelegramService],
})
export class TelegramModule {}
