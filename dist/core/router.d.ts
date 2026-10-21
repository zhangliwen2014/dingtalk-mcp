import { Question } from './question.js';
export type RouteResult = {
    kind: 'command';
    cmd: 'enable' | 'disable' | 'cancel';
    targetId?: number;
} | {
    kind: 'answer';
    id: number;
    text: string;
} | {
    kind: 'ambiguous';
};
export declare function route(text: string, pendingQuestions: Question[]): RouteResult;
//# sourceMappingURL=router.d.ts.map