export declare const BACKGROUND_STATUS_HEARTBEAT_MS: number;
export interface BackgroundStatusTeammate {
    id: string;
    label: string;
    status: string;
    phase?: string;
    lastActivityAt?: number;
}
export interface BackgroundStatusBashJob {
    id: string;
    command: string;
    status: "running" | "stopping";
    startedAt: number;
}
export interface BackgroundStatusSnapshot {
    teammates: BackgroundStatusTeammate[];
    bashJobs: BackgroundStatusBashJob[];
}
export interface BackgroundStatusHeartbeatMessage {
    content: string;
    details: {
        monitoringOnly: true;
        completion: false;
        observedAt: number;
        teammateIds: string[];
        bashJobIds: string[];
    };
}
interface BackgroundStatusHeartbeatScheduler {
    setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}
export interface BackgroundStatusHeartbeatOptions {
    capture: () => BackgroundStatusSnapshot;
    deliver: (message: BackgroundStatusHeartbeatMessage) => boolean;
    intervalMs?: number;
    now?: () => number;
    scheduler?: BackgroundStatusHeartbeatScheduler;
}
export interface BackgroundStatusHeartbeatController {
    markSessionActive: () => void;
    markSessionSettled: () => void;
    setIntervalMs: (intervalMs: number) => void;
    refresh: () => void;
    reset: () => void;
}
export declare function buildBackgroundStatusHeartbeatMessage(input: BackgroundStatusSnapshot, observedAt?: number): BackgroundStatusHeartbeatMessage;
export declare function createBackgroundStatusHeartbeat(options: BackgroundStatusHeartbeatOptions): BackgroundStatusHeartbeatController;
export {};
