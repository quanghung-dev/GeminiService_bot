import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildSupportMessage } from '../src/telegram/telegram-menu.js';
import { truncateTelegramMessage } from '../src/telegram/telegram.service.js';

describe('Support Menu & Telegram Message Truncation', () => {
  it('omits unconfigured contact lines and HTML-escapes configured contacts', () => {
    const unconfiguredVi = buildSupportMessage('vi', {});
    assert.equal(unconfiguredVi.includes('Telegram:'), false);
    assert.equal(unconfiguredVi.includes('Zalo:'), false);
    assert.equal(unconfiguredVi.includes('= '), false);
    assert.ok(unconfiguredVi.includes('8:00 - 23:00'));

    const configuredEn = buildSupportMessage('en', {
      SUPPORT_TELEGRAM: '@shop_<support>&1',
      SUPPORT_ZALO: '0901234567',
    });
    assert.ok(configuredEn.includes('✉️ <b>Telegram:</b> @shop_&lt;support&gt;&amp;1'));
    assert.ok(configuredEn.includes('📞 <b>Zalo:</b> 0901234567'));
  });

  it('truncates long outbox messages safely within Telegram 4096-char limit', () => {
    const exact = 'a'.repeat(4096);
    assert.equal(truncateTelegramMessage(exact), exact);

    const over = 'b'.repeat(4500);
    const truncated = truncateTelegramMessage(over);
    assert.equal(truncated.length, 4096);
    assert.ok(truncated.endsWith('...'));
  });
});
