import type { IProfile } from './Profile'

export interface IChatMessage {
  author: IProfile | null;
  text: string;
  date: string;
}