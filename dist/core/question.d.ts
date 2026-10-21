export declare enum QuestionStatus {
    DRAFT = "draft",
    PENDING = "pending",
    ANSWERED = "answered",
    EXPIRED = "expired",
    CANCELLED = "cancelled"
}
export interface QuestionCreateParams {
    text: string;
    options: string[];
    projectId: string;
    timeoutMs: number;
}
export interface AcceptResult {
    accepted: boolean;
    existingAnswer?: string;
}
export declare class Question {
    private _status;
    private _id?;
    private _answer?;
    private _answeredVia?;
    private _askedAt?;
    private _cancelReason?;
    readonly text: string;
    readonly options: string[];
    readonly projectId: string;
    readonly timeoutMs: number;
    private constructor();
    static create(params: QuestionCreateParams): Question;
    get status(): QuestionStatus;
    get id(): number | undefined;
    get answer(): string | undefined;
    get answeredVia(): 'phone' | 'terminal' | undefined;
    get askedAt(): number | undefined;
    markPending(id: number): void;
    accept(answer: string, source: 'phone' | 'terminal'): AcceptResult;
    cancel(reason?: string): void;
    expire(): void;
}
//# sourceMappingURL=question.d.ts.map