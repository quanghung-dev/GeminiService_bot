export interface TelegramSendSuccess {
  ok: true;
}

export interface TelegramSendFailure {
  ok: false;
  errorMessage: string;
  retryAfterSeconds?: number;
  permanent?: boolean;
}

export type TelegramSendResult = TelegramSendSuccess | TelegramSendFailure;

export interface TelegramMessageSender {
  sendMessage(chatId: bigint, text: string): Promise<TelegramSendResult>;
}
