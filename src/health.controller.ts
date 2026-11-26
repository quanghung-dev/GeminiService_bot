import { Controller, Get, Header } from '@nestjs/common';

/**
 * Lightweight liveness endpoint for Render health checks and UptimeRobot pings
 * without querying the database.
 */
@Controller('health')
export class HealthController {
  @Get()
  @Header('Cache-Control', 'no-store')
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
