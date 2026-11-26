import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import https from 'node:https';
import { Markup, Telegraf, TelegramError } from 'telegraf';
import { type SepayQrConfig, sepayQrConfig } from '../config/sepay-qr.config.js';
import { TelegramOutboxService } from '../notifications/telegram-outbox.service.js';
import type { TelegramSendResult } from '../notifications/telegram-sender.interface.js';
import { OrdersService } from '../orders/orders.service.js';
import { SepayQrClient } from '../payments/sepay/sepay-qr.client.js';
import { ProductsService } from '../products/products.service.js';
import { UsersService } from '../users/users.service.js';
import {
  type CatalogDependencies,
  handlePendingCheckoutText,
  type PendingCheckoutState,
  registerCatalog,
  showCatalogText,
} from './telegram-catalog.js';
import { buildSupportMessage, languages, menuRows } from './telegram-menu.js';
import { buildProfileMessage } from './telegram-profile.js';
import { registerWarranty } from './telegram-warranty.js';

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const TELEGRAM_CONNECT_RETRY_MS = 15_000;

export function truncateTelegramMessage(
  text: string,
  maxLength = TELEGRAM_MAX_MESSAGE_LENGTH,
): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 3) return text.slice(0, Math.max(0, maxLength));
  return `${text.slice(0, maxLength - 3)}...`;
}

export function formatTelegramErrorMessage(message: string, error: unknown): string {
  if (error instanceof TelegramError) {
    return `${message} (mã ${error.code}: ${error.description})`;
  }
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    const nested =
      error instanceof AggregateError && error.errors.length > 0
        ? error.errors
            .map((entry) =>
              entry instanceof Error
                ? `${(entry as NodeJS.ErrnoException).code ?? entry.name}: ${entry.message}`
                : String(entry),
            )
            .join('; ')
        : '';
    const safeMsg = error.message.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<redacted>');
    const detail = [code, safeMsg, nested].filter(Boolean).join(' - ');
    return detail ? `${message} (${detail})` : message;
  }
  return message;
}

