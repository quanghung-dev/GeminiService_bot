import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Context, Telegraf } from 'telegraf';
import { PlanHandleType } from '../src/generated/prisma/client.js';
import type { CatalogProductDetails } from '../src/products/products.service.js';
import {
  buildCatalogMenuMessage,
  buildPlanConfirmationMessage,
  buildProductDetailMessage,
  registerCatalog,
  type CatalogDependencies,
  type PendingCheckoutState,
} from '../src/telegram/telegram-catalog.js';

function makeProduct(overrides: Partial<CatalogProductDetails> = {}): CatalogProductDetails {
  return {
    id: 'b0917e50-2589-4e7d-b75f-216402cc422f',
    name: 'GPT',
    slug: 'gpt',
    image: null,
    descriptionVi: null,
    descriptionEn: null,
    plans: [
      {
        id: 'ca0946e6-bc8f-421c-883e-0568469ad36c',
        code: 'GPT_SLOT_TEAM_1M_BHF',
        nameVi: 'SLOT GPT TEAM 1M BHF',
        nameEn: 'Slot GPT Team 1M Full Warranty',
        price: '280000',
        currency: 'VND',
        durationDays: 30,
        warrantyDays: 30,
        stockQuantity: 10,
        handleType: PlanHandleType.OTHER,
        handleConfig: {},
      },
    ],
    ...overrides,
  };
}

describe('GPT Product Detail Panel', () => {
  it('renders the structured Vietnamese GPT panel with bold entities', () => {
    const detail = buildProductDetailMessage(makeProduct(), 'vi');
    assert.ok(detail.entities && detail.entities.length > 0);
    const boldTexts = detail.entities
      .filter((entity) => entity.type === 'bold')
      .map((entity) => detail.text.slice(entity.offset, entity.offset + entity.length));

    assert.deepEqual(boldTexts, [
      'CHATGPT',
      '📊 Hệ thống phân loại gói cước:',
      '🚫 NW:',
      '⏱ W(Số):',
      '• Ví dụ:',
      '🛡 FW:',
      '🚛 Định dạng bàn giao:',
      '• 👨‍💼 TK cấp sẵn:',
      '• ⚙️ Dịch vụ:',
    ]);
    assert.ok(detail.text.includes('Ưu tiên sản phẩm GGPAY vì siêu bền, các sản phẩm khác chống cháy'));
    assert.ok(detail.text.endsWith('Chọn sản phẩm để mua:'));
  });

  it('renders the translated English GPT panel and handles empty plans', () => {
    const detail = buildProductDetailMessage(makeProduct({ plans: [] }), 'en');
    assert.ok(detail.entities && detail.entities.length > 0);
    const boldTexts = detail.entities
      .filter((entity) => entity.type === 'bold')
      .map((entity) => detail.text.slice(entity.offset, entity.offset + entity.length));

    assert.deepEqual(boldTexts, [
      'CHATGPT',
      '📊 Plan classification system:',
      '🚫 NW:',
      '⏱ W(Number):',
      '• Example:',
      '🛡 FW:',
      '🚛 Delivery format:',
      '• 👨‍💼 Pre-made account:',
      '• ⚙️ Service:',
    ]);
    assert.ok(detail.text.endsWith('No plans are currently available for this product.'));
  });

  it('renders the CapCut, Gemini, Grok, and M365 panels with the automated 5s delivery note', () => {
    for (const [slug, expectedTitle] of [
      ['capcut', 'CAPCUT'],
      ['gemini', 'GEMINI'],
      ['grok', 'GROK'],
      ['m365', 'M365'],
    ] as const) {
      const detail = buildProductDetailMessage(
        makeProduct({
          name: slug,
          slug,
        }),
        'vi',
      );
      assert.ok(detail.entities && detail.entities.length > 0);
      const boldTexts = detail.entities
        .filter((entity) => entity.type === 'bold')
        .map((entity) => detail.text.slice(entity.offset, entity.offset + entity.length));

      assert.equal(boldTexts[0], expectedTitle);
      assert.ok(detail.text.includes('🏪 Giao dịch tự động - Nhận hàng sau 5s!'));
      assert.ok(detail.text.endsWith('Chọn sản phẩm để mua:'));
    }
  });

  it('renders the YouTube panel with mail instruction instead of delivery format', () => {
    const detail = buildProductDetailMessage(
      makeProduct({
        name: 'YouTube',
        slug: 'youtube',
      }),
      'vi',
    );
    assert.ok(detail.entities && detail.entities.length > 0);
    assert.ok(detail.text.includes('GỬI MAIL SAU KHI MUA HÀNG LÀ DONE'));
    assert.equal(detail.text.includes('Định dạng bàn giao:'), false);
    assert.ok(detail.text.includes('🏪 Giao dịch tự động - Nhận hàng sau 5s!'));
    assert.ok(detail.text.endsWith('Chọn sản phẩm để mua:'));
  });

  it('renders the Claude panel with the same classification, delivery format, and GGPAY note as GPT', () => {
    const detail = buildProductDetailMessage(
      makeProduct({
        name: 'Claude',
        slug: 'claude',
      }),
      'vi',
    );
    assert.ok(detail.entities && detail.entities.length > 0);
    const boldTexts = detail.entities
      .filter((entity) => entity.type === 'bold')
      .map((entity) => detail.text.slice(entity.offset, entity.offset + entity.length));

    assert.deepEqual(boldTexts, [
      'CLAUDE',
      '📊 Hệ thống phân loại gói cước:',
      '🚫 NW:',
      '⏱ W(Số):',
      '• Ví dụ:',
      '🛡 FW:',
      '🚛 Định dạng bàn giao:',
      '• 👨‍💼 TK cấp sẵn:',
      '• ⚙️ Dịch vụ:',
    ]);
    assert.ok(detail.text.includes('Ưu tiên sản phẩm GGPAY vì siêu bền, các sản phẩm khác chống cháy'));
    assert.ok(detail.text.endsWith('Chọn sản phẩm để mua:'));
  });

  it('leaves non-classified products unchanged without custom entities', () => {
    const detail = buildProductDetailMessage(
      makeProduct({
        name: 'Netflix',
        slug: 'netflix',
        descriptionVi: 'Mô tả Netflix',
      }),
      'vi',
    );
    assert.equal(detail.entities, undefined);
    assert.equal(detail.text, 'Netflix\n\nMô tả Netflix');
  });
});

