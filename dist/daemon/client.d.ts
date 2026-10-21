export declare class IpcClient {
    private socket;
    private ipcEndpoint;
    private requestId;
    private pendingRequests;
    private buffer;
    constructor(ipcEndpoint: string);
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    request(method: string, params: any): Promise<any>;
    private handleData;
}
//# sourceMappingURL=client.d.ts.map