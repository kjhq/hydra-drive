import { app } from "electron";
import path from "node:path";
import {
  recoverRestores as recover,
  restoreTransaction as transact,
  type RestoreChange,
} from "./restore-transaction";
export type { RestoreChange } from "./restore-transaction";
const root = () => path.join(app.getPath("userData"), "drive-restore-journals");
export const restoreTransaction = (
  key: string,
  changes: RestoreChange[],
  guard: () => Promise<void>
) => transact(key, changes, guard, root());
export const recoverRestores = (key: string, guard: () => Promise<void>) =>
  recover(key, guard, root());
