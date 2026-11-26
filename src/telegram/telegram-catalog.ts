import { randomUUID } from 'node:crypto';
import { Markup, TelegramError, type Context, type Telegraf } from 'telegraf';
import { bold, fmt, code as mono, quote } from 'telegraf/format';
import {
  OrderStatus,
  PaymentProvider,
  type PlanHandleType,
} from '../generated/prisma/client.js';
import {
  type CustomerFieldKey,
  type CustomerOrderInput,
  formatHandleTypeLabel,
  type HandleFieldConfig,
  parseCustomerOrderInput,
  parseDeliveryOrderData,
  parsePlanHandleConfig,
  resolveCheckoutFields,
} from '../orders/handle-type.types.js';
import {
  isValidEmail,
  OrderDomainError,
  type OrdersService,
} from '../orders/orders.service.js';
import type { SepayQrClient } from '../payments/sepay/sepay-qr.client.js';
import type {
  CatalogProduct,
  CatalogProductDetails,
  ProductsService,
} from '../products/products.service.js';
import type { UsersService } from '../users/users.service.js';
import { readProductEmojiMap } from './product-emoji-map.js';
import { resolveSupportContacts } from './telegram-menu.js';

const productsPerPage = 15;
const ordersPerPage = 10;
const UUID_PATTERN = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const orderDateOptions = {
  timeZone: 'Asia/Ho_Chi_Minh',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
} as const;
const orderListDate = new Intl.DateTimeFormat('en-GB', orderDateOptions);
const orderDetailDate = new Intl.DateTimeFormat('en-GB', { ...orderDateOptions, year: 'numeric' });
const vietnameseOrderStatuses: Record<OrderStatus, string> = {
  PENDING: 'CHỜ THANH TOÁN',
  PAID: 'ĐÃ THANH TOÁN',
  PROCESSING: 'ĐANG XỬ LÝ',
  COMPLETED: 'HOÀN THÀNH',
  CANCELLED: 'ĐÃ HỦY',
  EXPIRED: 'HẾT HẠN',
  FAILED: 'THẤT BẠI',
};
const CHECKOUT_PROMPT_TTL_MS = 10 * 60_000;
const fallbackInFlightCheckouts = new WeakMap<CatalogDependencies, Set<number>>();

export interface PendingCheckoutState {
  sessionId: string;
  planId: string;
  productName: string;
  planName: string;
  lang: 'vi' | 'en';
  handleType: PlanHandleType;
  fields: HandleFieldConfig[];
  currentIndex: number;
  collected: CustomerOrderInput;
  instruction?: string;
  expiresAt: number;
}

export interface CatalogDependencies {
  productsService: ProductsService;
  usersService: UsersService;
  ordersService: OrdersService;
  sepayQrClient: SepayQrClient;
  orderExpiresMinutes?: number;
  pendingCheckoutInputs: Map<number, PendingCheckoutState>;
  inFlightCheckouts?: Set<number>;
}

function getInFlightCheckouts(deps: CatalogDependencies): Set<number> {
  if (deps.inFlightCheckouts) return deps.inFlightCheckouts;
  let existing = fallbackInFlightCheckouts.get(deps);
  if (!existing) {
    existing = new Set<number>();
    fallbackInFlightCheckouts.set(deps, existing);
  }
  return existing;
}

