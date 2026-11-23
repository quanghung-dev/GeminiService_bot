import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { vietqrConfig } from '../config/vietqr.config.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PaymentReconciliationService } from './payment-reconciliation.service.js';
import { VietqrApiClient } from './vietqr/vietqr-api.client.js';
import { VietqrBasicAuthGuard } from './vietqr/vietqr-basic-auth.guard.js';
import { VietqrBearerAuthGuard } from './vietqr/vietqr-bearer-auth.guard.js';
import { VietqrTokenService } from './vietqr/vietqr-token.service.js';
import { VietqrWebhookService } from './vietqr/vietqr-webhook.service.js';
import { VietqrController } from './vietqr/vietqr.controller.js';

@Module({
  imports: [ConfigModule.forFeature(vietqrConfig), PrismaModule, NotificationsModule],
  controllers: [VietqrController],
  providers: [
    VietqrTokenService,
    VietqrBasicAuthGuard,
    VietqrBearerAuthGuard,
    VietqrApiClient,
    PaymentReconciliationService,
    VietqrWebhookService,
  ],
  exports: [VietqrTokenService, VietqrApiClient, PaymentReconciliationService],
})
export class PaymentsModule {}
