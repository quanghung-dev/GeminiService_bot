import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { OrderStatus, PaymentStatus } from '../generated/prisma/client.js';
import { OrdersService } from '../orders/orders.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AdminGuard } from './admin.guard.js';

interface CompleteOrderBody {
  targetEmail?: string;
  note?: string;
}

const VALID_ORDER_STATUSES = new Set<string>(Object.values(OrderStatus));

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminOrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('orders')
  @Header('Cache-Control', 'no-store')
  async listOrders(@Query('status') status?: string) {
    let parsedStatus: OrderStatus | undefined;
    if (status) {
      const upper = status.trim().toUpperCase();
      if (!VALID_ORDER_STATUSES.has(upper)) {
        throw new BadRequestException('Invalid order status filter');
      }
      parsedStatus = upper as OrderStatus;
    }

    const orders = await this.ordersService.listAdminOrders(parsedStatus);
    return orders.map((order) => ({
      id: order.id,
      orderCode: order.orderCode,
      status: order.status,
      totalAmount: order.totalAmount.toString(),
      currency: order.currency,
      targetEmail: order.targetEmail,
      paymentProvider: order.paymentProvider,
      stockReserved: order.stockReserved,
      stockReleasedAt: order.stockReleasedAt,
      paidAt: order.paidAt,
      completedAt: order.completedAt,
      expiresAt: order.expiresAt,
      createdAt: order.createdAt,
      user: {
        id: order.user.id,
        telegramId: order.user.telegramId.toString(),
        username: order.user.username,
        firstName: order.user.firstName,
      },
      plan: {
        id: order.plan.id,
        code: order.plan.code,
        nameVi: order.plan.nameVi,
        productName: order.plan.product.name,
        durationDays: order.plan.durationDays,
      },
      subscription: order.subscription
        ? {
            id: order.subscription.id,
            status: order.subscription.status,
            targetEmail: order.subscription.targetEmail,
            activatedAt: order.subscription.activatedAt,
            expiresAt: order.subscription.expiresAt,
          }
        : null,
    }));
  }

  @Get('payments/exceptions')
  @Header('Cache-Control', 'no-store')
  async listPaymentExceptions() {
    const payments = await this.prisma.payment.findMany({
      where: {
        status: { in: [PaymentStatus.UNMATCHED, PaymentStatus.REJECTED] },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { order: true },
    });

    return payments.map((payment) => ({
      id: payment.id,
      provider: payment.provider,
      providerTransactionId: payment.providerTransactionId,
      referenceCode: payment.referenceCode,
      orderId: payment.orderId,
      orderCode: payment.order?.orderCode ?? null,
      amount: payment.amount.toString(),
      currency: payment.currency,
      bankAccount: payment.bankAccount,
      transType: payment.transType,
      content: payment.content,
      status: payment.status,
      failureReason: payment.failureReason,
      transactionAt: payment.transactionAt,
      receivedAt: payment.receivedAt,
      createdAt: payment.createdAt,
    }));
  }

  @Post('orders/:id/processing')
  @Header('Cache-Control', 'no-store')
  async markProcessing(@Param('id', ParseUUIDPipe) id: string) {
    const order = await this.ordersService.startProcessingOrder(id);
    return {
      id: order.id,
      orderCode: order.orderCode,
      status: order.status,
      updatedAt: order.updatedAt,
    };
  }

  @Post('orders/:id/complete')
  @Header('Cache-Control', 'no-store')
  async completeOrder(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body?: CompleteOrderBody,
  ) {
    const { order, subscription, alreadyCompleted } = await this.ordersService.completeOrder(id, {
      targetEmail: body?.targetEmail,
      note: body?.note,
    });

    return {
      id: order.id,
      orderCode: order.orderCode,
      status: order.status,
      completedAt: order.completedAt,
      alreadyCompleted,
      subscription: subscription
        ? {
            id: subscription.id,
            status: subscription.status,
            targetEmail: subscription.targetEmail,
            activatedAt: subscription.activatedAt,
            expiresAt: subscription.expiresAt,
          }
        : null,
    };
  }
}