const copy = {
  vi: {
    empty: 'Hiện chưa có sản phẩm.',
    error: 'Chưa tải được sản phẩm. Hãy thử làm mới.',
    missing: 'Sản phẩm này hiện không khả dụng.',
    noPlans: 'Sản phẩm này hiện chưa có gói.',
    plansError: 'Chưa tải được các gói. Hãy thử làm mới.',
    inStock: (quantity: string) => `còn ${quantity}`,
    outOfStock: 'hết hàng',
    back: '↩️ Quay lại',
    products: '↩️ Danh sách sản phẩm',
    confirmBuy: '✅ Xác nhận',
    paymentUnavailable: '⚠️ Thanh toán QR hiện chưa sẵn sàng. Vui lòng thử lại sau hoặc liên hệ hỗ trợ.',
    invalidEmail: '❌ Email không hợp lệ. Vui lòng nhập lại đúng định dạng email (ví dụ: ten@gmail.com):',
    invalidRequiredText: '❌ Thông tin không được để trống. Vui lòng nhập lại:',
    inputRequiredError: '❌ Thiếu thông tin bắt buộc cho gói dịch vụ này. Vui lòng đặt lại đơn hàng.',
    promptExpired: '⌛ Phiên nhập thông tin đặt hàng đã hết hạn. Vui lòng chọn lại gói để đặt hàng.',
    skipField: '⏭️ Bỏ qua',
    cancelPrompt: '❌ Hủy',
    promptCancelled: 'Đã hủy thao tác đặt hàng.',
    creatingOrder: '⏳ Đang tạo đơn hàng và mã QR thanh toán...',
    planUnavailable: '❌ Gói dịch vụ này hiện không còn khả dụng.',
    planOutOfStock: '❌ Gói dịch vụ này vừa hết hàng. Vui lòng chọn gói khác.',
    qrFailed: '❌ Không thể tạo mã QR thanh toán lúc này. Đơn hàng đã được hủy và hoàn lại tồn kho. Vui lòng thử lại sau.',
    buyPrivate: 'Vui lòng nhắn riêng với bot để mua hàng và thanh toán.',
    checkoutInProgress: '⏳ Yêu cầu tạo đơn hàng của bạn đang được xử lý, vui lòng đợi giây lát.',
    checkStatus: '🔄 Kiểm tra trạng thái',
    cancelOrder: '❌ Hủy đơn',
    orderCancelled: (code: string) => `❌ Đơn hàng ${code} đã được hủy thành công.`,
    orderCannotCancel: (code: string, status: string) =>
      `ℹ️ Đơn hàng ${code} hiện ở trạng thái ${status}, không thể hủy.`,
    orderNotFound: 'Không tìm thấy đơn hàng.',
    orderStatusText: (code: string, status: string) => `📦 Đơn hàng ${code} — Trạng thái hiện tại: ${status}`,
    noOrders: '📭 Bạn chưa có đơn hàng nào.',
    ordersHeading: '📊 LỊCH SỬ MUA HÀNG',
    ordersHint: 'Chọn một đơn hàng để xem chi tiết:',
    ordersPage: (page: number, totalPages: number, shown: number) =>
      `Trang ${page}/${totalPages} · Hiển thị ${shown} đơn`,
    ordersPrivate: 'Vui lòng mở Lịch sử mua trong chat riêng với bot.',
    defaultFieldPrompt: (key: CustomerFieldKey, validate: 'email' | 'text' | undefined) => {
      switch (key) {
        case 'usernameOrEmail':
          return validate === 'email'
            ? 'Vui lòng nhập địa chỉ email để kích hoạt:'
            : 'Vui lòng nhập tài khoản hoặc email của bạn:';
        case 'password':
          return 'Vui lòng nhập mật khẩu tài khoản:';
        case 'twoFactor':
          return 'Vui lòng nhập mã dự phòng 2FA (hoặc Secret Key):';
        case 'note':
          return 'Vui lòng nhập ghi chú / yêu cầu cho đơn hàng:';
      }
    },
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
      accountDisplay: string | null;
    }) =>
      [
        `🧾 Đơn hàng: ${params.orderCode}`,
        `📦 Sản phẩm: ${params.productName} - ${params.planName}`,
        params.accountDisplay ? `👤 Tài khoản/Email: ${params.accountDisplay}` : null,
        `💵 Số tiền: ${params.amount} ${params.currency}`,
        `🏦 Ngân hàng: ${params.bankCode}`,
        `🔢 Số tài khoản: ${params.accountNumber}`,
        `👤 Chủ tài khoản: ${params.accountName}`,
        `📝 Nội dung CK: ${params.content}`,
        `⏰ Hạn thanh toán: ${params.expiresAt}`,
        '',
        'Vui lòng chuyển khoản đúng số tiền và nội dung bên trên.',
      ]
        .filter((line): line is string => line !== null)
        .join('\n'),
  },
  en: {
    empty: 'No products are currently available.',
    error: 'Could not load products. Please refresh to try again.',
    missing: 'This product is currently unavailable.',
    noPlans: 'No plans are currently available for this product.',
    plansError: 'Could not load plans. Please refresh to try again.',
    inStock: (quantity: string) => `${quantity} left`,
    outOfStock: 'out of stock',
    back: '↩️ Back',
    products: '↩️ Product list',
    confirmBuy: '✅ Confirm',
    paymentUnavailable: '⚠️ QR payment is currently unavailable. Please try again later or contact support.',
    invalidEmail: '❌ Invalid email address. Please enter a valid email (e.g. name@gmail.com):',
    invalidRequiredText: '❌ This field cannot be empty. Please enter a value:',
    inputRequiredError: '❌ Missing required information for this plan. Please try ordering again.',
    promptExpired: '⌛ Your checkout input session expired. Please select the plan again.',
    skipField: '⏭️ Skip',
    cancelPrompt: '❌ Cancel',
    promptCancelled: 'Checkout cancelled.',
    creatingOrder: '⏳ Creating your order and payment QR code...',
    planUnavailable: '❌ This plan is no longer available.',
    planOutOfStock: '❌ This plan just sold out. Please choose another plan.',
    qrFailed: '❌ Could not generate payment QR code right now. Your order was cancelled and stock released. Please try again later.',
    buyPrivate: 'Please message the bot in a private chat to buy and pay.',
    checkoutInProgress: '⏳ Your order request is already being processed, please wait a moment.',
    checkStatus: '🔄 Check status',
    cancelOrder: '❌ Cancel order',
    orderCancelled: (code: string) => `❌ Order ${code} has been cancelled.`,
    orderCannotCancel: (code: string, status: string) =>
      `ℹ️ Order ${code} is currently ${status} and cannot be cancelled.`,
    orderNotFound: 'Order not found.',
    orderStatusText: (code: string, status: string) => `📦 Order ${code} — Current status: ${status}`,
    noOrders: '📭 You have no orders yet.',
    ordersHeading: '📊 PURCHASE HISTORY',
    ordersHint: 'Select an order to view its details:',
    ordersPage: (page: number, totalPages: number, shown: number) =>
      `Page ${page}/${totalPages} · Showing ${shown} ${shown === 1 ? 'order' : 'orders'}`,
    ordersPrivate: 'Open Purchase history in a private chat with the bot.',
    defaultFieldPrompt: (key: CustomerFieldKey, validate: 'email' | 'text' | undefined) => {
      switch (key) {
        case 'usernameOrEmail':
          return validate === 'email'
            ? 'Please reply with your activation email address:'
            : 'Please reply with your account username or email:';
        case 'password':
          return 'Please enter your account password:';
        case 'twoFactor':
          return 'Please enter your 2FA backup codes (or Secret Key):';
        case 'note':
          return 'Please enter any note / instructions for this order:';
      }
    },
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
      accountDisplay: string | null;
    }) =>
      [
        `🧾 Order: ${params.orderCode}`,
        `📦 Product: ${params.productName} - ${params.planName}`,
        params.accountDisplay ? `👤 Account/Email: ${params.accountDisplay}` : null,
        `💵 Amount: ${params.amount} ${params.currency}`,
        `🏦 Bank: ${params.bankCode}`,
        `🔢 Account No.: ${params.accountNumber}`,
        `👤 Account Name: ${params.accountName}`,
        `📝 Transfer Note: ${params.content}`,
        `⏰ Expires at: ${params.expiresAt}`,
        '',
        'Please transfer the exact amount and note shown above.',
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

function isPaymentConfigured(deps: CatalogDependencies): boolean {
  return deps.sepayQrClient.isConfigured();
}

function buildFieldPromptMarkup(state: PendingCheckoutState, field: HandleFieldConfig) {
  const labels = copy[state.lang];
  const buttons = [];
  if (!field.required) {
    buttons.push(
      Markup.button.callback(
        labels.skipField,
        `checkout:${state.lang}:skip:${state.sessionId}:${state.currentIndex}`,
      ),
    );
  }
  buttons.push(
    Markup.button.callback(
      labels.cancelPrompt,
      `checkout:${state.lang}:cancel:${state.sessionId}`,
    ),
  );
  return Markup.inlineKeyboard([buttons]);
}

function buildFieldPromptText(state: PendingCheckoutState): string {
  const labels = copy[state.lang];
  const field = state.fields[state.currentIndex];
  const stepPrefix =
    state.fields.length > 1
      ? `(${state.currentIndex + 1}/${state.fields.length}) `
      : '';
  const customPrompt = state.lang === 'vi' ? field.promptVi : field.promptEn;
  const promptBody =
    customPrompt ?? labels.defaultFieldPrompt(field.key, field.validate);

  const lines: string[] = [
    `📝 ${state.productName} - ${state.planName}`,
  ];
  if (state.currentIndex === 0 && state.instruction) {
    lines.push(state.instruction);
  }
  lines.push(`${stepPrefix}${promptBody}`);
  return lines.join('\n\n');
}

async function sendCurrentFieldPrompt(
  context: Context,
  state: PendingCheckoutState,
): Promise<void> {
  const field = state.fields[state.currentIndex];
  if (!field) return;
  await context.reply(
    buildFieldPromptText(state),
    buildFieldPromptMarkup(state, field),
  );
}

function normalizeCustomerInputArg(
  input?: CustomerOrderInput | string | null,
): CustomerOrderInput | null {
  if (!input) return null;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    return trimmed ? { usernameOrEmail: trimmed } : null;
  }
  return parseCustomerOrderInput(input);
}

