import { Markup, TelegramError, type Context, type Telegraf } from 'telegraf';
import { OrderStatus, PaymentProvider } from '../generated/prisma/client.js';
import {
  isValidEmail,
  OrderDomainError,
  type OrdersService,
} from '../orders/orders.service.js';
import type { VietqrApiClient } from '../payments/vietqr/vietqr-api.client.js';
import type {
  CatalogProduct,
  CatalogProductDetails,
  ProductsService,
} from '../products/products.service.js';
import type { UsersService } from '../users/users.service.js';
import { readProductEmojiMap } from './product-emoji-map.js';

const productsPerPage = 15;
const shopTitle = '🏷️ GeminiService Shop';
const EMAIL_PROMPT_TTL_MS = 10 * 60_000;

export interface PendingEmailCheckout {
  planId: string;
  lang: 'vi' | 'en';
  expiresAt: number;
}

export interface CatalogDependencies {
  productsService: ProductsService;
  usersService: UsersService;
  ordersService: OrdersService;
  vietqrApiClient: VietqrApiClient;
  pendingEmailCheckouts: Map<number, PendingEmailCheckout>;
}

const copy = {
  vi: {
    heading: 'Chọn sản phẩm bạn muốn mua 👇',
    hint: 'Bấm vào một sản phẩm để xem chi tiết.',
    empty: 'Hiện chưa có sản phẩm.',
    error: 'Chưa tải được sản phẩm. Hãy thử làm mới.',
    missing: 'Sản phẩm này hiện không khả dụng.',
    noPlans: 'Sản phẩm này hiện chưa có gói.',
    plansError: 'Chưa tải được các gói. Hãy thử làm mới.',
    inStock: (quantity: string) => `còn ${quantity}`,
    outOfStock: 'hết hàng',
    refresh: '🔄 Làm mới',
    back: '↩️ Quay lại',
    products: '↩️ Danh sách sản phẩm',
    paymentUnavailable: '⚠️ Thanh toán VietQR hiện chưa sẵn sàng. Vui lòng thử lại sau hoặc liên hệ hỗ trợ.',
    askEmail: (productName: string, planName: string) =>
      `📧 Gói ${productName} - ${planName} cần email để kích hoạt.\n\nVui lòng gửi địa chỉ email của bạn trong tin nhắn tiếp theo:`,
    invalidEmail: '❌ Email không hợp lệ. Vui lòng nhập lại đúng định dạng email (ví dụ: ten@gmail.com):',
    cancelPrompt: '❌ Hủy',
    promptCancelled: 'Đã hủy thao tác đặt hàng.',
    creatingOrder: '⏳ Đang tạo đơn hàng và mã QR thanh toán...',
    planUnavailable: '❌ Gói dịch vụ này hiện không còn khả dụng.',
    planOutOfStock: '❌ Gói dịch vụ này vừa hết hàng. Vui lòng chọn gói khác.',
    qrFailed: '❌ Không thể tạo mã QR thanh toán lúc này. Đơn hàng đã được hủy và hoàn lại tồn kho. Vui lòng thử lại sau.',
    checkStatus: '🔄 Kiểm tra trạng thái',
    cancelOrder: '❌ Hủy đơn',
    orderCancelled: (code: string) => `❌ Đơn hàng ${code} đã được hủy thành công.`,
    orderCannotCancel: (code: string, status: string) =>
      `ℹ️ Đơn hàng ${code} hiện ở trạng thái ${status}, không thể hủy.`,
    orderNotFound: 'Không tìm thấy đơn hàng.',
    orderStatusText: (code: string, status: string) => `📦 Đơn hàng ${code} — Trạng thái hiện tại: ${status}`,
    noOrders: '📭 Bạn chưa có đơn hàng nào.',
    ordersHeading: '📊 Lịch sử đơn hàng gần đây:',
    qrCaption: (params: {
      orderCode: string;
      productName: string;
      planName: string;
      amount: string;
      currency: string;
      bankCode: string;
      accountNumber: string;
      accountName: string;
      content: string;
      expiresAt: string;
      targetEmail: string | null;
    }) =>
      [
        `🧾 Đơn hàng: ${params.orderCode}`,
        `📦 Sản phẩm: ${params.productName} - ${params.planName}`,
        params.targetEmail ? `📧 Email kích hoạt: ${params.targetEmail}` : null,
        `💵 Số tiền: ${params.amount} ${params.currency}`,
        `🏦 Ngân hàng: ${params.bankCode}`,
        `🔢 Số tài khoản: ${params.accountNumber}`,
        `👤 Chủ tài khoản: ${params.accountName}`,
        `📝 Nội dung CK: ${params.content}`,
        `⏰ Hạn thanh toán: ${params.expiresAt}`,
        '',
        'Vui lòng chuyển khoản đúng số tiền và nội dung để hệ thống tự động xác nhận.',
      ]
        .filter((line): line is string => line !== null)
        .join('\n'),
  },
  en: {
    heading: 'Choose a product 👇',
    hint: 'Tap a product to view its details.',
    empty: 'No products are currently available.',
    error: 'Could not load products. Please refresh to try again.',
    missing: 'This product is currently unavailable.',
    noPlans: 'No plans are currently available for this product.',
    plansError: 'Could not load plans. Please refresh to try again.',
    inStock: (quantity: string) => `${quantity} left`,
    outOfStock: 'out of stock',
    refresh: '🔄 Refresh',
    back: '↩️ Back',
    products: '↩️ Product list',
    paymentUnavailable: '⚠️ VietQR payment is currently unavailable. Please try again later or contact support.',
    askEmail: (productName: string, planName: string) =>
      `📧 ${productName} - ${planName} requires an email address for activation.\n\nPlease reply with your email address:`,
    invalidEmail: '❌ Invalid email address. Please enter a valid email (e.g. name@gmail.com):',
    cancelPrompt: '❌ Cancel',
    promptCancelled: 'Checkout cancelled.',
    creatingOrder: '⏳ Creating your order and payment QR code...',
    planUnavailable: '❌ This plan is no longer available.',
    planOutOfStock: '❌ This plan just sold out. Please choose another plan.',
    qrFailed: '❌ Could not generate payment QR code right now. Your order was cancelled and stock released. Please try again later.',
    checkStatus: '🔄 Check status',
    cancelOrder: '❌ Cancel order',
    orderCancelled: (code: string) => `❌ Order ${code} has been cancelled.`,
    orderCannotCancel: (code: string, status: string) =>
      `ℹ️ Order ${code} is currently ${status} and cannot be cancelled.`,
    orderNotFound: 'Order not found.',
    orderStatusText: (code: string, status: string) => `📦 Order ${code} — Current status: ${status}`,
    noOrders: '📭 You have no orders yet.',
    ordersHeading: '📊 Recent orders:',
    qrCaption: (params: {
      orderCode: string;
      productName: string;
      planName: string;
      amount: string;
      currency: string;
      bankCode: string;
      accountNumber: string;
      accountName: string;
      content: string;
      expiresAt: string;
      targetEmail: string | null;
    }) =>
      [
        `🧾 Order: ${params.orderCode}`,
        `📦 Product: ${params.productName} - ${params.planName}`,
        params.targetEmail ? `📧 Activation email: ${params.targetEmail}` : null,
        `💵 Amount: ${params.amount} ${params.currency}`,
        `🏦 Bank: ${params.bankCode}`,
        `🔢 Account No.: ${params.accountNumber}`,
        `👤 Account Name: ${params.accountName}`,
        `📝 Transfer Note: ${params.content}`,
        `⏰ Expires at: ${params.expiresAt}`,
        '',
        'Please transfer the exact amount and note for automatic confirmation.',
      ]
        .filter((line): line is string => line !== null)
        .join('\n'),
  },
} as const;

