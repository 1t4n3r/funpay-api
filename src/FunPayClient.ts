import * as cheerio from 'cheerio';
import { EventEmitter } from 'events';
import type { IApiConfig, IProfile, IOrder, IChatMessage } from '@/types';

const DEFAULT_BASE = 'https://funpay.com';
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
  private lastOrders = new Map<number, IOrder>();
  private lastMessages = new Map<number, IChatMessage>();
  private lastBalance = 0;
  private polling = false;

  constructor(config: IApiConfig) {
    super();
    this.goldenKey = config.goldenKey;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT;
    this.pollingIntervalMs = config.pollingIntervalMs ?? 15000;
  }

  // ---------- helpers ----------
  private headers(extra?: Record<string, string>) {
    return {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      'Cookie': `golden_key=${this.goldenKey}`,
      ...(extra ?? {}),
    };
  }

  private async fetchHtml(path: string): Promise<string> {
    const url = `${this.baseUrl}${path}`;
    const res = await timeoutFetch(url, { headers: this.headers() }, this.timeoutMs);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} (${url})`);
    return await res.text();
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
  async getProfile(): Promise<IProfile> {
    const html = await this.fetchHtml('/');
    const $ = cheerio.load(html);

    const name = $('.user-link__name').first().text().trim() || $('.topbar .user-link').text().trim();
    const avatar = $('.user-link__avatar img').attr('src') ?? undefined;
    const balanceText = $('.balance, .profile__balance').first().text().trim();
    const balance = balanceText ? parseFloat(balanceText.replace(/[^\d,.-]/g, '').replace(',', '.')) : undefined;
    const ratingText = $('.rating').first().text().trim();
    const rating = ratingText ? parseFloat(ratingText.replace(',', '.')) : undefined;

    return {
      name: name || '',
      avatar,
      balance,
      rating,
      link: name ? `${this.baseUrl}/users/${encodeURIComponent(name)}` : undefined,
    };
  }

  async getBalance(): Promise<number> {
    // try dedicated page, fallback to main profile parse
    try {
      const html = await this.fetchHtml('/account/finance');
      const $ = cheerio.load(html);
      const t = $('.balance, .finance__balance').first().text() || '';
      const v = parseFloat(t.replace(/[^\d,.-]/g, '').replace(',', '.')) || 0;
      return v;
    } catch {
      const p = await this.getProfile();
      return p.balance ?? 0;
    }
  }

  async getOrders(): Promise<IOrder[]> {
    const html = await this.fetchHtml('/orders/trade');
    const $ = cheerio.load(html);
    const orders: IOrder[] = [];

    // generic selector tolerant to markup changes
    $('.tc-item').each((_, element) => {
      const el = $(element);

      const date = el.find('.tc-date-time').text().trim();
      const id = el.find('.tc-order').text().trim();
      const buyer = el.find('span.pseudo-a').attr('data-href') || '';
      const status = el.find('.tc-status').text().trim();
      const price = parseFloat(el.find('.tc-price').text().trim());
      const descText = el.find('.order-desc').text().trim();
      const amountMatch = descText.match(/\d+/);
      const amount = amountMatch ? parseInt(amountMatch[0], 10) : 0;

      orders.push({ date, id, buyer, status, price, amount });
    });

    return orders;
  }

  async acceptOrder(orderId: number): Promise<boolean> {
    const res = await this.postForm('/orders/accept', { id: String(orderId) });
    return res.ok;
  }

  async cancelOrder(orderId: number, reason = 'cancel'): Promise<boolean> {
    const res = await this.postForm('/orders/cancel', { id: String(orderId), reason });
    return res.ok;
  }

  async markAsDelivered(orderId: number): Promise<boolean> {
    const res = await this.postForm('/orders/deliver', { id: String(orderId) });
    return res.ok;
  }

  async changeOfferPrice(offerId: number, newPrice: number): Promise<boolean> {
    const res = await this.postForm('/trade/offer/update', { id: String(offerId), price: String(newPrice) });
    return res.ok;
  }

  async changeOfferAvailability(offerId: number, available: boolean): Promise<boolean> {
    const res = await this.postForm('/trade/offer/toggle', { id: String(offerId), available: available ? '1' : '0' });
    return res.ok;
  }

  async getChats(): Promise<IChatMessage[]> {
    const html = await this.fetchHtml('/chats');
    const $ = cheerio.load(html);
    const res: IChatMessage[] = [];
    $('.chat, .chat-item, [data-chat-id]').each((_, el) => {
      const $el = $(el);
      const idAttr = $el.attr('data-id') ?? $el.attr('data-chat-id');
      const id = idAttr ? parseInt(idAttr, 10) : undefined;
      if (!id) return;
      const author = $el.find('.chat__name, .author').first().text().trim() || undefined;
      const message = $el.find('.chat__msg, .last-message').first().text().trim() || undefined;
      const timestamp = $el.find('.chat__date, .time').first().text().trim() || undefined;
      const orderIdAttr = $el.find('.chat__order, .order-id').attr('data-id') ?? undefined;
      const orderId = orderIdAttr ? parseInt(orderIdAttr, 10) : undefined;
      res.push({ id, orderId, author, message, timestamp });
    });
    return res;
  }

  async getChatMessages(orderId: number): Promise<IChatMessage[]> {
    const html = await this.fetchHtml(`/chats/${orderId}`);
    const $ = cheerio.load(html);
    const messages: IChatMessage[] = [];
    $('.message, .chat-message').each((_, el) => {
      const $el = $(el);
      const idAttr = $el.attr('data-id') ?? undefined;
      const id = idAttr ? parseInt(idAttr, 10) : undefined;
      if (!id) return;
      const author = $el.find('.message__author, .author').first().text().trim() || undefined;
      const message = $el.find('.message__text, .text').first().text().trim() || undefined;
      const timestamp = $el.find('.message__time, .time').first().text().trim() || undefined;
      messages.push({ id, orderId, author, message, timestamp });
    });
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
      const [orders, msgs, bal] = await Promise.all([this.getOrders(), this.getChats(), this.getBalance()]);
      orders.forEach((o) => this.lastOrders.set(o.id, o));
      msgs.forEach((m) => this.lastMessages.set(m.id, m));
      this.lastBalance = bal;
    } catch {
      // ignore init errors
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
