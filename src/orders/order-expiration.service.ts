import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { OrdersService } from './orders.service.js';

const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

@Injectable()
export class OrderExpirationService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OrderExpirationService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly ordersService: OrdersService) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return;
    // Immediately recover any orders that expired while the server was offline.
    void this.runSweep();
    this.timer = setInterval(() => {
      void this.runSweep();
    }, DEFAULT_SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runSweep(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let totalExpired = 0;

    try {
      while (true) {
        const expiredCount = await this.ordersService.expireDueOrders(50);
        totalExpired += expiredCount;
        if (expiredCount < 50) break;
      }
      if (totalExpired > 0) {
        this.logger.log(`Expired ${totalExpired} pending order(s) and released reserved stock.`);
      }
      return totalExpired;
    } catch (error: unknown) {
      this.logger.error(
        `Order expiration sweep failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return totalExpired;
    } finally {
      this.running = false;
    }
  }
}
