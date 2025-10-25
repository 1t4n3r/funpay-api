import * as cheerio from 'cheerio';
import { EventEmitter } from 'events';
import type { IApiConfig, IProfile, IOrder, IChat, IChatMessage } from '@/types';

const DEFAULT_BASE_URL = 'https://funpay.com';
const DEFAULT_TIMEOUT = 10000;

function timeoutFetch(url: string, init: RequestInit = {}, timeout = DEFAULT_TIMEOUT) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  const merged = { ...init, signal: controller.signal };
  return fetch(url, merged).finally(() => clearTimeout(id));
}

/**
 * FunPayClient
 * - Парсинг HTML страниц FunPay.
 * - Методы: профиль, заказы, чаты, офферы, баланс, операции с заказом/оффером.
 * - При необходимости может выступать EventEmitter и делать polling (startPolling).
 */
export class FunPayClient extends EventEmitter {
  private goldenKey: string;
  private baseUrl: string;
  private timeoutMs: number;
  private pollingIntervalMs: number;

  // internal state for polling events
  private lastOrders = new Map<string, IOrder>();
  private lastMessages = new Map<number, IChat>();
  private lastBalance = 0;
  private polling = false;

  constructor(config: IApiConfig) {
    super();
    this.goldenKey = config.goldenKey;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT;
    this.pollingIntervalMs = config.pollingIntervalMs ?? 15000;
  }

  // ---------- helpers ----------
  private headers(extra?: Record<string, string>) {
    return {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      Cookie: `golden_key=${this.goldenKey}`,
      ...(extra ?? {}),
    };
  }

