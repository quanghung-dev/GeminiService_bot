import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { sepayQrConfig } from '../config/sepay-qr.config.js';
import { vietqrConfig } from '../config/vietqr.config.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PaymentReconciliationService } from './payment-reconciliation.service.js';
import { SepayQrClient } from './sepay/sepay-qr.client.js';
import { VietqrApiClient } from './vietqr/vietqr-api.client.js';
import { VietqrBasicAuthGuard } from './vietqr/vietqr-basic-auth.guard.js';
import { VietqrBearerAuthGuard } from './vietqr/vietqr-bearer-auth.guard.js';
import { VietqrTokenService } from './vietqr/vietqr-token.service.js';
import { VietqrWebhookService } from './vietqr/vietqr-webhook.service.js';
import { VietqrController } from './vietqr/vietqr.controller.js';

@Module({
  imports: [
    ConfigModule.forFeature(sepayQrConfig),
    ConfigModule.forFeature(vietqrConfig),
    PrismaModule,
    NotificationsModule,
  ],
  controllers: [VietqrController],
  providers: [
    VietqrTokenService,
    VietqrBasicAuthGuard,
    VietqrBearerAuthGuard,
    VietqrApiClient,
    SepayQrClient,
    PaymentReconciliationService,
    VietqrWebhookService,
  ],
  exports: [VietqrTokenService, VietqrApiClient, SepayQrClient, PaymentReconciliationService],
})
export class PaymentsModule {}
