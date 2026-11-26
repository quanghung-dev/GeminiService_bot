import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AdminModule } from './admin/admin.module.js';
import { sepayQrConfig } from './config/sepay-qr.config.js';
import { vietqrConfig } from './config/vietqr.config.js';
import { HealthController } from './health.controller.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ProductsModule } from './products/products.module.js';
import { TelegramModule } from './telegram/telegram.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [sepayQrConfig, vietqrConfig],
    }),
    PrismaModule,
    NotificationsModule,
    UsersModule,
    OrdersModule,
    TelegramModule,
    AdminModule,
    ProductsModule,
    PaymentsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
