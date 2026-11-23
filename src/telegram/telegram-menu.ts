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
