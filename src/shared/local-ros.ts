/** ROS on this computer, as the ROS agent page and the download chip show it. */
export type LocalRosStatus = {
  /** False on a computer ros.ai has no engine build for. */
  supported: boolean;
  state: 'not-downloaded' | 'downloading' | 'starting' | 'ready' | 'failed';
  /** The model file, e.g. "NVIDIA-Nemotron-3-Nano-4B-Q4_K_M.gguf". */
  model?: string;
  doneBytes?: number;
  totalBytes?: number;
  /** While downloading: how fast, over the last few seconds, for the time left. */
  bytesPerSecond?: number;
  /** While downloading: what the download is waiting for, such as the network after a dropped connection. */
  note?: string;
  connectionId?: string;
  error?: string;
  /** The model this version of ros.ai wants, while ROS runs another from disk: on offer (updates are not automatic, the
   * person stopped it, or it failed), coming in the background, or being switched to. */
  update?: { state: 'available' | 'downloading' | 'switching'; model: string; doneBytes?: number; totalBytes?: number; bytesPerSecond?: number; note?: string; error?: string };
};