export async function showCatalogText(
  context: Context,
  text: string,
  options: NonNullable<Parameters<Context['editMessageText']>[1]>,
): Promise<void> {
  const message = context.callbackQuery?.message;
  if (message && 'photo' in message) {
    await context.reply(text, options);
    await context.deleteMessage().catch(() => undefined);
  } else {
    try {
      await context.editMessageText(text, options);
    } catch (error) {
      if (!(error instanceof TelegramError && error.code === 400 && error.description.includes('message is not modified'))) {
        throw error;
      }
    }
  }
}

export async function createOrderAndSendQr(
  context: Context,
  deps: CatalogDependencies,
  code: 'vi' | 'en',
  planId: string,
  targetEmail?: string | null,
): Promise<void> {
  const labels = copy[code];
  const from = context.from;
  if (!from) return;

  if (!deps.vietqrApiClient.isConfigured()) {
    await context.reply(labels.paymentUnavailable);
    return;
  }

  const user = await deps.usersService.upsertTelegramUser(from, code);
  const plan = await deps.productsService.getActivePlanById(planId);
  if (!plan) {
    await context.reply(labels.planUnavailable);
    return;
  }

  const statusMsg = await context.reply(labels.creatingOrder);

  let order;
  try {
    order = await deps.ordersService.createPendingOrder({
      userId: user.id,
      planId: plan.id,
      targetEmail: targetEmail ?? null,
      paymentProvider: PaymentProvider.VIETQR,
    });
  } catch (error) {
    await context.telegram.deleteMessage(statusMsg.chat.id, statusMsg.message_id).catch(() => undefined);
    if (error instanceof OrderDomainError) {
      if (error.code === 'OUT_OF_STOCK') {
        await context.reply(labels.planOutOfStock);
        return;
      }
      if (error.code === 'PLAN_NOT_FOUND') {
        await context.reply(labels.planUnavailable);
        return;
      }
      if (error.code === 'INVALID_EMAIL') {
        await context.reply(labels.invalidEmail);
        return;
      }
    }
    throw error;
  }

  try {
    const qr = await deps.vietqrApiClient.generateCustomerQr({
      orderCode: order.orderCode,
      amount: order.totalAmount,
      content: order.orderCode,
    });

    await deps.ordersService.attachVietqrPaymentDetails(order.id, {
      paymentContent: qr.content,
      paymentQrCode: qr.qrCode,
      paymentQrLink: qr.qrLink,
      paymentVaAccount: qr.vaAccount,
      paymentProviderRef: qr.transactionRefId,
    });

    const numberFormat = new Intl.NumberFormat(code === 'vi' ? 'vi-VN' : 'en-US');
    const formattedPrice = numberFormat.format(order.totalAmount);
    const planName = code === 'vi' ? plan.nameVi : plan.nameEn;
    const expiresLabel = order.expiresAt.toLocaleString(code === 'vi' ? 'vi-VN' : 'en-US', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hour12: false,
    });

    const caption = labels.qrCaption({
      orderCode: order.orderCode,
      productName: plan.product.name,
      planName,
      amount: formattedPrice,
      currency: order.currency,
      bankCode: qr.bankName ? `${qr.bankCode} (${qr.bankName})` : qr.bankCode,
      accountNumber: qr.vaAccount ?? qr.bankAccount,
      accountName: qr.userBankName,
      content: qr.content,
      expiresAt: `${expiresLabel} (GMT+7)`,
      targetEmail: order.targetEmail,
    });

    await context.telegram.deleteMessage(statusMsg.chat.id, statusMsg.message_id).catch(() => undefined);
    await context.replyWithPhoto(
      { source: qr.qrImagePng, filename: `${order.orderCode}.png` },
      {
        caption,
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(labels.checkStatus, `order:${code}:status:${order.id}`),
            Markup.button.callback(labels.cancelOrder, `order:${code}:cancel:${order.id}`),
          ],
        ]),
      },
    );
  } catch {
    // Release reserved stock immediately if QR generation or photo delivery failed.
    await deps.ordersService
      .cancelPendingOrder(order.id, user.id, 'VIETQR_QR_GENERATION_FAILED')
      .catch(() => undefined);
    await context.telegram.deleteMessage(statusMsg.chat.id, statusMsg.message_id).catch(() => undefined);
    await context.reply(labels.qrFailed);
  }
}

