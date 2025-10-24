import { IProfile } from './Profile.js';

export interface IOrder {
  date: string;
  id: string;
  buyer: IProfile;
  status: string;
  price: number;
  amount: number;
}
