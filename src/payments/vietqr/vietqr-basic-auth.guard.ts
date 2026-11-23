import {
  BadRequestException,
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type VietqrConfig, vietqrConfig } from '../../config/vietqr.config.js';
import type { VietqrTokenErrorResponse } from './vietqr.types.js';

export interface VietqrAuthenticatedRequest extends IncomingMessage {
  vietqrClientUsername?: string;
}

const BASIC_AUTH_PATTERN = /^Basic ([A-Za-z0-9+/]+={0,2})$/i;

function timingSafeStringEqual(actual: string, expected: string): boolean {
  const actualDigest = createHash('sha256').update(actual, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

@Injectable()
export class VietqrBasicAuthGuard implements CanActivate {
  private readonly logger = new Logger(VietqrBasicAuthGuard.name);

  constructor(
    @Inject(vietqrConfig.KEY)
    private readonly config: VietqrConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.config.enabled) {
      const body: VietqrTokenErrorResponse = {
        status: 'FAILED',
        message: 'VietQR service is disabled',
      };
      throw new ServiceUnavailableException(body);
    }

    const http = context.switchToHttp();
    const request = http.getRequest<VietqrAuthenticatedRequest>();
    const response = http.getResponse<ServerResponse>();
    const authHeader = request.headers.authorization;

    if (typeof authHeader !== 'string') {
      throw new BadRequestException({
        status: 'FAILED',
        message: 'Authorization header is missing or invalid',
      } satisfies VietqrTokenErrorResponse);
    }

    const match = BASIC_AUTH_PATTERN.exec(authHeader.trim());
    if (!match || match[1].length % 4 !== 0) {
      throw new BadRequestException({
        status: 'FAILED',
        message: 'Authorization header is missing or invalid',
      } satisfies VietqrTokenErrorResponse);
    }

    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');
    if (separatorIndex <= 0) {
      throw new BadRequestException({
        status: 'FAILED',
        message: 'Invalid Authorization header format',
      } satisfies VietqrTokenErrorResponse);
    }

    const username = decoded.slice(0, separatorIndex);
    const password = decoded.slice(separatorIndex + 1);

    const usernameMatches = timingSafeStringEqual(username, this.config.clientUsername);
    const passwordMatches = timingSafeStringEqual(password, this.config.clientPassword);

    if (!usernameMatches || !passwordMatches) {
      this.logger.warn('Rejected VietQR token_generate request due to invalid Basic credentials');
      response.setHeader('WWW-Authenticate', 'Basic realm="VietQR"');
      throw new UnauthorizedException({
        status: 'FAILED',
        message: 'Invalid credentials',
      } satisfies VietqrTokenErrorResponse);
    }

    request.vietqrClientUsername = this.config.clientUsername;
    return true;
  }
}
