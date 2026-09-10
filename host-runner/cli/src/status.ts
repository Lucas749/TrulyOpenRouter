import { printStatus, type DashboardOptions } from "./dashboard.js";

export async function status(options: DashboardOptions = {}): Promise<void> {
  await printStatus(options);
}