describe('Plan Confirmation Screen before QR generation', () => {
  it('renders dynamic plan description inside blockquote, real price/stock, and support contacts from env', () => {
    const samplePlan = {
      nameVi: 'SLOT GPT TEAM 1M BHF',
      nameEn: 'Slot GPT Team 1M Full Warranty',
      descriptionVi: 'Mô tả gói Team 1 tháng\nHướng dẫn: https://t.me/lehaipreshopnoti/529',
      descriptionEn: 'English Team 1 month description',
      price: 280_000n,
      currency: 'VND',
      stockQuantity: 10,
    };

    const withoutSupport = buildPlanConfirmationMessage(samplePlan, 'vi', {});
    assert.equal(withoutSupport.text.includes('Liên hệ hỗ trợ:'), false);
    assert.ok(withoutSupport.entities?.some((e) => e.type === 'blockquote'));
    assert.ok(withoutSupport.text.includes('SLOT GPT TEAM 1M BHF'));
    assert.ok(withoutSupport.text.includes('280.000 VND'));
    assert.ok(withoutSupport.text.includes('còn 10'));
    assert.ok(withoutSupport.text.includes('https://t.me/lehaipreshopnoti/529'));
    assert.ok(withoutSupport.text.endsWith('Xác nhận thông tin bên trên để tiến hành đặt hàng & tạo mã QR:'));

    const withSupport = buildPlanConfirmationMessage(samplePlan, 'en', {
      SUPPORT_TELEGRAM: '@myshop',
      SUPPORT_ZALO: '0909123456',
    });
    assert.ok(withSupport.text.includes('Slot GPT Team 1M Full Warranty'));
    assert.ok(withSupport.text.includes('English Team 1 month description'));
    assert.ok(withSupport.text.includes('280,000 VND'));
    assert.ok(withSupport.text.includes('10 left'));
    assert.ok(withSupport.text.includes('💡 Contact support:'));
    assert.ok(withSupport.text.includes('✉️ Telegram: @myshop'));
    assert.ok(withSupport.text.includes('📞 Zalo: 0909123456'));
  });

  it('routes plan click to confirmation screen before buy/QR action', async () => {
    const actions: Array<{ trigger: string | RegExp; handler: (ctx: Context) => Promise<unknown> }> = [];
    const fakeBot = {
      action(trigger: string | RegExp, handler: (ctx: Context) => Promise<unknown>) {
        actions.push({ trigger, handler });
      },
    } as unknown as Telegraf;

    const productId = randomUUID();
    const planId = randomUUID();
    let orderCreated = false;
    const edited: Array<{ text: string; extra: Record<string, unknown> }> = [];

    const deps: CatalogDependencies = {
      productsService: {
        listActiveProducts: async () => [],
        getProductWithPlans: async () => makeProduct({ id: productId, plans: [makeProduct().plans[0] ? { ...makeProduct().plans[0], id: planId } : never()] }),
        getActivePlanById: async () => ({
          id: planId,
          productId,
          nameVi: 'SLOT GPT TEAM 1M BHF',
          nameEn: 'Slot GPT Team 1M Full Warranty',
          descriptionVi: 'Mô tả riêng cho SLOT GPT TEAM 1M BHF',
          descriptionEn: 'Custom description for Slot GPT Team 1M',
          price: 280_000n,
          currency: 'VND',
          durationDays: 30,
          warrantyDays: 30,
          stockQuantity: 10,
          handleType: PlanHandleType.OTHER,
          handleConfig: {},
          product: { id: productId, name: 'GPT', slug: 'gpt' },
        }),
      } as unknown as CatalogDependencies['productsService'],
      usersService: {} as unknown as CatalogDependencies['usersService'],
      ordersService: {
        createPendingOrder: async () => {
          orderCreated = true;
          throw new Error('Should not create order during plan preview');
        },
      } as unknown as CatalogDependencies['ordersService'],
      sepayQrClient: { isConfigured: () => true } as unknown as CatalogDependencies['sepayQrClient'],
      pendingCheckoutInputs: new Map<number, PendingCheckoutState>(),
    };

    function never(): never {
      throw new Error('Unexpected missing plan');
    }

    registerCatalog(fakeBot, 'vi', deps, async () => undefined);

    const findAction = (data: string) => {
      for (const entry of actions) {
        if (entry.trigger instanceof RegExp) {
          const match = entry.trigger.exec(data);
          if (match) return { handler: entry.handler, match };
        }
      }
      return null;
    };

    const fakeContext = (match: RegExpExecArray) =>
      ({
        chat: { id: 100, type: 'private' },
        from: { id: 100, first_name: 'Tester' },
        match,
        callbackQuery: { message: { message_id: 1 } },
        answerCbQuery: async () => undefined,
        editMessageText: async (text: string, extra: Record<string, unknown>) => {
          edited.push({ text, extra });
        },
      }) as unknown as Context;

    const itemRoute = findAction(`catalog:vi:item:0:${productId}`);
    assert.ok(itemRoute);
    await itemRoute.handler(fakeContext(itemRoute.match));

    const itemKeyboard = (edited[0]?.extra?.reply_markup as { inline_keyboard: Array<Array<{ callback_data?: string }>> })
      .inline_keyboard;
    assert.equal(itemKeyboard[0]?.[0]?.callback_data, `catalog:vi:plan:0:${planId}`);

    const planRoute = findAction(`catalog:vi:plan:0:${planId}`);
    assert.ok(planRoute);
    await planRoute.handler(fakeContext(planRoute.match));

    assert.equal(orderCreated, false);
    assert.ok(edited[1]?.text.includes('Mô tả riêng cho SLOT GPT TEAM 1M BHF'));
    assert.ok(edited[1]?.text.includes('280.000 VND'));
    assert.deepEqual(edited[1]?.extra?.link_preview_options, { is_disabled: true });
    const confirmKeyboard = (edited[1]?.extra?.reply_markup as { inline_keyboard: Array<Array<{ callback_data?: string; text?: string }>> })
      .inline_keyboard;
    assert.equal(confirmKeyboard[0]?.[0]?.text, '✅ Xác nhận');
    assert.equal(confirmKeyboard[0]?.[0]?.callback_data, `catalog:vi:buy:${planId}`);
    assert.equal(confirmKeyboard[1]?.[0]?.callback_data, `catalog:vi:item:0:${productId}`);
  });
});

