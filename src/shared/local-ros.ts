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
};
