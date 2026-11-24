export const STOP_RECOVERY_CAPABILITY = 'dsh-knot/stopRecovery';
export const STOP_RECOVERY_TURN_ID = 'dsh-knot/turnId';
export const STOP_RECOVERY_REQUEST = '_dsh-knot/stop-run';

export interface StopRecoveryParams {
  sessionId: string;
  turnId: string;
}

export interface StopRecoveryResponse {
  stopped: true;
}