@Injectable()
export class TelegramService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private readonly pendingCheckoutInputs = new Map<number, PendingCheckoutState>();
  private readonly inFlightCheckouts = new Set<number>();
  private bot?: Telegraf;
  private telegramAgent?: https.Agent;
  private retryTimer: NodeJS.Timeout | null = null;
  private destroyed = false;

  constructor(
    @Inject(sepayQrConfig.KEY)
    private readonly sepayConfig: SepayQrConfig,
    private readonly productsService: ProductsService,
    private readonly usersService: UsersService,
    private readonly ordersService: OrdersService,
    private readonly sepayQrClient: SepayQrClient,
    private readonly outboxService: TelegramOutboxService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
    if (!token) return;

    this.destroyed = false;
    this.telegramAgent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 10_000,
      family: 4,
    });
    const bot = new Telegraf(token, {
      telegram: { agent: this.telegramAgent },
    });
    const catalogDeps: CatalogDependencies = {
      productsService: this.productsService,
      usersService: this.usersService,
      ordersService: this.ordersService,
      sepayQrClient: this.sepayQrClient,
      orderExpiresMinutes: this.sepayConfig.orderExpiresMinutes,
      pendingCheckoutInputs: this.pendingCheckoutInputs,
      inFlightCheckouts: this.inFlightCheckouts,
    };

    const languagePrompt = '🌐 Chọn ngôn ngữ / Choose language:';
    const languageKeyboard = Markup.inlineKeyboard(
      languages.map(({ code, label }) => Markup.button.callback(label, `language:${code}`)),
      { columns: 2 },
    );

    bot.start(async (context) => {
      if (context.from) {
        this.pendingCheckoutInputs.delete(context.from.id);
        await this.usersService.upsertTelegramUser(context.from).catch(() => undefined);
      }
      await context.reply(languagePrompt, languageKeyboard);
    });

    bot.action(/^(?:language|menu):(?:vi|en)(?::|$)/, async (context, next) => {
      if (context.from) {
        this.pendingCheckoutInputs.delete(context.from.id);
      }
      await next();
    });

    for (const { code, welcome, guide, prompt, unavailable } of languages) {
      const menuKeyboard = Markup.inlineKeyboard(
        menuRows.map((row) =>
          row.map((item) => Markup.button.callback(item[code], `menu:${code}:${item.id}`)),
        ),
      );
      const mainMenuText = `${guide}\n\n${prompt}`;

      registerCatalog(bot, code, catalogDeps, async (context) => {
        await showCatalogText(context, mainMenuText, menuKeyboard);
      });
      registerWarranty(bot, code, unavailable, async (context) => {
        await showCatalogText(context, mainMenuText, menuKeyboard);
      });

      bot.action(`language:${code}`, async (context) => {
        const { first_name, last_name } = context.from;
        await this.usersService.upsertTelegramUser(context.from, code).catch(() => undefined);
        const displayName = [first_name, last_name].filter(Boolean).join(' ');
        await context.answerCbQuery();
        await context.reply(welcome(displayName));
        await context.reply(mainMenuText, menuKeyboard);
      });
      bot.action(`menu:${code}:language`, async (context) => {
        await context.answerCbQuery();
        await context.reply(languagePrompt, languageKeyboard);
      });
      bot.action(`menu:${code}:guide`, async (context) => {
        await context.answerCbQuery();
        await context.reply(guide);
      });
      bot.action(`menu:${code}:profile`, async (context) => {
        if (context.chat?.type !== 'private') {
          await context.answerCbQuery(
            code === 'vi' ? 'Vui lòng mở Hồ sơ trong chat riêng với bot.' : 'Open Profile in a private chat with the bot.',
          );
          return;
        }

        await context.answerCbQuery();
        const user = await this.usersService.upsertTelegramUser(context.from);
        await context.reply(buildProfileMessage(user, code));
      });
      bot.action(`menu:${code}:support`, async (context) => {
        await context.answerCbQuery();
        await context.reply(buildSupportMessage(code), { parse_mode: 'HTML' });
      });
      bot.action(new RegExp(`^menu:${code}:`), async (context) => {
        await context.answerCbQuery(unavailable);
      });
    }

    bot.on('text', async (context, next) => {
      const text = context.message.text;
      if (!text.startsWith('/')) {
        const handled = await handlePendingCheckoutText(context, catalogDeps, text);
        if (handled) return;
      }
      await next();
    });

    bot.catch((error) => {
      this.logger.error(this.describeError('Không xử lý được tin nhắn Telegram', error));
    });

    this.bot = bot;
    await this.connectAndLaunch(bot);
  }

  private async connectAndLaunch(bot: Telegraf): Promise<void> {
    if (this.destroyed) return;
    try {
      if ((await bot.telegram.getWebhookInfo()).url) {
        this.logger.error('Bot đang có webhook. Polling chưa được bật.');
        return;
      }
      bot.botInfo = await bot.telegram.getMe();
    } catch (error) {
      this.logger.error(this.describeError('Không kết nối được Telegram', error));
      const isPermanentConfigError =
        error instanceof TelegramError && (error.code === 401 || error.code === 404);
      if (!isPermanentConfigError && !this.destroyed) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          void this.connectAndLaunch(bot);
        }, TELEGRAM_CONNECT_RETRY_MS);
        this.retryTimer.unref();
      }
      return;
    }

    if (this.destroyed) return;
    this.outboxService.registerSender({
      sendMessage: (chatId, text) => this.sendOutboxMessage(bot, chatId, text),
    });

    this.logger.log(`Đã xác thực @${bot.botInfo.username}. Đang bật long polling.`);
    void bot.launch({ allowedUpdates: ['message', 'callback_query'] }).catch((error) => {
      this.logger.error(this.describeError('Telegram polling đã dừng', error));
    });
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.outboxService.registerSender(null);
    this.pendingCheckoutInputs.clear();
    this.inFlightCheckouts.clear();
    try {
      this.bot?.stop('NestJS shutdown');
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'Bot is not running!') throw error;
    } finally {
      this.telegramAgent?.destroy();
      this.telegramAgent = undefined;
    }
  }

  private async sendOutboxMessage(
    bot: Telegraf,
    chatId: bigint,
    text: string,
  ): Promise<TelegramSendResult> {
    try {
      await bot.telegram.sendMessage(chatId.toString(), truncateTelegramMessage(text));
      return { ok: true };
    } catch (error: unknown) {
      if (error instanceof TelegramError) {
        const retryAfter = error.parameters?.retry_after;
        if (error.code === 429) {
          return {
            ok: false,
            errorMessage: `Telegram rate limit (429): ${error.description}`,
            retryAfterSeconds: typeof retryAfter === 'number' ? retryAfter : 30,
          };
        }
        const isPermanent =
          error.code === 403
          || (error.code === 400
            && /chat not found|user is deactivated|bot was blocked/i.test(error.description));
        return {
          ok: false,
          errorMessage: `Telegram error (${error.code}): ${error.description}`,
          permanent: isPermanent,
        };
      }
      return {
        ok: false,
        errorMessage: error instanceof Error ? error.message : 'Unknown Telegram send failure',
      };
    }
  }

  private describeError(message: string, error: unknown): string {
    return formatTelegramErrorMessage(message, error);
  }
}
