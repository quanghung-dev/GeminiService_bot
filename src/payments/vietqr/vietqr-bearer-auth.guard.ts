import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { type VietqrConfig, vietqrConfig } from '../../config/vietqr.config.js';
import { VIETQR_CALLBACK_ERROR_REASONS } from './vietqr.constants.js';
import { VietqrTokenService } from './vietqr-token.service.js';
import type { VietqrJwtPayload, VietqrTransactionSyncResponse } from './vietqr.types.js';

export interface VietqrBearerAuthenticatedRequest extends IncomingMessage {
  vietqrJwt?: VietqrJwtPayload;
}

const BEARER_PREFIX = 'Bearer ';

@Injectable()
export class VietqrBearerAuthGuard implements CanActivate {
  private readonly logger = new Logger(VietqrBearerAuthGuard.name);

  constructor(
    @Inject(vietqrConfig.KEY)
    private readonly config: VietqrConfig,
    private readonly tokenService: VietqrTokenService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.config.enabled) {
      throw new ServiceUnavailableException({
        error: true,
        errorReason: VIETQR_CALLBACK_ERROR_REASONS.TRANSACTION_FAILED,
        toastMessage: 'VietQR service is disabled',
        object: null,
      } satisfies VietqrTransactionSyncResponse);
    }

    const request = context.switchToHttp().getRequest<VietqrBearerAuthenticatedRequest>();
    const authHeader = request.headers.authorization;

    if (typeof authHeader !== 'string' || !authHeader.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedException({
        error: true,
        errorReason: VIETQR_CALLBACK_ERROR_REASONS.INVALID_AUTH_HEADER,
        toastMessage: 'Authorization header is missing or invalid',
        object: null,
      } satisfies VietqrTransactionSyncResponse);
    }

    const token = authHeader.slice(BEARER_PREFIX.length).trim();
    if (!token) {
      throw new UnauthorizedException({
        error: true,
        errorReason: VIETQR_CALLBACK_ERROR_REASONS.INVALID_AUTH_HEADER,
        toastMessage: 'Authorization header is missing or invalid',
        object: null,
      } satisfies VietqrTransactionSyncResponse);
    }

    const payload = this.tokenService.verifyAccessToken(token);
    if (!payload) {
      this.logger.warn('Rejected VietQR transaction-sync request due to invalid or expired Bearer token');
      throw new UnauthorizedException({
        error: true,
        errorReason: VIETQR_CALLBACK_ERROR_REASONS.INVALID_TOKEN,
        toastMessage: 'Invalid or expired token',
        object: null,
      } satisfies VietqrTransactionSyncResponse);
    }

    request.vietqrJwt = payload;
    return true;
  }
}
