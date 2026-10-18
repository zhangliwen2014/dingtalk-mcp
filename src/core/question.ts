export enum QuestionStatus {
  DRAFT = 'draft',
  PENDING = 'pending',
  ANSWERED = 'answered',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled'
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

export class Question {
  private _status: QuestionStatus = QuestionStatus.DRAFT;
  private _id?: number;
  private _answer?: string;
  private _answeredVia?: 'phone' | 'terminal';
  private _askedAt?: number;
  private _cancelReason?: string;

  readonly text: string;
  readonly options: string[];
  readonly projectId: string;
  readonly timeoutMs: number;

  private constructor(params: QuestionCreateParams) {
    this.text = params.text;
    this.options = params.options;
    this.projectId = params.projectId;
    this.timeoutMs = params.timeoutMs;
  }

  static create(params: QuestionCreateParams): Question {
    return new Question(params);
  }

  get status(): QuestionStatus {
    return this._status;
  }

  get id(): number | undefined {
    return this._id;
  }

  get answer(): string | undefined {
    return this._answer;
  }

  get answeredVia(): 'phone' | 'terminal' | undefined {
    return this._answeredVia;
  }

  get askedAt(): number | undefined {
    return this._askedAt;
  }

  markPending(id: number): void {
    if (this._status !== QuestionStatus.DRAFT) {
      throw new Error(`Cannot transition to pending from ${this._status}`);
    }
    this._id = id;
    this._status = QuestionStatus.PENDING;
    this._askedAt = Date.now();
  }

  accept(answer: string, source: 'phone' | 'terminal'): AcceptResult {
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

  cancel(reason?: string): void {
    if (this._status !== QuestionStatus.PENDING) {
      throw new Error(`Cannot cancel from status ${this._status}`);
    }
    this._cancelReason = reason;
    this._status = QuestionStatus.CANCELLED;
  }

  expire(): void {
    if (this._status !== QuestionStatus.PENDING) {
      throw new Error(`Cannot expire from status ${this._status}`);
    }
    this._status = QuestionStatus.EXPIRED;
  }
}