describe('Buy Catalog Menu Header', () => {
  it('renders GeminiService Shop header, dynamic support contacts, promotions, and bold entities', () => {
    const msg = buildCatalogMenuMessage(
      'vi',
      { hasProducts: true, isError: false, page: 0, pageCount: 1 },
      { SUPPORT_TELEGRAM: '@geminishop', SUPPORT_ZALO: '0912345678' },
    );

    const boldTexts = (msg.entities ?? [])
      .filter((entity) => entity.type === 'bold')
      .map((entity) => msg.text.slice(entity.offset, entity.offset + entity.length));

    assert.deepEqual(boldTexts, [
      'GeminiService Shop — AUTO ORDER',
      'Liên hệ hỗ trợ:',
      'Telegram:',
      'Zalo:',
      'Khuyến mãi:',
      'Chọn sản phẩm bạn muốn mua:',
    ]);
    assert.ok(msg.text.includes('🛒 GeminiService Shop — AUTO ORDER ⚡️'));
    assert.ok(msg.text.includes('✉️ Telegram: @geminishop'));
    assert.ok(msg.text.includes('📞 Zalo: 0912345678'));
    assert.ok(msg.text.endsWith('Chọn sản phẩm bạn muốn mua: ⤵'));
  });

  it('shows the formatted text above product buttons when clicking Mua', async () => {
    const actions: Array<{ trigger: string | RegExp; handler: (ctx: Context) => Promise<unknown> }> = [];
    const fakeBot = {
      action(trigger: string | RegExp, handler: (ctx: Context) => Promise<unknown>) {
        actions.push({ trigger, handler });
      },
    } as unknown as Telegraf;

    const prodId = randomUUID();
    const edited: Array<{ text: string; extra: Record<string, unknown> }> = [];
    const deps: CatalogDependencies = {
      productsService: {
        listActiveProducts: async () => [
          {
            id: prodId,
            name: 'GPT',
            slug: 'gpt',
            image: null,
            descriptionVi: null,
            descriptionEn: null,
          },
        ],
      } as unknown as CatalogDependencies['productsService'],
      usersService: {} as unknown as CatalogDependencies['usersService'],
      ordersService: {} as unknown as CatalogDependencies['ordersService'],
      sepayQrClient: { isConfigured: () => true } as unknown as CatalogDependencies['sepayQrClient'],
      pendingCheckoutInputs: new Map<number, PendingCheckoutState>(),
    };

    registerCatalog(fakeBot, 'vi', deps, async () => undefined);
    const buyMenu = actions.find((entry) => entry.trigger === 'menu:vi:buy');
    assert.ok(buyMenu);

    await buyMenu.handler({
      chat: { id: 10, type: 'private' },
      from: { id: 10, first_name: 'Hung' },
      callbackQuery: { message: { message_id: 1 } },
      answerCbQuery: async () => undefined,
      editMessageText: async (text: string, extra: Record<string, unknown>) => {
        edited.push({ text, extra });
      },
    } as unknown as Context);

    assert.ok(edited[0]?.text.startsWith('🛒 GeminiService Shop — AUTO ORDER ⚡️'));
    assert.ok(edited[0]?.text.includes('🎁 Khuyến mãi:'));
    const keyboard = (edited[0]?.extra?.reply_markup as { inline_keyboard: Array<Array<{ text?: string; callback_data?: string }>> })
      .inline_keyboard;
    assert.equal(keyboard[0]?.[0]?.text, 'GPT');
    assert.equal(keyboard[0]?.[0]?.callback_data, `catalog:vi:item:0:${prodId}`);
  });
});