export function registerCatalog(
  bot: Telegraf,
  code: 'vi' | 'en',
  deps: CatalogDependencies,
  renderMainMenu: (context: Context) => Promise<void>,
): void {
  const labels = copy[code];
  const numberFormat = new Intl.NumberFormat(code === 'vi' ? 'vi-VN' : 'en-US');
  const pageAction = (page: number) => `catalog:${code}:page:${page}`;
  const productAction = (page: number | string, id: string) => `catalog:${code}:item:${page}:${id}`;
  const buyPlanAction = (planId: string) => `catalog:${code}:buy:${planId}`;
  const backAction = `catalog:${code}:back`;
  const soldOutAction = `catalog:${code}:soldout`;
  const cancelEmailAction = `checkout:${code}:cancel`;

  async function showPage(context: Context, requestedPage: number): Promise<void> {
    let products: CatalogProduct[] | undefined;
    try {
      products = await deps.productsService.listActiveProducts();
    } catch {
      products = undefined;
    }

    const pageCount = Math.max(1, Math.ceil((products?.length ?? 0) / productsPerPage));
    const page = Math.min(requestedPage, pageCount - 1);
    const start = page * productsPerPage;
    const visible = (products ?? []).slice(start, start + productsPerPage);
    const emojis = await readProductEmojiMap();
    const rows = Markup.inlineKeyboard(
      visible.map((product) => {
        const emoji = emojis.get(product.id);
        return {
          ...Markup.button.callback(product.name, productAction(page, product.id)),
          style: 'success',
          icon_custom_emoji_id: emoji?.image === product.image ? emoji?.id : undefined,
        };
      }),
      { columns: 3 },
    ).reply_markup.inline_keyboard;

    if (pageCount > 1) {
      const navigation = [];
      if (page > 0) navigation.push(Markup.button.callback('◀️', pageAction(page - 1)));
      if (page + 1 < pageCount) navigation.push(Markup.button.callback('▶️', pageAction(page + 1)));
      rows.push(navigation);
    }
    rows.push([
      Markup.button.callback(labels.refresh, pageAction(page)),
      Markup.button.callback(labels.back, backAction),
    ]);

    const heading = pageCount > 1 ? `${labels.heading} (${page + 1}/${pageCount})` : labels.heading;
    const body = !products ? labels.error : products.length === 0 ? labels.empty : `${heading}\n${labels.hint}`;
    await showCatalogText(context, `${shopTitle}\n\n${body}`, {
      ...Markup.inlineKeyboard(rows),
      entities: [{ type: 'bold', offset: 0, length: shopTitle.length }],
    });
  }

  bot.action(`menu:${code}:buy`, async (context) => {
    await context.answerCbQuery();
    await showPage(context, 0);
  });

  bot.action(`menu:${code}:orders`, async (context) => {
    await context.answerCbQuery();
    if (!context.from) return;
    const user = await deps.usersService.upsertTelegramUser(context.from, code);
    const orders = await deps.ordersService.listUserOrders(user.id, 10);
    if (orders.length === 0) {
      await context.reply(labels.noOrders);
      return;
    }

    const lines = orders.map((order) => {
      const planName = code === 'vi' ? order.plan.nameVi : order.plan.nameEn;
      const amount = numberFormat.format(order.totalAmount);
      return `• ${order.orderCode} | ${order.plan.product.name} - ${planName} | ${amount} ${order.currency} | ${order.status}`;
    });
    await context.reply(`${labels.ordersHeading}\n\n${lines.join('\n')}`);
  });

  bot.action(new RegExp(`^catalog:${code}:page:([0-9]{1,6})$`), async (context) => {
    await context.answerCbQuery();
    await showPage(context, Number(context.match[1]));
  });

  bot.action(new RegExp(`^catalog:${code}:item:([0-9]{1,6}):([a-f0-9-]{36})$`), async (context) => {
    await context.answerCbQuery();
    const [, page, id] = context.match;
    let product: CatalogProductDetails | null | undefined;
    try {
      product = await deps.productsService.getProductWithPlans(id);
    } catch {
      product = undefined;
    }

    const description = code === 'vi' ? product?.descriptionVi : product?.descriptionEn;
    const plans = product?.plans ?? [];
    const text = product
      ? [
          [product.name, description].filter(Boolean).join('\n\n').slice(0, 4000),
          plans.length === 0 ? labels.noPlans : undefined,
        ]
          .filter(Boolean)
          .join('\n\n')
      : product === null
        ? labels.missing
        : labels.plansError;
    const emoji = plans.length ? (await readProductEmojiMap()).get(id) : undefined;
    const rows = plans.map((plan) => {
      const name = code === 'vi' ? plan.nameVi : plan.nameEn;
      const price = numberFormat.format(BigInt(plan.price));
      const hasStock = plan.stockQuantity > 0;
      const stock = hasStock ? labels.inStock(numberFormat.format(plan.stockQuantity)) : labels.outOfStock;
      return [
        {
          ...Markup.button.callback(
            `${name} - ${price} ${plan.currency} (${stock})`,
            hasStock ? buyPlanAction(plan.id) : soldOutAction,
          ),
          style: hasStock ? 'success' : 'danger',
          icon_custom_emoji_id: emoji?.image === product?.image ? emoji?.id : undefined,
        },
      ];
    });

    await showCatalogText(
      context,
      text,
      Markup.inlineKeyboard([
        ...rows,
        [
          Markup.button.callback(labels.refresh, productAction(page, id)),
          Markup.button.callback(labels.products, pageAction(Number(page))),
        ],
      ]),
    );
  });

  bot.action(new RegExp(`^catalog:${code}:buy:([a-f0-9-]{36})$`), async (context) => {
    await context.answerCbQuery();
    const planId = context.match[1];
    if (!context.from) return;

    if (!deps.vietqrApiClient.isConfigured()) {
      await context.reply(labels.paymentUnavailable);
      return;
    }

    const plan = await deps.productsService.getActivePlanById(planId);
    if (!plan) {
      await context.reply(labels.planUnavailable);
      return;
    }
    if (plan.stockQuantity <= 0) {
      await context.reply(labels.planOutOfStock);
      return;
    }

    if (plan.requiresEmail) {
      deps.pendingEmailCheckouts.set(context.from.id, {
        planId: plan.id,
        lang: code,
        expiresAt: Date.now() + EMAIL_PROMPT_TTL_MS,
      });
      const planName = code === 'vi' ? plan.nameVi : plan.nameEn;
      await context.reply(
        labels.askEmail(plan.product.name, planName),
        Markup.inlineKeyboard([[Markup.button.callback(labels.cancelPrompt, cancelEmailAction)]]),
      );
      return;
    }

    await createOrderAndSendQr(context, deps, code, plan.id, null);
  });

  bot.action(cancelEmailAction, async (context) => {
    await context.answerCbQuery();
    if (context.from) {
      deps.pendingEmailCheckouts.delete(context.from.id);
    }
    await context.reply(labels.promptCancelled);
  });

  bot.action(new RegExp(`^order:${code}:status:([a-f0-9-]{36})$`), async (context) => {
    await context.answerCbQuery();
    if (!context.from) return;
    const orderId = context.match[1];
    const user = await deps.usersService.upsertTelegramUser(context.from, code);
    const order = await deps.ordersService.getOrderForUser(orderId, user.id);
    if (!order) {
      await context.reply(labels.orderNotFound);
      return;
    }
    await context.reply(labels.orderStatusText(order.orderCode, order.status));
  });

  bot.action(new RegExp(`^order:${code}:cancel:([a-f0-9-]{36})$`), async (context) => {
    await context.answerCbQuery();
    if (!context.from) return;
    const orderId = context.match[1];
    const user = await deps.usersService.upsertTelegramUser(context.from, code);
    const order = await deps.ordersService.getOrderForUser(orderId, user.id);
    if (!order) {
      await context.reply(labels.orderNotFound);
      return;
    }
    const result = await deps.ordersService.cancelPendingOrder(order.id, user.id, 'USER_CANCELLED');
    if (result.cancelled) {
      await context.reply(labels.orderCancelled(order.orderCode));
    } else {
      await context.reply(labels.orderCannotCancel(order.orderCode, result.status));
    }
  });

  bot.action(soldOutAction, (context) => context.answerCbQuery(labels.outOfStock));
  bot.action(backAction, async (context) => {
    await context.answerCbQuery();
    await renderMainMenu(context);
  });
}

export async function handlePendingEmailText(
  context: Context,
  deps: CatalogDependencies,
  text: string,
): Promise<boolean> {
  const from = context.from;
  if (!from) return false;
  const pending = deps.pendingEmailCheckouts.get(from.id);
  if (!pending) return false;

  if (Date.now() > pending.expiresAt) {
    deps.pendingEmailCheckouts.delete(from.id);
    return false;
  }

  const trimmed = text.trim();
  if (!isValidEmail(trimmed)) {
    const labels = copy[pending.lang];
    await context.reply(
      labels.invalidEmail,
      Markup.inlineKeyboard([
        [Markup.button.callback(labels.cancelPrompt, `checkout:${pending.lang}:cancel`)],
      ]),
    );
    return true;
  }

  deps.pendingEmailCheckouts.delete(from.id);
  await createOrderAndSendQr(context, deps, pending.lang, pending.planId, trimmed);
  return true;
}

export function isOrderTerminalStatus(status: OrderStatus): boolean {
  return (
    status === OrderStatus.COMPLETED
    || status === OrderStatus.CANCELLED
    || status === OrderStatus.EXPIRED
    || status === OrderStatus.FAILED
  );
}