  private async fetchOrders(): Promise<string> {
    try {
      const url = `${this.baseUrl}/orders/trade`;
      const res = await timeoutFetch(url, { headers: this.headers() }, this.timeoutMs);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} (${url})`);
      return await res.text();
    } catch (err: any) {
      console.log(`Error: ${err.message}`);
      return '';
    }
  }

  private async fetchProfile(id: number): Promise<string> {
    try {
      const url = `${this.baseUrl}/users/${id}/`;
      const res = await timeoutFetch(url, { headers: this.headers() }, this.timeoutMs);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} (${url})`);
      return await res.text();
    } catch (err: any) {
      console.log(`Error: ${err.message}`);
      return '';
    }
  }

  private async fetchBalance(): Promise<string> {
    try {
      const url = `${this.baseUrl}/account/balance`;
      const res = await timeoutFetch(url, { headers: this.headers() }, this.timeoutMs);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} (${url})`);
      return await res.text();
    } catch (err: any) {
      console.log(`Error: ${err.message}`);
      return '';
    }
  }

  private async fetchChats(): Promise<string> {
    try {
      const url = `${this.baseUrl}/chat/`;
      const res = await timeoutFetch(url, { headers: this.headers() }, this.timeoutMs);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} (${url})`);
      return await res.text();
    } catch (err: any) {
      console.log(`Error: ${err.message}`);
      return '';
    }
  }

  private async fetchChatMessages(chatId: number): Promise<string> {
    try {
      const url = `${this.baseUrl}/chat/?node=${chatId}`;
      const res = await timeoutFetch(url, { headers: this.headers() }, this.timeoutMs);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} (${url})`);
      return await res.text();
    } catch (err: any) {
      console.log(`Error: ${err.message}`);
      return '';
    }
  }

  private async getChatAuthorUrl(chatId: number): Promise<string> {
    const html = await this.fetchChatMessages(chatId);
    const $ = cheerio.load(html);

    const authorUrl = $('.media-body a').attr('href')!;
    console.log(authorUrl)

    return authorUrl;
  }

  private async postForm(path: string, body: Record<string, string>): Promise<{ ok: boolean; text?: string }> {
    const url = `${this.baseUrl}${path}`;
    const res = await timeoutFetch(
      url,
      {
        method: 'POST',
        headers: { ...this.headers({ 'Content-Type': 'application/x-www-form-urlencoded' }) },
        body: new URLSearchParams(body).toString(),
      },
      this.timeoutMs,
    );
    const text = await res.text().catch(() => '');
    return { ok: res.ok, text };
  }

  // ---------- API methods ----------
  async getProfile(profileUrl: string): Promise<IProfile> {
    const profileId = +profileUrl.replace(/\D*(\d+)\/?$/, '$1');

    const html = await this.fetchProfile(profileId);
    const $ = cheerio.load(html);

    const name = $('.mb40').children().first().text();
    const avatarStyleAttr = $('.avatar-photo').attr('style');
    const urlMatch = avatarStyleAttr?.match(/url\(["']?(.*?)["']?\)/i) || [
      'url',
      `${this.baseUrl}/img/layout/avatar.png`,
    ];
    const avatarUrl = urlMatch[1];
    const rating = parseFloat($('.rating-value').first().text()) || 0;

    return {
      id: profileId,
      name: name,
      avatarUrl: avatarUrl,
      rating: rating,
      url: profileUrl,
    };
  }

  async getBalance(): Promise<number> {
    try {
      const html = await this.fetchBalance();
      const $ = cheerio.load(html);
      return parseFloat($('.balances-value').first().text());
    } catch {
      return 0;
    }
  }

  async getOrders(startIndex: number = 0, lastIndex: number = 10): Promise<IOrder[]> {
    const html = await this.fetchOrders();
    const $ = cheerio.load(html);
    const orders: IOrder[] = [];

    for (let i = startIndex; i < lastIndex && i < $('.tc-item').length; i++) {
      const el = $('.tc-item').eq(i);
      const date = el.find('.tc-date-time').text();
      const id = el.find('.tc-order').text();
      const buyerUrl = el.find('span.pseudo-a').attr('data-href') || '';
      const buyer = await this.getProfile(buyerUrl);
      const status = el.find('.tc-status').text();
      const price = parseFloat(el.find('.tc-price').text());
      const descText = el.find('.order-desc').children().first().text();
      const amountMatch = descText.match(/(\d+)\s*шт/i);
      const amount = amountMatch ? parseInt(amountMatch[1]) : 1;

      orders.push({ date, id, buyer, status, price, amount });
    }

    return orders;
  }

  async changeOfferPrice(offerId: number, newPrice: number): Promise<boolean> {
    const res = await this.postForm('/trade/offer/update', { id: String(offerId), price: String(newPrice) });
    return res.ok;
  }

  async changeOfferAvailability(offerId: number, available: boolean): Promise<boolean> {
    const res = await this.postForm('/trade/offer/toggle', { id: String(offerId), available: available ? '1' : '0' });
    return res.ok;
  }

  async getChats(startIndex: number = 0, lastIndex: number = 10): Promise<IChat[]> {
    const t1 = new Date();
    const html = await this.fetchChats();
    const $ = cheerio.load(html);
    const chats: IChat[] = [];

    for (let i = startIndex; i < lastIndex && i < $('.contact-item').length; i++) {
      const el = $('.contact-item').eq(i);

      const chatId = +el.attr('data-id')!;

      const author = await this.getProfile(await this.getChatAuthorUrl(chatId));
      const date = el.find('.contact-item-time').text();

      chats.push({ id: chatId, author, date });
    }
    console.log(Date.now() - t1.getTime());

    return chats;
  }

  async getChatMessages(chatId: number): Promise<IChatMessage[]> {
    const html = await this.fetchChatMessages(chatId);
    const $ = cheerio.load(html);

    const elements = $('.chat-message-list').toArray();

    const messages: IChatMessage[] = [];

    let prevAuthorUrl = '';

    for (const el of elements) {
      const element = $(el);

      const authorUrl = element.find('.chat-msg-author-link').attr('href') || prevAuthorUrl;
      if (authorUrl) prevAuthorUrl = authorUrl;

      let author = null;
      if (authorUrl) {
        author = await this.getProfile(authorUrl);
      }

      const text = element.find('.chat-msg-text').text();
      const date = element.find('.chat-msg-date').text();

      messages.push({ author, text, date });
    }

    return messages;
  }

  async sendMessage(orderId: number, message: string): Promise<boolean> {
    const res = await this.postForm('/orders/message', { order_id: String(orderId), message });
    return res.ok;
  }

  // ---------- polling / events ----------
  async startPolling(intervalMs?: number) {
    if (this.polling) return;
    this.polling = true;
    const interval = intervalMs ?? this.pollingIntervalMs;

    // initialize snapshots
    try {
      const [orders, messages, balance] = await Promise.all([this.getOrders(), this.getChats(), this.getBalance()]);
      orders.forEach((o: IOrder) => this.lastOrders.set(o.id, o));
      messages.forEach((m: IChat) => this.lastMessages.set(m.id, m));
      this.lastBalance = balance;
    } catch (err) {
      this.emit('error', err);
    }

    while (this.polling) {
      try {
        await this.checkOnce();
      } catch (err) {
        this.emit('error', err);
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  stopPolling() {
    this.polling = false;
  }

  private async checkOnce() {
    // balance
    const balance = await this.getBalance();
    if (this.lastBalance !== 0 && balance !== this.lastBalance) {
      this.emit('balanceChange', { old: this.lastBalance, new: balance });
    }
    this.lastBalance = balance;

    // orders
    const orders = await this.getOrders();
    for (const o of orders) {
      const prev = this.lastOrders.get(o.id);
      if (!prev) {
        this.emit('newOrder', o);
      } else if (prev.status !== o.status) {
        this.emit('orderStatusChange', { old: prev, new: o });
      }
      this.lastOrders.set(o.id, o);
    }

    // messages
    const messages = await this.getChats();
    for (const m of messages) {
      if (!this.lastMessages.has(m.id)) {
        this.emit('newMessage', m);
        this.lastMessages.set(m.id, m);
      }
    }
  }
}
