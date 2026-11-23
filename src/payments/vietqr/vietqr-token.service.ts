import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { type VietqrConfig, vietqrConfig } from '../../config/vietqr.config.js';
import {
  VIETQR_JWT_ALGORITHM,
  VIETQR_JWT_AUDIENCE,
  VIETQR_JWT_ISSUER,
  VIETQR_TOKEN_TYPE,
} from './vietqr.constants.js';
import type { VietqrJwtPayload, VietqrTokenSuccessResponse } from './vietqr.types.js';

@Injectable()
export class VietqrTokenService {
  constructor(
    @Inject(vietqrConfig.KEY)
    private readonly config: VietqrConfig,
  ) {}

  issueAccessToken(username: string): VietqrTokenSuccessResponse {
    if (!this.config.enabled || !this.config.tokenSecret) {
      throw new ServiceUnavailableException({
        status: 'FAILED',
        message: 'VietQR service is not enabled',
      });
    }

    const token = jwt.sign(
      {
        username,
        env: this.config.env,
      },
      this.config.tokenSecret,
      {
        algorithm: VIETQR_JWT_ALGORITHM,
        expiresIn: this.config.tokenExpiresIn,
        issuer: VIETQR_JWT_ISSUER,
        audience: VIETQR_JWT_AUDIENCE,
        subject: username,
        jwtid: randomUUID(),
      },
    );

    return {
      access_token: token,
      token_type: VIETQR_TOKEN_TYPE,
      expires_in: this.config.tokenExpiresIn,
    };
  }

  verifyAccessToken(token: string): VietqrJwtPayload | null {
    if (!this.config.enabled || !this.config.tokenSecret || !token) {
      return null;
    }

    try {
      const decoded = jwt.verify(token, this.config.tokenSecret, {
        algorithms: [VIETQR_JWT_ALGORITHM],
        issuer: VIETQR_JWT_ISSUER,
        audience: VIETQR_JWT_AUDIENCE,
        clockTolerance: 0,
      });

      if (!decoded || typeof decoded !== 'object') {
        return null;
      }

      const payload = decoded as Partial<VietqrJwtPayload>;
      if (
        typeof payload.username !== 'string'
        || typeof payload.sub !== 'string'
        || typeof payload.jti !== 'string'
        || payload.username !== this.config.clientUsername
        || payload.sub !== this.config.clientUsername
        || payload.env !== this.config.env
      ) {
        return null;
      }

      return payload as VietqrJwtPayload;
    } catch {
      return null;
    }
  }
}
