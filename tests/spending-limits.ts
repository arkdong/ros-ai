import type { TestContext } from 'node:test';

/** Spending limits are off until a person turns them on. A test of the limits turns them on for its own run. */
export function spendingLimitsOn(t: TestContext): void {
  const before = process.env.ROS_SPENDING_LIMITS;
  process.env.ROS_SPENDING_LIMITS = 'on';
  t.after(() => { if (before === undefined) delete process.env.ROS_SPENDING_LIMITS; else process.env.ROS_SPENDING_LIMITS = before; });
}
