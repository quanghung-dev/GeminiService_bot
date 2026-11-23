import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AdminOrdersController } from './admin-orders.controller.js';
import { AdminController } from './admin.controller.js';
import { AdminGuard } from './admin.guard.js';

@Module({
  imports: [PrismaModule, OrdersModule],
  controllers: [AdminController, AdminOrdersController],
  providers: [AdminGuard],
})
export class AdminModule {}
