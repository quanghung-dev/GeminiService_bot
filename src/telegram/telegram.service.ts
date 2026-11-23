import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { Markup, Telegraf, TelegramError } from 'telegraf';
import { TelegramOutboxService } from '../notifications/telegram-outbox.service.js';
import type { TelegramSendResult } from '../notifications/telegram-sender.interface.js';
import { OrdersService } from '../orders/orders.service.js';
import { VietqrApiClient } from '../payments/vietqr/vietqr-api.client.js';
import { ProductsService } from '../products/products.service.js';
import { UsersService } from '../users/users.service.js';
import {
  type CatalogDependencies,
  handlePendingEmailText,
  type PendingEmailCheckout,
  registerCatalog,
  showCatalogText,
} from './telegram-catalog.js';
import { languages, menuRows } from './telegram-menu.js';

@Injectable()
export class TelegramService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private readonly pendingEmailCheckouts = new Map<number, PendingEmailCheckout>();
  private bot?: Telegraf;

  constructor(
    private readonly productsService: ProductsService,
    private readonly usersService: UsersService,
    private readonly ordersService: OrdersService,
    private readonly vietqrApiClient: VietqrApiClient,
    private readonly outboxService: TelegramOutboxService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
    if (!token) return;

    const bot = new Telegraf(token);
    const catalogDeps: CatalogDependencies = {
      productsService: this.productsService,
      usersService: this.usersService,
      ordersService: this.ordersService,
      vietqrApiClient: this.vietqrApiClient,
      pendingEmailCheckouts: this.pendingEmailCheckouts,
    };

    const languagePrompt = '🌐 Chọn ngôn ngữ / Choose language:';
    const languageKeyboard = Markup.inlineKeyboard(
      languages.map(({ code, label }) => Markup.button.callback(label, `language:${code}`)),
      { columns: 2 },
    );

    bot.start(async (context) => {
      if (context.from) {
        this.pendingEmailCheckouts.delete(context.from.id);
        await this.usersService.upsertTelegramUser(context.from).catch(() => undefined);
      }
      await context.reply(languagePrompt, languageKeyboard);
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
      bot.action(new RegExp(`^menu:${code}:`), async (context) => {
        await context.answerCbQuery(unavailable);
      });
    }

    bot.on('text', async (context, next) => {
      const text = context.message.text;
      if (!text.startsWith('/')) {
        const handled = await handlePendingEmailText(context, catalogDeps, text);
        if (handled) return;
      }
      await next();
    });

    bot.catch((error) => {
      this.logger.error(this.describeError('Không xử lý được tin nhắn Telegram', error));
    });

    try {
      if ((await bot.telegram.getWebhookInfo()).url) {
        this.logger.error('Bot đang có webhook. Polling chưa được bật.');
        return;
      }
      bot.botInfo = await bot.telegram.getMe();
    } catch (error) {
      this.logger.error(this.describeError('Không kết nối được Telegram', error));
      return;
    }

    this.bot = bot;
    this.outboxService.registerSender({
      sendMessage: (chatId, text) => this.sendOutboxMessage(bot, chatId, text),
    });

    this.logger.log(`Đã xác thực @${bot.botInfo.username}. Đang bật long polling.`);
    void bot.launch({ allowedUpdates: ['message', 'callback_query'] }).catch((error) => {
      this.logger.error(this.describeError('Telegram polling đã dừng', error));
    });
  }

  onModuleDestroy(): void {
    this.outboxService.registerSender(null);
    this.pendingEmailCheckouts.clear();
    try {
      this.bot?.stop('NestJS shutdown');
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'Bot is not running!') throw error;
    }
  }

  private async sendOutboxMessage(
    bot: Telegraf,
    chatId: bigint,
    text: string,
  ): Promise<TelegramSendResult> {
    try {
      await bot.telegram.sendMessage(chatId.toString(), text);
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
    return error instanceof TelegramError ? `${message} (mã ${error.code})` : message;
  }
}
