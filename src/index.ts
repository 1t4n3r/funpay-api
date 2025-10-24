import { FunPayClient } from './FunPayClient.js';

export * from './types/index.js';
export { FunPayClient } from './FunPayClient.js';

const funpay = new FunPayClient({ goldenKey: 'lonaf953z6rhxpj3g8614l5gf96a5o2j' });

async function a() {
  const i = await funpay.getOrders();

  return i;
}

a();
