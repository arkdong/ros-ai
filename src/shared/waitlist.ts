export interface WaitlistCount {
  /** Unique email submissions; addresses have not been verified. */
  count: number;
}

export interface WaitlistJoined extends WaitlistCount {
  joined: true;
}
