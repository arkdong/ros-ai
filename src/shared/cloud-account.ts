/** This computer's ros.ai cloud sign-in, as the Agents page shows it. */
export type CloudAccountStatus = {
  available: boolean;
  state: 'signed-out' | 'waiting' | 'signed-in' | 'expired';
  email?: string;
  verificationUrl?: string;
  connectionId?: string;
  leftTodayUsd?: number;
  dailyUsd?: number;
  error?: string;
};
