import {
  Body,
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  type VietqrAuthenticatedRequest,
  VietqrBasicAuthGuard,
} from './vietqr-basic-auth.guard.js';
import { VietqrBearerAuthGuard } from './vietqr-bearer-auth.guard.js';
import { VietqrTokenService } from './vietqr-token.service.js';
import { VietqrWebhookService } from './vietqr-webhook.service.js';
import type {
  VietqrTokenSuccessResponse,
  VietqrTransactionSyncResponse,
} from './vietqr.types.js';

@Controller('vqr')
export class VietqrController {
  constructor(
    private readonly tokenService: VietqrTokenService,
    private readonly webhookService: VietqrWebhookService,
  ) {}

  @Post('api/token_generate')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @UseGuards(VietqrBasicAuthGuard)
  generateToken(@Req() request: VietqrAuthenticatedRequest): VietqrTokenSuccessResponse {
    return this.tokenService.issueAccessToken(request.vietqrClientUsername ?? '');
  }

  /**
   * Default official VietQR inbound balance-fluctuation callback endpoint:
   * POST /vqr/bank/api/transaction-sync
   */
  @Post('bank/api/transaction-sync')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @UseGuards(VietqrBearerAuthGuard)
  transactionSync(@Body() body: unknown): Promise<VietqrTransactionSyncResponse> {
    return this.webhookService.handleTransactionSync(body);
  }
}
