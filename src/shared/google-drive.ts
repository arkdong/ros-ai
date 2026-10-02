export type GoogleDriveStatus = {
  provider:'google-drive'; configured:boolean; connected:boolean; available:boolean;
  state:'needs-setup'|'disconnected'|'connected'|'reconnect-required'; detail:string;
  scope:string; scopeDescription:string; callbackUri:string; connectedAt?:string;
  configurationSource:'local-private-file'|'environment'|'missing';
  setup:{missing:string[];steps:string[];documentation:{title:string;url:string}[]};
  lastError?:string;
};
export type GoogleDriveFile = {id:string;name:string;mimeType:string;size?:number;modifiedTime?:string;version?:string;md5Checksum?:string;canDownload:boolean;url:string};
export type GoogleDriveFiles = {files:GoogleDriveFile[];nextPageToken?:string};
export type GoogleDriveCapture = {provider:'google-drive';fileId:string;name:string;mimeType:string;modifiedTime?:string;version?:string;md5Checksum?:string;contentHash:string;capturedAt:string;permission:'read-only explicit CSV capture';url:string};
