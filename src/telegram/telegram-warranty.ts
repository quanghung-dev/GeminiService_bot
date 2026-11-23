import { Markup, type Context, type Telegraf } from 'telegraf';
import { showCatalogText } from './telegram-catalog.js';

const warrantyCopy = {
  vi: {
    text: [
      '🛡️ Bảo hành',
      '',
      '<b>Bước 1/3: Nhập mã đơn cần bảo hành</b>',
      '',
      'Nhập mã đơn đã mua và đang gặp lỗi. Nếu có nhiều mã, ngăn cách bằng dấu phẩy (ví dụ: <code>ORDER-1</code>, <code>ORDER-2</code>).',
      '',
      'Sau mỗi lần nhập, bot sẽ kiểm tra và thêm đơn vào danh sách:',
      '• Còn đơn khác: bấm ➕ <b>Thêm đơn khác</b>.',
      '• Không còn đơn: vui lòng bấm ✅ <b>Tiếp tục</b>.',
      '',
      '⚠️ Chỉ nhập mã đơn xong chưa phải là gửi ticket. Ticket chỉ được gửi ở bước cuối.',
    ].join('\n'),
    addAnother: '➕ Thêm đơn khác',
    continue: '✅ Tiếp tục',
    cancel: '❌ Hủy',
  },
  en: {
    text: [
      '🛡️ Warranty',
      '',
      '<b>Step 1/3: Enter order code(s) for warranty</b>',
      '',
      'Enter the purchased order code(s) experiencing issues. For multiple codes, separate them with commas (e.g. <code>ORDER-1</code>, <code>ORDER-2</code>).',
      '',
      'After each entry, the bot will verify and add the order(s) to the list:',
      '• More orders: tap ➕ <b>Add another order</b>.',
      '• No more orders: please tap ✅ <b>Continue</b>.',
      '',
      '⚠️ Entering order codes does not submit the ticket yet. Your ticket is only submitted at the final step.',
    ].join('\n'),
    addAnother: '➕ Add another order',
    continue: '✅ Continue',
    cancel: '❌ Cancel',
  },
} as const;

export function buildWarrantyStepOneMessage(code: 'vi' | 'en') {
  const labels = warrantyCopy[code];
  return {
    text: labels.text,
    extra: {
      parse_mode: 'HTML' as const,
      ...Markup.inlineKeyboard([
        [Markup.button.callback(labels.addAnother, `warranty:${code}:add`)],
        [Markup.button.callback(labels.continue, `warranty:${code}:continue`)],
        [Markup.button.callback(labels.cancel, `warranty:${code}:cancel`)],
      ]),
    },
  };
}

/**
 * Registers the Warranty entry screen (UI only for Step 1/3; ticket submission
 * logic is intentionally deferred).
 */
export function registerWarranty(
  bot: Telegraf,
  code: 'vi' | 'en',
  unavailableText: string,
  renderMainMenu: (context: Context) => Promise<void>,
): void {
  bot.action(`menu:${code}:warranty`, async (context) => {
    await context.answerCbQuery();
    const { text, extra } = buildWarrantyStepOneMessage(code);
    await showCatalogText(context, text, extra);
  });

  bot.action(`warranty:${code}:add`, async (context) => {
    await context.answerCbQuery(unavailableText);
  });

  bot.action(`warranty:${code}:continue`, async (context) => {
    await context.answerCbQuery(unavailableText);
  });

  bot.action(`warranty:${code}:cancel`, async (context) => {
    await context.answerCbQuery();
    await renderMainMenu(context);
  });
}
