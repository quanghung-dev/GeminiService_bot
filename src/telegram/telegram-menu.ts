function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function buildSupportMessage(
  code: 'vi' | 'en',
  envSource: NodeJS.ProcessEnv = process.env,
): string {
  const telegramContact = envSource.SUPPORT_TELEGRAM?.trim();
  const zaloContact = envSource.SUPPORT_ZALO?.trim();
  const contactLines = [
    telegramContact ? `✉️ <b>Telegram:</b> ${escapeHtml(telegramContact)}` : null,
    zaloContact ? `📞 <b>Zalo:</b> ${escapeHtml(zaloContact)}` : null,
  ].filter((line): line is string => line !== null);

  if (code === 'en') {
    return [
      '💬 <b>CUSTOMER SUPPORT</b>',
      '───────────────',
      ...(contactLines.length > 0 ? ['', '💡 <b>Contact support:</b>', ...contactLines] : []),
      '',
      '⏰ <b>Support hours:</b>',
      '└ 8:00 - 23:00 daily',
      '',
      '✍️ <b>Please note:</b>',
      '├ Include your order/transaction code when requesting support',
      '├ Describe the issue clearly',
      '└ Allow 5-10 minutes for a response',
      '',
      '───────────────',
      '🫶 Thank you for trusting our shop!',
    ].join('\n');
  }

  return [
    '💬 <b>HỖ TRỢ KHÁCH HÀNG</b>',
    '───────────────',
    ...(contactLines.length > 0 ? ['', '💡 <b>Liên hệ hỗ trợ:</b>', ...contactLines] : []),
    '',
    '⏰ <b>Thời gian hỗ trợ:</b>',
    '└ 8:00 - 23:00 hàng ngày',
    '',
    '✍️ <b>Lưu ý:</b>',
    '├ Gửi mã đơn / mã giao dịch khi cần hỗ trợ',
    '├ Mô tả rõ vấn đề gặp phải',
    '└ Chờ phản hồi trong 5-10 phút',
    '',
    '───────────────',
    '🫶 Cảm ơn bạn đã tin tưởng shop!',
  ].join('\n');
}

export const languages = [
  {
    code: 'vi',
    label: '🇻🇳 Tiếng Việt',
    welcome: (name: string) => `🪧 Chào mừng ${name}!`,
    guide: [
      '📍 Hướng dẫn nhanh:',
      '1. Bấm “🛍️ Mua”.',
      '2. Chọn sản phẩm bạn muốn.',
      '3. Thanh toán bằng mã QR.',
      '4. Sau khi thanh toán, bot sẽ tự động xử lý đơn hàng.',
    ].join('\n'),
    prompt: '📍 Vui lòng chọn menu:',
    unavailable: 'Tính năng này chưa khả dụng.',
  },
  {
    code: 'en',
    label: '🇬🇧 English',
    welcome: (name: string) => `🪧 Welcome, ${name}!`,
    guide: [
      '📍 Quick guide:',
      '1. Tap “🛍️ Buy”.',
      '2. Choose the product you want.',
      '3. Pay by QR code.',
      '4. The bot will process your order automatically after payment.',
    ].join('\n'),
    prompt: '📍 Please choose an option:',
    unavailable: 'This feature is not available yet.',
  },
] as const;

export const menuRows = [
  [{ id: 'buy', vi: '🛍️ Mua', en: '🛍️ Buy' }],
  [
    { id: 'profile', vi: '💵 Hồ sơ', en: '💵 Profile' },
    { id: 'orders', vi: '📊 Lịch sử mua', en: '📊 Purchase history' },
  ],
  [{ id: 'warranty', vi: '🛡️ Bảo hành', en: '🛡️ Warranty' }],
  [
    { id: 'notifications', vi: '🔔 Quản lý thông báo', en: '🔔 Manage notifications' },
    { id: 'support', vi: '💬 Hỗ trợ', en: '💬 Support' },
  ],
  [
    { id: 'language', vi: '🌐 Ngôn ngữ', en: '🌐 Language' },
    { id: 'guide', vi: 'ℹ️ HDSD', en: 'ℹ️ User guide' },
  ],
];
