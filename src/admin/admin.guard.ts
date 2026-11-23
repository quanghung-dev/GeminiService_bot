import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PrismaService } from '../prisma/prisma.service.js';
import { verifyAdminPassword } from './admin-password.js';

const localAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<IncomingMessage>();
    const address = request.socket.remoteAddress;
    if (!address || !localAddresses.has(address)) throw new ForbiddenException();

    const basic = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(request.headers.authorization ?? '');
    if (basic) {
      const credentials = Buffer.from(basic[1], 'base64').toString('utf8');
      const separator = credentials.indexOf(':');
      if (separator > 0) {
        const username = credentials.slice(0, separator);
        const password = credentials.slice(separator + 1);
        const account = await this.prisma.adminAccount.findUnique({ where: { username } });
        if (account && await verifyAdminPassword(password, account.passwordHash)) return true;
      }
    }

    http.getResponse<ServerResponse>().setHeader('WWW-Authenticate', 'Basic realm="GeminiService admin"');
    throw new UnauthorizedException();
  }
}
