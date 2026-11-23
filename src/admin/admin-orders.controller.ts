import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { OrderStatus, PaymentStatus } from '../generated/prisma/client.js';
import {
  parseCustomerOrderInput,
  parseDeliveryOrderData,
} from '../orders/handle-type.types.js';
import { OrdersService } from '../orders/orders.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AdminGuard } from './admin.guard.js';

interface CompleteOrderBody {
  targetEmail?: string;
  note?: string;
  deliveryData?: unknown;
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
  async listOrders(@Query('status') status?: unknown) {
    let parsedStatus: OrderStatus | undefined;
    if (status !== undefined) {
      if (typeof status !== 'string') {
        throw new BadRequestException('Invalid order status filter');
      }
      const trimmed = status.trim();
      if (trimmed.length > 0) {
        const upper = trimmed.toUpperCase();
        if (!VALID_ORDER_STATUSES.has(upper)) {
          throw new BadRequestException('Invalid order status filter');
        }
        parsedStatus = upper as OrderStatus;
      }
    }

    const orders = await this.ordersService.listAdminOrders(parsedStatus);
    return orders.map((order) => {
      const customerInput = parseCustomerOrderInput(order.fulfillment?.customerInput);
      const deliveryData = parseDeliveryOrderData(order.fulfillment?.deliveryData);
      return {
        id: order.id,
        orderCode: order.orderCode,
        status: order.status,
        handleType: order.handleType,
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
          handleType: order.plan.handleType,
        },
        fulfillmentSummary: {
          hasCustomerInput: Boolean(customerInput),
          hasDeliveryData: Boolean(deliveryData),
          accountIdentifier:
            customerInput?.usernameOrEmail ?? order.targetEmail ?? null,
        },
        subscription: order.subscription
          ? {
              id: order.subscription.id,
              status: order.subscription.status,
              targetEmail: order.subscription.targetEmail,
              accountIdentifier: order.subscription.accountIdentifier,
              activatedAt: order.subscription.activatedAt,
              expiresAt: order.subscription.expiresAt,
            }
          : null,
      };
    });
  }

  @Get('orders/:id')
  @Header('Cache-Control', 'no-store')
  async getOrderDetail(@Param('id', ParseUUIDPipe) id: string) {
    const order = await this.ordersService.getAdminOrderById(id);
    if (!order) {
      throw new NotFoundException('Order not found');
    }

    return {
      id: order.id,
      orderCode: order.orderCode,
      status: order.status,
      handleType: order.handleType,
      totalAmount: order.totalAmount.toString(),
      currency: order.currency,
      targetEmail: order.targetEmail,
      paymentProvider: order.paymentProvider,
      paymentContent: order.paymentContent,
      stockReserved: order.stockReserved,
      stockReleasedAt: order.stockReleasedAt,
      paidAt: order.paidAt,
      completedAt: order.completedAt,
      cancelledAt: order.cancelledAt,
      expiresAt: order.expiresAt,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      planSnapshot: order.planSnapshot,
      user: {
        id: order.user.id,
        telegramId: order.user.telegramId.toString(),
        username: order.user.username,
        firstName: order.user.firstName,
        lastName: order.user.lastName,
        languageCode: order.user.languageCode,
      },
      plan: {
        id: order.plan.id,
        code: order.plan.code,
        nameVi: order.plan.nameVi,
        nameEn: order.plan.nameEn,
        productName: order.plan.product.name,
        durationDays: order.plan.durationDays,
        warrantyDays: order.plan.warrantyDays,
        handleType: order.plan.handleType,
        handleConfig: order.plan.handleConfig,
      },
      fulfillment: order.fulfillment
        ? {
            id: order.fulfillment.id,
            handleType: order.fulfillment.handleType,
            customerInput: parseCustomerOrderInput(order.fulfillment.customerInput),
            deliveryData: parseDeliveryOrderData(order.fulfillment.deliveryData),
            createdAt: order.fulfillment.createdAt,
            updatedAt: order.fulfillment.updatedAt,
          }
        : null,
      subscription: order.subscription
        ? {
            id: order.subscription.id,
            status: order.subscription.status,
            targetEmail: order.subscription.targetEmail,
            accountIdentifier: order.subscription.accountIdentifier,
            activatedAt: order.subscription.activatedAt,
            expiresAt: order.subscription.expiresAt,
          }
        : null,
      payments: order.payments.map((payment) => ({
        id: payment.id,
        provider: payment.provider,
        providerTransactionId: payment.providerTransactionId,
        referenceCode: payment.referenceCode,
        amount: payment.amount.toString(),
        currency: payment.currency,
        status: payment.status,
        failureReason: payment.failureReason,
        transactionAt: payment.transactionAt,
        verifiedAt: payment.verifiedAt,
      })),
    };
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
    @Body() body?: unknown,
  ) {
    if (
      body !== undefined
      && (typeof body !== 'object' || body === null || Array.isArray(body))
    ) {
      throw new BadRequestException('Request body must be a JSON object');
    }

    const payload = (body ?? {}) as CompleteOrderBody;
    const { order, subscription, fulfillment, alreadyCompleted } =
      await this.ordersService.completeOrder(id, {
        targetEmail: payload.targetEmail,
        note: payload.note,
        deliveryData: payload.deliveryData,
      });

    return {
      id: order.id,
      orderCode: order.orderCode,
      status: order.status,
      handleType: order.handleType,
      completedAt: order.completedAt,
      alreadyCompleted,
      fulfillment: fulfillment
        ? {
            id: fulfillment.id,
            handleType: fulfillment.handleType,
            deliveryData: parseDeliveryOrderData(fulfillment.deliveryData),
          }
        : null,
      subscription: subscription
        ? {
            id: subscription.id,
            status: subscription.status,
            targetEmail: subscription.targetEmail,
            accountIdentifier: subscription.accountIdentifier,
            activatedAt: subscription.activatedAt,
            expiresAt: subscription.expiresAt,
          }
        : null,
    };
  }
}
