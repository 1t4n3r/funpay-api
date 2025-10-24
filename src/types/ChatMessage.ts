export interface IChatMessage {
  id: number;
  orderId?: number;
  author?: string;
  message?: string;
  timestamp?: string;
}
