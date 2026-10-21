export var QuestionStatus;
(function (QuestionStatus) {
    QuestionStatus["DRAFT"] = "draft";
    QuestionStatus["PENDING"] = "pending";
    QuestionStatus["ANSWERED"] = "answered";
    QuestionStatus["EXPIRED"] = "expired";
    QuestionStatus["CANCELLED"] = "cancelled";
})(QuestionStatus || (QuestionStatus = {}));
export class Question {
    _status = QuestionStatus.DRAFT;
    _id;
    _answer;
    _answeredVia;
    _askedAt;
    _cancelReason;
    text;
    options;
    projectId;
    timeoutMs;
    constructor(params) {
        this.text = params.text;
        this.options = params.options;
        this.projectId = params.projectId;
        this.timeoutMs = params.timeoutMs;
    }
    static create(params) {
        return new Question(params);
    }
    get status() {
        return this._status;
    }
    get id() {
        return this._id;
    }
    get answer() {
        return this._answer;
    }
    get answeredVia() {
        return this._answeredVia;
    }
    get askedAt() {
        return this._askedAt;
    }
    markPending(id) {
        if (this._status !== QuestionStatus.DRAFT) {
            throw new Error(`Cannot transition to pending from ${this._status}`);
        }
        this._id = id;
        this._status = QuestionStatus.PENDING;
        this._askedAt = Date.now();
    }
    accept(answer, source) {
        if (this._status === QuestionStatus.ANSWERED) {
            return {
                accepted: false,
                existingAnswer: this._answer
            };
        }
        if (this._status !== QuestionStatus.PENDING) {
            throw new Error(`Cannot accept answer in status ${this._status}`);
        }
        this._answer = answer;
        this._answeredVia = source;
        this._status = QuestionStatus.ANSWERED;
        return { accepted: true };
    }
    cancel(reason) {
        if (this._status !== QuestionStatus.PENDING) {
            throw new Error(`Cannot cancel from status ${this._status}`);
        }
        this._cancelReason = reason;
        this._status = QuestionStatus.CANCELLED;
    }
    expire() {
        if (this._status !== QuestionStatus.PENDING) {
            throw new Error(`Cannot expire from status ${this._status}`);
        }
        this._status = QuestionStatus.EXPIRED;
    }
}
//# sourceMappingURL=question.js.map