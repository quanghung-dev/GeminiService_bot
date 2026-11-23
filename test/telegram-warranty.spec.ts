import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Context, Telegraf } from 'telegraf';
import {
  buildWarrantyStepOneMessage,
  registerWarranty,
} from '../src/telegram/telegram-warranty.js';

describe('Telegram Warranty UI (Step 1/3)', () => {
  it('builds Vietnamese warranty screen matching expected copy and 3 vertical buttons', () => {
    const { text, extra } = buildWarrantyStepOneMessage('vi');

    assert.equal(extra.parse_mode, 'HTML');
    assert.ok(text.includes('🛡️ Bảo hành'));
    assert.ok(text.includes('<b>Bước 1/3: Nhập mã đơn cần bảo hành</b>'));
    assert.ok(text.includes('<code>ORDER-1</code>, <code>ORDER-2</code>'));
    assert.ok(text.includes('• Còn đơn khác: bấm ➕ <b>Thêm đơn khác</b>.'));
    assert.ok(text.includes('• Không còn đơn: vui lòng bấm ✅ <b>Tiếp tục</b>.'));
    assert.ok(text.includes('⚠️ Chỉ nhập mã đơn xong chưa phải là gửi ticket. Ticket chỉ được gửi ở bước cuối.'));

    const keyboard = extra.reply_markup.inline_keyboard;
    assert.equal(keyboard.length, 3);
    assert.equal(keyboard[0]?.[0]?.text, '➕ Thêm đơn khác');
    assert.equal((keyboard[0]?.[0] as { callback_data?: string }).callback_data, 'warranty:vi:add');
    assert.equal(keyboard[1]?.[0]?.text, '✅ Tiếp tục');
    assert.equal((keyboard[1]?.[0] as { callback_data?: string }).callback_data, 'warranty:vi:continue');
    assert.equal(keyboard[2]?.[0]?.text, '❌ Hủy');
    assert.equal((keyboard[2]?.[0] as { callback_data?: string }).callback_data, 'warranty:vi:cancel');
  });

  it('builds English warranty screen and wires warranty & cancel actions', async () => {
    const handlers = new Map<string, (ctx: Context) => Promise<unknown>>();
    const fakeBot = {
      action(trigger: string, handler: (ctx: Context) => Promise<unknown>) {
        handlers.set(trigger, handler);
      },
    } as unknown as Telegraf;

    let renderedMainMenu = false;
    registerWarranty(fakeBot, 'en', 'Not available yet.', async () => {
      renderedMainMenu = true;
    });

    assert.equal(handlers.has('menu:en:warranty'), true);
    assert.equal(handlers.has('warranty:en:add'), true);
    assert.equal(handlers.has('warranty:en:continue'), true);
    assert.equal(handlers.has('warranty:en:cancel'), true);

    const editedMessages: Array<{ text: string; extra: unknown }> = [];
    const cbAnswers: Array<string | undefined> = [];
    const fakeCtx = {
      callbackQuery: { message: { message_id: 1, text: 'menu' } },
      answerCbQuery: async (msg?: string) => {
        cbAnswers.push(msg);
      },
      editMessageText: async (text: string, extra: unknown) => {
        editedMessages.push({ text, extra });
      },
    } as unknown as Context;

    await handlers.get('menu:en:warranty')!(fakeCtx);
    assert.equal(editedMessages.length, 1);
    assert.ok(editedMessages[0]?.text.includes('<b>Step 1/3: Enter order code(s) for warranty</b>'));

    await handlers.get('warranty:en:add')!(fakeCtx);
    assert.equal(cbAnswers[1], 'Not available yet.');

    await handlers.get('warranty:en:cancel')!(fakeCtx);
    assert.equal(renderedMainMenu, true);
  });
});
