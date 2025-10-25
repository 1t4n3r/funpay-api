import { IProfile } from "./Profile";

export interface IChat {
  id: number;
  author: IProfile | null;
  date: string;
}