export async function createOrderAndSendQr(
  context: Context,
  deps: CatalogDependencies,
  code: 'vi' | 'en',
  planId: string,
  customerInput?: CustomerOrderInput | string | null,
): Promise<void> {
  const labels = copy[code];
  const from = context.from;
  if (!from) return;

  if (context.chat?.type !== 'private') {
    await context.reply(labels.buyPrivate);
    return;
  }

  if (!isPaymentConfigured(deps)) {
    await context.reply(labels.paymentUnavailable);
    return;
  }

  const inFlight = getInFlightCheckouts(deps);
  if (inFlight.has(from.id)) {
    await context.reply(labels.checkoutInProgress);
    return;
  }

  inFlight.add(from.id);
  try {
    const user = await deps.usersService.upsertTelegramUser(from, code);
    const plan = await deps.productsService.getActivePlanById(planId);
    if (!plan) {
      await context.reply(labels.planUnavailable);
      return;
    }

    const normalizedInput = normalizeCustomerInputArg(customerInput);
    const targetEmail =
      normalizedInput?.usernameOrEmail && isValidEmail(normalizedInput.usernameOrEmail)
        ? normalizedInput.usernameOrEmail
        : null;

    const statusMsg = await context.reply(labels.creatingOrder);

    let order;
    try {
      order = await deps.ordersService.createPendingOrder({
        userId: user.id,
        planId: plan.id,
        targetEmail,
        customerInput: normalizedInput,
        paymentProvider: PaymentProvider.SEPAY,
        expiresMinutes: deps.orderExpiresMinutes,
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
        if (error.code === 'EMAIL_REQUIRED' || error.code === 'CUSTOMER_INPUT_REQUIRED') {
          await context.reply(labels.inputRequiredError);
          return;
        }
      }
      throw error;
    }

    try {
      const qr = await deps.sepayQrClient.generateCustomerQr({
        orderCode: order.orderCode,
        amount: order.totalAmount,
      });

      await deps.ordersService.attachVietqrPaymentDetails(order.id, {
        paymentProvider: PaymentProvider.SEPAY,
        paymentContent: qr.content,
        paymentQrCode: null,
        paymentQrLink: qr.qrLink,
        paymentVaAccount: null,
        paymentProviderRef: null,
      });

      const numberFormat = new Intl.NumberFormat(code === 'vi' ? 'vi-VN' : 'en-US');
      const formattedPrice = numberFormat.format(order.totalAmount);
      const planName = code === 'vi' ? plan.nameVi : plan.nameEn;
      const expiresLabel = order.expiresAt.toLocaleString(code === 'vi' ? 'vi-VN' : 'en-US', {
        timeZone: 'Asia/Ho_Chi_Minh',
        hour12: false,
      });
      const accountDisplay = normalizedInput?.usernameOrEmail ?? order.targetEmail ?? null;

      const caption = labels.qrCaption({
        orderCode: order.orderCode,
        productName: plan.product.name,
        planName,
        amount: formattedPrice,
        currency: order.currency,
        bankCode: qr.bankName ? `${qr.bankCode} (${qr.bankName})` : qr.bankCode,
        accountNumber: qr.bankAccount,
        accountName: qr.userBankName,
        content: qr.content,
        expiresAt: `${expiresLabel} (GMT+7)`,
        accountDisplay,
      });

      const buttons = [
        [Markup.button.callback(labels.cancelOrder, `order:${code}:cancel:${order.id}`)],
      ];

      await context.telegram.deleteMessage(statusMsg.chat.id, statusMsg.message_id).catch(() => undefined);
      await context.replyWithPhoto(
        { source: qr.qrImagePng, filename: `${order.orderCode}.png` },
        {
          caption: caption.slice(0, 1024),
          ...Markup.inlineKeyboard(buttons),
        },
      );
    } catch {
      await deps.ordersService
        .cancelPendingOrder(order.id, user.id, 'SEPAY_QR_GENERATION_FAILED')
        .catch(() => undefined);
      await context.telegram.deleteMessage(statusMsg.chat.id, statusMsg.message_id).catch(() => undefined);
      await context.reply(labels.qrFailed);
    }
  } finally {
    inFlight.delete(from.id);
  }
}

async function advanceCheckoutOrCreateOrder(
  context: Context,
  deps: CatalogDependencies,
  userId: number,
  state: PendingCheckoutState,
): Promise<void> {
  state.currentIndex += 1;
  state.expiresAt = Date.now() + CHECKOUT_PROMPT_TTL_MS;

  if (state.currentIndex < state.fields.length) {
    await sendCurrentFieldPrompt(context, state);
    return;
  }

  deps.pendingCheckoutInputs.delete(userId);
  await createOrderAndSendQr(
    context,
    deps,
    state.lang,
    state.planId,
    state.collected,
  );
}

type CustomerOrder = NonNullable<Awaited<ReturnType<OrdersService['getOrderForUser']>>>;

function orderProductName(order: CustomerOrder, code: 'vi' | 'en'): string {
  const snapshot = order.planSnapshot;
  const names = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot : {};
  const productName = typeof names.productName === 'string' ? names.productName : order.plan.product.name;
  const savedPlanName = code === 'vi' ? names.nameVi : names.nameEn;
  const currentPlanName = code === 'vi' ? order.plan.nameVi : order.plan.nameEn;
  const planName = typeof savedPlanName === 'string' ? savedPlanName : currentPlanName;
  return productName === planName ? productName : `${productName} - ${planName}`;
}

function formatOrderDetailText(code: 'vi' | 'en', order: CustomerOrder) {
  const isEnglish = code === 'en';
  const numberFormat = new Intl.NumberFormat(isEnglish ? 'en-US' : 'vi-VN');
  const amount = `${numberFormat.format(order.totalAmount)} ${order.currency}`;
  const status = isEnglish ? order.status : vietnameseOrderStatuses[order.status];
  const time = orderDetailDate.format(order.createdAt).replace(', ', ' ');
  // Checkout creates one order per unit and reserves one unit of stock.
  const quantity = 1;
  const summary = fmt`${isEnglish ? '📊 ORDER DETAILS' : '📊 CHI TIẾT ĐƠN HÀNG'}

${isEnglish ? '🔖 Order code:' : '🔖 Mã đơn:'} ${mono(order.orderCode)}
${bold(isEnglish ? '🛍 Product:' : '🛍 Sản phẩm:')} ${orderProductName(order, code)}
${bold(isEnglish ? '1️⃣ Quantity:' : '1️⃣ Số lượng:')} ${quantity}
${bold(isEnglish ? '💎 Amount:' : '💎 Số tiền:')} ${amount}
${bold(isEnglish ? '📌 Status:' : '📌 Trạng thái:')} ${status}
${bold(isEnglish ? '⌛ Time:' : '⌛ Thời gian:')} ${time}`;

  const customerInput = parseCustomerOrderInput(order.fulfillment?.customerInput);
  const deliveryData = parseDeliveryOrderData(order.fulfillment?.deliveryData);
  const lines: string[] = [
    `${isEnglish ? '⚙️ Handle type' : '⚙️ Loại xử lý'}: ${formatHandleTypeLabel(order.handleType, code)}`,
  ];

  const accountDisplay =
    order.subscription?.accountIdentifier
    ?? customerInput?.usernameOrEmail
    ?? order.targetEmail;
  if (accountDisplay) {
    lines.push(
      isEnglish
        ? `Account/Email: ${accountDisplay}`
        : `Tài khoản/Email: ${accountDisplay}`,
    );
  }

  if (deliveryData && 'link' in deliveryData) {
    lines.push(
      isEnglish
        ? `🔗 Confirmation link: ${deliveryData.link}`
        : `🔗 Link xác nhận: ${deliveryData.link}`,
    );
  } else if (deliveryData && 'username' in deliveryData) {
    lines.push(
      isEnglish
        ? `👤 Provided account: ${deliveryData.username}`
        : `👤 Tài khoản được cấp: ${deliveryData.username}`,
      isEnglish
        ? `🔑 Password: ${deliveryData.password}`
        : `🔑 Mật khẩu: ${deliveryData.password}`,
    );
    if (deliveryData.twoFactor) {
      lines.push(`🔐 2FA: ${deliveryData.twoFactor}`);
    }
  }

  if (deliveryData?.note) {
    lines.push(
      isEnglish ? `📝 Note: ${deliveryData.note}` : `📝 Ghi chú: ${deliveryData.note}`,
    );
  }

  if (order.subscription) {
    const validUntil = order.subscription.expiresAt.toISOString().slice(0, 10);
    lines.push(
      isEnglish
        ? `📅 Valid until: ${validUntil} (${order.subscription.status})`
        : `📅 Hạn sử dụng đến: ${validUntil} (${order.subscription.status})`,
    );
  }

  return lines.length > 0 ? fmt`${summary}\n\n${lines.join('\n')}` : summary;
}

interface ClassifiedProductPanel {
  title: string;
  middleVi?: ReturnType<typeof fmt> | string;
  middleEn?: ReturnType<typeof fmt> | string;
  noteVi: string;
  noteEn: string;
}

const classifiedProductPanels: Record<string, ClassifiedProductPanel> = {
  gpt: {
    title: 'CHATGPT',
    noteVi: 'Ưu tiên sản phẩm GGPAY vì siêu bền, các sản phẩm khác chống cháy',
    noteEn: 'Prioritize GGPAY plans for high durability; other options are short-term backups.',
  },
  claude: {
    title: 'CLAUDE',
    noteVi: 'Ưu tiên sản phẩm GGPAY vì siêu bền, các sản phẩm khác chống cháy',
    noteEn: 'Prioritize GGPAY plans for high durability; other options are short-term backups.',
  },
  capcut: {
    title: 'CAPCUT',
    noteVi: '🏪 Giao dịch tự động - Nhận hàng sau 5s!',
    noteEn: '🏪 Automated delivery - Receive your order in 5s!',
  },
  gemini: {
    title: 'GEMINI',
    noteVi: '🏪 Giao dịch tự động - Nhận hàng sau 5s!',
    noteEn: '🏪 Automated delivery - Receive your order in 5s!',
  },
  grok: {
    title: 'GROK',
    noteVi: '🏪 Giao dịch tự động - Nhận hàng sau 5s!',
    noteEn: '🏪 Automated delivery - Receive your order in 5s!',
  },
  m365: {
    title: 'M365',
    noteVi: '🏪 Giao dịch tự động - Nhận hàng sau 5s!',
    noteEn: '🏪 Automated delivery - Receive your order in 5s!',
  },
  youtube: {
    title: 'YOUTUBE',
    middleVi: 'GỬI MAIL SAU KHI MUA HÀNG LÀ DONE',
    middleEn: 'SEND YOUR EMAIL AFTER PURCHASE AND YOU ARE DONE',
    noteVi: '🏪 Giao dịch tự động - Nhận hàng sau 5s!',
    noteEn: '🏪 Automated delivery - Receive your order in 5s!',
  },
};

function buildClassifiedProductDetailMessage(
  panel: ClassifiedProductPanel,
  code: 'vi' | 'en',
  hasPlans: boolean,
) {
  if (code === 'en') {
    const footer = hasPlans ? 'Choose a product to buy:' : copy.en.noPlans;
    const middle =
      panel.middleEn
      ?? fmt`${bold('🚛 Delivery format:')}
${bold('• 👨‍💼 Pre-made account:')} Email | Pass | 2FA or other format
${bold('• ⚙️ Service:')} Official personal upgrade.`;
    return fmt`${bold(panel.title)}

${bold('📊 Plan classification system:')}

${bold('🚫 NW:')} No Warranty
• Ultra-low price - No warranty.

${bold('⏱ W(Number):')} Warranty Days or BH(Number)
• Warranty for a specific number of days.
${bold('• Example:')} W30 (30 days), W365 (1 year), BH1D,...

${bold('🛡 FW:')} Full Warranty or BHF
• FULL PLAN LIFETIME WARRANTY
• ✨ Peace of mind until the very last second!

──────────────────────────
${middle}

${panel.noteEn}

${footer}`;
  }

  const footer = hasPlans ? 'Chọn sản phẩm để mua:' : copy.vi.noPlans;
  const middle =
    panel.middleVi
    ?? fmt`${bold('🚛 Định dạng bàn giao:')}
${bold('• 👨‍💼 TK cấp sẵn:')} Email | Pass | 2FA hoặc định dạng khác
${bold('• ⚙️ Dịch vụ:')} Nâng cấp chính chủ.`;
  return fmt`${bold(panel.title)}

${bold('📊 Hệ thống phân loại gói cước:')}

${bold('🚫 NW:')} No Warranty
• Giá siêu rẻ - Không bảo hành.

${bold('⏱ W(Số):')} Warranty Days hoặc BH(Số)
• Bảo hành theo số ngày cụ thể.
${bold('• Ví dụ:')} W30 (30 ngày), W365 (1 năm), BH1D,...

${bold('🛡 FW:')} Full Warranty hoặc BHF
• BẢO HÀNH TRỌN VÒNG ĐỜI GÓI
• ✨ Yên tâm sử dụng đến giây cuối cùng!

──────────────────────────
${middle}

${panel.noteVi}

${footer}`;
}

export function buildProductDetailMessage(
  product: CatalogProductDetails | null | undefined,
  code: 'vi' | 'en',
): { text: string; entities?: ReturnType<typeof fmt>['entities'] } {
  const labels = copy[code];
  if (product === null) return { text: labels.missing };
  if (!product) return { text: labels.plansError };

  const plans = product.plans ?? [];
  const panel = classifiedProductPanels[product.slug];
  if (panel) {
    const formatted = buildClassifiedProductDetailMessage(panel, code, plans.length > 0);
    return { text: formatted.text, entities: formatted.entities };
  }

  const description = code === 'vi' ? product.descriptionVi : product.descriptionEn;
  const text = [
    [product.name, description].filter(Boolean).join('\n\n').slice(0, 4000),
    plans.length === 0 ? labels.noPlans : undefined,
  ]
    .filter(Boolean)
    .join('\n\n');
  return { text };
}

function buildSupportBlock(
  code: 'vi' | 'en',
  envSource: NodeJS.ProcessEnv = process.env,
) {
  const { zalo, telegram } = resolveSupportContacts(envSource);
  if (!zalo && !telegram) return '';
  return fmt`\n\n💡 ${bold(code === 'en' ? 'Contact support:' : 'Liên hệ hỗ trợ:')}${
    zalo ? fmt`\n📞 ${bold('Zalo:')} ${zalo}` : ''
  }${telegram ? fmt`\n✉️ ${bold('Tele:')} ${telegram}` : ''}`;
}

export function buildCatalogMenuMessage(
  code: 'vi' | 'en',
  options: { hasProducts: boolean; isError: boolean; page: number; pageCount: number },
  envSource: NodeJS.ProcessEnv = process.env,
) {
  const labels = copy[code];
  const header = fmt`🛒 ${bold('GeminiService Shop — AUTO ORDER')} ⚡️${buildSupportBlock(code, envSource)}`;
  if (options.isError) return fmt`${header}\n\n${labels.error}`;
  if (!options.hasProducts) return fmt`${header}\n\n${labels.empty}`;

  const pageSuffix = options.pageCount > 1 ? ` (${options.page + 1}/${options.pageCount})` : '';
  if (code === 'en') {
    return fmt`${header}

🎁 ${bold('Promotions:')}
Promotion details are listed inside each product when you open it.

${bold('Choose a product to buy:')}${pageSuffix} ⤵`;
  }

  return fmt`${header}

🎁 ${bold('Khuyến mãi:')}
Chương trình khuyến mãi được ghi chi tiết ở mỗi sản phẩm khi bấm vào.

${bold('Chọn sản phẩm bạn muốn mua:')}${pageSuffix} ⤵`;
}

export interface PlanConfirmationTarget {
  nameVi: string;
  nameEn: string;
  descriptionVi: string | null;
  descriptionEn: string | null;
  price: bigint | string;
  currency: string;
  stockQuantity: number;
}

export function buildPlanConfirmationMessage(
  plan: PlanConfirmationTarget,
  code: 'vi' | 'en',
  envSource: NodeJS.ProcessEnv = process.env,
) {
  const labels = copy[code];
  const numberFormat = new Intl.NumberFormat(code === 'vi' ? 'vi-VN' : 'en-US');
  const planName = code === 'en' ? plan.nameEn : plan.nameVi;
  const rawDescription =
    (code === 'en' ? plan.descriptionEn : plan.descriptionVi)?.trim()
    || (code === 'en' ? plan.descriptionVi : plan.descriptionEn)?.trim()
    || (code === 'en' ? 'No detailed description available.' : 'Chưa có mô tả chi tiết.');
  const description = rawDescription.slice(0, 3200);
  const priceText = `${numberFormat.format(BigInt(plan.price))} ${plan.currency}`;
  const stockText =
    plan.stockQuantity > 0
      ? labels.inStock(numberFormat.format(plan.stockQuantity))
      : labels.outOfStock;
  const supportBlock = buildSupportBlock(code, envSource);
  const warrantyQuote = quote`
${description}
`;

  if (code === 'en') {
    return fmt`📎 ${bold('Description & Warranty:')}
${warrantyQuote}

${bold(planName)}
💵 ${bold('Price:')} ${bold(priceText)}
📦 ${bold('Stock:')} ${stockText}${supportBlock}

${bold('Confirm the details above to proceed with QR payment:')}`;
  }

  return fmt`📎 ${bold('Description & Warranty:')}
${warrantyQuote}

${bold(planName)}
💵 ${bold('Giá:')} ${bold(priceText)}
📦 ${bold('Tồn kho:')} ${stockText}${supportBlock}

${bold('Xác nhận thông tin bên trên để tiến hành đặt hàng & tạo mã QR:')}`;
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
  const orderPageAction = (page: number) => `order:${code}:page:${page}`;
  const productAction = (page: number | string, id: string) => `catalog:${code}:item:${page}:${id}`;
  const planPreviewAction = (page: number | string, planId: string) => `catalog:${code}:plan:${page}:${planId}`;
  const buyPlanAction = (planId: string) => `catalog:${code}:buy:${planId}`;
  const backAction = `catalog:${code}:back`;
  const soldOutAction = `catalog:${code}:soldout`;

  function clearPendingInput(context: Context): void {
    if (context.from) {
      deps.pendingCheckoutInputs.delete(context.from.id);
    }
  }

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
    rows.push([Markup.button.callback(labels.back, backAction)]);

    const message = buildCatalogMenuMessage(code, {
      hasProducts: Boolean(products && products.length > 0),
      isError: !products,
      page,
      pageCount,
    });
    await showCatalogText(context, message.text, {
      ...Markup.inlineKeyboard(rows),
      entities: message.entities,
    });
  }

  bot.action(`menu:${code}:buy`, async (context) => {
    await context.answerCbQuery();
    await showPage(context, 0);
  });

  async function showOrderHistory(context: Context, requestedPage: number): Promise<void> {
    if (context.chat?.type !== 'private' || !context.from) {
      await context.answerCbQuery(labels.ordersPrivate);
      return;
    }

    await context.answerCbQuery();
    const user = await deps.usersService.upsertTelegramUser(context.from);
    const orderCount = await deps.ordersService.countUserOrders(user.id);
    const pageCount = Math.max(1, Math.ceil(orderCount / ordersPerPage));
    const page = Math.min(requestedPage, pageCount - 1);
    const offset = page * ordersPerPage;
    const orders = orderCount > 0 ? await deps.ordersService.listUserOrders(user.id, ordersPerPage, offset) : [];

    const rows = orders.map((order, index) => {
      const name = orderProductName(order, code).replace(/\s+/g, ' ');
      const amount = `${numberFormat.format(order.totalAmount)} ${order.currency}`;
      const time = orderListDate.format(order.createdAt).replace(', ', ' ');
      return [Markup.button.callback(
        `${offset + index + 1}. ${name} · ${amount} · ${time}`,
        `order:${code}:detail:${order.id}`,
      )];
    });
    const navigation = [];
    if (page > 0) navigation.push(Markup.button.callback('◀️', orderPageAction(page - 1)));
    if (page + 1 < pageCount) navigation.push(Markup.button.callback('▶️', orderPageAction(page + 1)));
    if (navigation.length > 0) rows.push(navigation);
    rows.push([Markup.button.callback(labels.back, backAction)]);

    const body = orders.length > 0
      ? `${labels.ordersHint}\n${labels.ordersPage(page + 1, pageCount, orders.length)}`
      : labels.noOrders;
    const message = fmt`${bold(labels.ordersHeading)}\n\n${body}`;
    await showCatalogText(context, message.text, {
      ...Markup.inlineKeyboard(rows),
      entities: message.entities,
    });
  }

  bot.action(`menu:${code}:orders`, (context) => showOrderHistory(context, 0));
  bot.action(new RegExp(`^order:${code}:page:(\\d{1,9})$`), (context) => {
    return showOrderHistory(context, Number(context.match[1]));
  });

  bot.action(new RegExp(`^catalog:${code}:page:([0-9]{1,6})$`), async (context) => {
    clearPendingInput(context);
    await context.answerCbQuery();
    await showPage(context, Number(context.match[1]));
  });

  bot.action(new RegExp(`^catalog:${code}:item:([0-9]{1,6}):(${UUID_PATTERN})$`), async (context) => {
    clearPendingInput(context);
    await context.answerCbQuery();
    const [, page, id] = context.match;
    let product: CatalogProductDetails | null | undefined;
    try {
      product = await deps.productsService.getProductWithPlans(id);
    } catch {
      product = undefined;
    }

    const detail = buildProductDetailMessage(product, code);
    const plans = product?.plans ?? [];
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
            planPreviewAction(page, plan.id),
          ),
          style: hasStock ? 'success' : 'danger',
          icon_custom_emoji_id: emoji?.image === product?.image ? emoji?.id : undefined,
        },
      ];
    });

    await showCatalogText(
      context,
      detail.text,
      {
        ...Markup.inlineKeyboard([
          ...rows,
          [Markup.button.callback(labels.products, pageAction(Number(page)))],
        ]),
        ...(detail.entities ? { entities: detail.entities } : {}),
      },
    );
  });

  bot.action(new RegExp(`^catalog:${code}:plan:([0-9]{1,6}):(${UUID_PATTERN})$`), async (context) => {
    clearPendingInput(context);
    await context.answerCbQuery();
    const [, page, planId] = context.match;
    const plan = await deps.productsService.getActivePlanById(planId);
    if (!plan) {
      await context.reply(labels.planUnavailable);
      return;
    }

    const message = buildPlanConfirmationMessage(plan, code);
    const hasStock = plan.stockQuantity > 0;
    const primaryButton = hasStock
      ? {
          ...Markup.button.callback(labels.confirmBuy, buyPlanAction(plan.id)),
          style: 'success' as const,
        }
      : {
          ...Markup.button.callback(labels.outOfStock, soldOutAction),
          style: 'danger' as const,
        };

    await showCatalogText(context, message.text, {
      ...Markup.inlineKeyboard([
        [primaryButton],
        [Markup.button.callback(labels.back, productAction(page, plan.productId))],
      ]),
      entities: message.entities,
      link_preview_options: { is_disabled: true },
    });
  });

  bot.action(new RegExp(`^catalog:${code}:buy:(${UUID_PATTERN})$`), async (context) => {
    if (context.chat?.type !== 'private' || !context.from) {
      await context.answerCbQuery(labels.buyPrivate);
      return;
    }
    if (getInFlightCheckouts(deps).has(context.from.id)) {
      await context.answerCbQuery(labels.checkoutInProgress);
      return;
    }

    await context.answerCbQuery();
    clearPendingInput(context);
    const planId = context.match[1];

    if (!isPaymentConfigured(deps)) {
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

    const parsedConfig = parsePlanHandleConfig(plan.handleConfig);
    const fields = resolveCheckoutFields(plan.handleType, parsedConfig);

    if (fields.length > 0) {
      const planName = code === 'vi' ? plan.nameVi : plan.nameEn;
      const instruction =
        code === 'vi' ? parsedConfig.instructionVi : parsedConfig.instructionEn;
      const state: PendingCheckoutState = {
        sessionId: randomUUID().slice(0, 8),
        planId: plan.id,
        productName: plan.product.name,
        planName,
        lang: code,
        handleType: plan.handleType,
        fields,
        currentIndex: 0,
        collected: {},
        instruction,
        expiresAt: Date.now() + CHECKOUT_PROMPT_TTL_MS,
      };
      deps.pendingCheckoutInputs.set(context.from.id, state);
      await sendCurrentFieldPrompt(context, state);
      return;
    }

    await createOrderAndSendQr(context, deps, code, plan.id, null);
  });

  bot.action(new RegExp(`^checkout:${code}:skip:([a-f0-9]{8}):(\\d{1,2})$`), async (context) => {
    await context.answerCbQuery();
    if (context.chat?.type !== 'private' || !context.from) return;
    const [, sessionId, stepRaw] = context.match;
    const stepIndex = Number(stepRaw);
    const state = deps.pendingCheckoutInputs.get(context.from.id);
    if (!state || state.sessionId !== sessionId || state.currentIndex !== stepIndex) {
      await context.editMessageReplyMarkup(undefined).catch(() => undefined);
      return;
    }
    if (Date.now() > state.expiresAt) {
      deps.pendingCheckoutInputs.delete(context.from.id);
      await context.editMessageReplyMarkup(undefined).catch(() => undefined);
      await context.reply(labels.promptExpired);
      return;
    }
    const currentField = state.fields[state.currentIndex];
    if (!currentField || currentField.required) {
      return;
    }
    await context.editMessageReplyMarkup(undefined).catch(() => undefined);
    await advanceCheckoutOrCreateOrder(context, deps, context.from.id, state);
  });

  bot.action(new RegExp(`^checkout:${code}:cancel:([a-f0-9]{8})$`), async (context) => {
    await context.answerCbQuery();
    await context.editMessageReplyMarkup(undefined).catch(() => undefined);
    if (!context.from) return;
    const sessionId = context.match[1];
    const state = deps.pendingCheckoutInputs.get(context.from.id);
    if (!state || state.sessionId !== sessionId) {
      return;
    }
    deps.pendingCheckoutInputs.delete(context.from.id);
    await context.reply(labels.promptCancelled);
  });

  bot.action(new RegExp(`^order:${code}:detail:(${UUID_PATTERN})$`), async (context) => {
    if (context.chat?.type !== 'private') {
      await context.answerCbQuery(labels.ordersPrivate);
      return;
    }
    await context.answerCbQuery();
    const orderId = context.match[1];
    const user = await deps.usersService.upsertTelegramUser(context.from);
    const order = await deps.ordersService.getOrderForUser(orderId, user.id);
    await context.reply(order ? formatOrderDetailText(code, order) : labels.orderNotFound);
  });

  bot.action(new RegExp(`^order:${code}:status:(${UUID_PATTERN})$`), async (context) => {
    if (context.chat?.type !== 'private' || !context.from) {
      await context.answerCbQuery(labels.ordersPrivate);
      return;
    }
    await context.answerCbQuery();
    const orderId = context.match[1];
    const user = await deps.usersService.upsertTelegramUser(context.from, code);
    const order = await deps.ordersService.getOrderForUser(orderId, user.id);
    if (!order) {
      await context.reply(labels.orderNotFound);
      return;
    }
    await context.reply(labels.orderStatusText(order.orderCode, order.status));
  });

  bot.action(new RegExp(`^order:${code}:cancel:(${UUID_PATTERN})$`), async (context) => {
    if (context.chat?.type !== 'private' || !context.from) {
      await context.answerCbQuery(labels.ordersPrivate);
      return;
    }
    await context.answerCbQuery();
    const orderId = context.match[1];
    const user = await deps.usersService.upsertTelegramUser(context.from, code);
    const order = await deps.ordersService.getOrderForUser(orderId, user.id);
    if (!order) {
      await context.reply(labels.orderNotFound);
      return;
    }
    const result = await deps.ordersService.cancelPendingOrder(order.id, user.id, 'USER_CANCELLED');
    if (result.cancelled) {
      await context.deleteMessage().catch(async () => {
        await context.editMessageReplyMarkup(undefined).catch(() => undefined);
      });
      await context.reply(labels.orderCancelled(order.orderCode));
    } else {
      await context.editMessageReplyMarkup(undefined).catch(() => undefined);
      await context.reply(labels.orderCannotCancel(order.orderCode, result.status));
    }
  });

  bot.action(soldOutAction, (context) => context.answerCbQuery(labels.outOfStock));
  bot.action(backAction, async (context) => {
    clearPendingInput(context);
    await context.answerCbQuery();
    await renderMainMenu(context);
  });
}

export async function handlePendingCheckoutText(
  context: Context,
  deps: CatalogDependencies,
  text: string,
): Promise<boolean> {
  const from = context.from;
  if (!from || context.chat?.type !== 'private') return false;
  const pending = deps.pendingCheckoutInputs.get(from.id);
  if (!pending) return false;

  const labels = copy[pending.lang];
  if (Date.now() > pending.expiresAt) {
    deps.pendingCheckoutInputs.delete(from.id);
    await context.reply(labels.promptExpired);
    return true;
  }

  const field = pending.fields[pending.currentIndex];
  if (!field) {
    deps.pendingCheckoutInputs.delete(from.id);
    return false;
  }

  const trimmed = text.trim();
  if (!trimmed) {
    await context.reply(
      labels.invalidRequiredText,
      buildFieldPromptMarkup(pending, field),
    );
    return true;
  }

  if (field.validate === 'email' && !isValidEmail(trimmed)) {
    await context.reply(
      labels.invalidEmail,
      buildFieldPromptMarkup(pending, field),
    );
    return true;
  }

  pending.collected[field.key] = trimmed;
  await advanceCheckoutOrCreateOrder(context, deps, from.id, pending);
  return true;
}
