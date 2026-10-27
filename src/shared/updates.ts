/** What ros.ai knows about newer versions of itself, as the Update button and Settings › General show it. */
export type UpdateStatus = {
  /** The version running now. */
  version: string;
  /** How this copy updates: the Mac app replaces itself, a git checkout pulls and restarts, anything else shows the steps. */
  install: 'app' | 'source' | 'manual';
  /** False when ROS_UPDATE_URL=off: ros.ai never looks. */
  enabled: boolean;
  /** Looks by itself at start and every six hours; Settings can turn this off. */
  auto: boolean;
  checking: boolean;
  checkedAt?: string;
  /** The newest release, when it is newer than this copy. */
  latest?: { version: string; url: string; publishedAt?: string };
  state: 'current' | 'available' | 'downloading' | 'ready' | 'installing';
  doneBytes?: number;
  totalBytes?: number;
  /** What the Update button does: restart into the downloaded app, update this checkout and restart, or show the steps. */
  action?: 'restart' | 'update' | 'steps';
  /** Why ros.ai can't update itself here, when it can't. */
  note?: string;
  /** The commands that update this copy by hand. */
  commands?: string;
  error?: string;
};

/** What the server tells the Mac app's window process once a checked download is ready to replace ros.ai.app. */
export type UpdateInstallMessage = { type: 'ros-update-install'; version: string; app: string };
