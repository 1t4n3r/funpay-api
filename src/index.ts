import { FunPayClient } from './FunPayClient.js';

export * from './types/index.js';
export { FunPayClient } from './FunPayClient.js';

const funpay = new FunPayClient({ goldenKey: '4gnx1zfzhnlqlz1zcbcqsl8hi08rc950' });

async function a() {
  const i = await funpay.getChats();

  return console.log(i);
}

a();
