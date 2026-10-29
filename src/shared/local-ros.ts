/** ROS on this computer, as the ROS agent page shows it. */
export type LocalRosStatus = {
  /** False on a computer ros.ai has no engine build for. */
  supported: boolean;
  state: 'not-downloaded' | 'downloading' | 'starting' | 'ready' | 'failed';
  /** The model file, e.g. "NVIDIA-Nemotron-3-Nano-4B-Q4_K_M.gguf". */
  model?: string;
  doneBytes?: number;
  totalBytes?: number;
  connectionId?: string;
  error?: string;
};
