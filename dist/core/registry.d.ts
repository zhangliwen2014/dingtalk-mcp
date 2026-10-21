import { Question } from './question.js';
export declare class Registry {
    private nextId;
    private questions;
    private filePath;
    readonly instanceId: string;
    constructor(configDir?: string);
    allocateId(): number;
    add(params: {
        id: number;
        text: string;
        target: string;
    }): Question;
    get(id: number): Question | undefined;
    listPending(): Question[];
    save(): void;
    load(): void;
}
//# sourceMappingURL=registry.d.ts.map