import * as fs from 'node:fs';
import * as path from 'node:path';
import * as paths from '../platform/paths.js';
import { Question, QuestionStatus } from './question.js';
import * as identity from '../platform/identity.js';

const STATE_FILE = 'state.json';

interface PersistedState {
  nextId: number;
  questions: PersistedQuestion[];
}

interface PersistedQuestion {
  id: number;
  text: string;
  status: QuestionStatus;
  askedAt?: number;
  answer?: string;
  answeredVia?: 'phone' | 'terminal';
}

export class Registry {
  private nextId = 1;
  private questions: Map<number, Question> = new Map();
  private filePath: string;
  readonly instanceId: string;

  constructor(configDir?: string) {
    const dir = configDir || paths.home();
    this.filePath = path.join(dir, STATE_FILE);
    this.instanceId = identity.instanceId();
  }

  allocateId(): number {
    const id = this.nextId;
    this.nextId++;
    return id;
  }

  add(params: { id: number; text: string; target: string }): Question {
    const question = Question.create({
      text: params.text,
      options: [],
      projectId: '',
      timeoutMs: 0,
    });
    question.markPending(params.id);
    this.questions.set(params.id, question);
    return question;
  }

  get(id: number): Question | undefined {
    return this.questions.get(id);
  }

  listPending(): Question[] {
    return Array.from(this.questions.values()).filter(
      (q) => q.status === QuestionStatus.PENDING
    );
  }

  save(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    const state: PersistedState = {
      nextId: this.nextId,
      questions: Array.from(this.questions.values()).map((q) => ({
        id: q.id!,
        text: q.text,
        status: q.status,
        askedAt: q.askedAt,
        answer: q.answer,
        answeredVia: q.answeredVia,
      })),
    };

    // Write-then-rename: a crash mid-save can never leave a truncated state file.
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  load(): void {
    let data: string;
    try {
      data = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return; // No state file yet: start fresh.
    }

    try {
      const state: PersistedState = JSON.parse(data);
      this.nextId = state.nextId;
      this.questions.clear();

      for (const pq of state.questions) {
        const q = Question.create({
          text: pq.text,
          options: [],
          projectId: '',
          timeoutMs: 0,
        });

        if (pq.status === QuestionStatus.PENDING) {
          q.markPending(pq.id);
        } else if (pq.status === QuestionStatus.ANSWERED) {
          q.markPending(pq.id);
          if (pq.answer && pq.answeredVia) {
            q.accept(pq.answer, pq.answeredVia);
          }
        }

        this.questions.set(pq.id, q);
      }
    } catch {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dest = `${this.filePath}.corrupt-${stamp}`;
      try {
        fs.renameSync(this.filePath, dest);
      } catch {
        /* best effort */
      }
      console.warn(
        `state.json was unreadable and could not be parsed; preserved at ${dest}, starting fresh.`
      );
      this.questions.clear();
      this.nextId = 1;
    }
  }
}
