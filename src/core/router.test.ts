import { describe, it, expect } from 'vitest';
import { route, RouteResult } from './router.js';
import { Question, QuestionStatus } from './question.js';

describe('core/router', () => {
  function makePending(id: number): Question {
    const q = Question.create({
      text: `question ${id}`,
      options: [],
      projectId: 'test',
      timeoutMs: 45000
    });
    q.markPending(id);
    return q;
  }

  describe('rule 1: reserved commands', () => {
    it('recognizes #开 as command', () => {
      const result = route('#开', []);
      expect(result.kind).toBe('command');
      if (result.kind === 'command') {
        expect(result.cmd).toBe('enable');
      }
    });

    it('recognizes #关 as command', () => {
      const result = route('#关', []);
      expect(result.kind).toBe('command');
      if (result.kind === 'command') {
        expect(result.cmd).toBe('disable');
      }
    });

    it('recognizes #忽略3 as cancel command', () => {
      const result = route('#忽略3', []);
      expect(result.kind).toBe('command');
      if (result.kind === 'command') {
        expect(result.cmd).toBe('cancel');
        expect(result.targetId).toBe(3);
      }
    });
  });

  describe('rule 2: explicit question ID', () => {
    it('routes #Q3: answer to question 3', () => {
      const pending = [makePending(3), makePending(5)];
      const result = route('#Q3: 保留备份', pending);
      expect(result.kind).toBe('answer');
      if (result.kind === 'answer') {
        expect(result.id).toBe(3);
        expect(result.text).toBe('保留备份');
      }
    });

    it('handles #Q10: with spaces', () => {
      const pending = [makePending(10)];
      const result = route('#Q10: 用方案 B', pending);
      expect(result.kind).toBe('answer');
      if (result.kind === 'answer') {
        expect(result.id).toBe(10);
        expect(result.text).toBe('用方案 B');
      }
    });
  });

  describe('rule 3: single pending auto-assign', () => {
    it('auto-assigns when exactly one pending', () => {
      const pending = [makePending(7)];
      const result = route('随便回答', pending);
      expect(result.kind).toBe('answer');
      if (result.kind === 'answer') {
        expect(result.id).toBe(7);
        expect(result.text).toBe('随便回答');
      }
    });
  });

  describe('rule 4: multiple pending ambiguous', () => {
    it('returns ambiguous when multiple pending and no marker', () => {
      const pending = [makePending(1), makePending(2)];
      const result = route('不确定', pending);
      expect(result.kind).toBe('ambiguous');
    });

    it('does not return ambiguous when command prefix present', () => {
      const pending = [makePending(1), makePending(2)];
      const result = route('#开', pending);
      expect(result.kind).toBe('command');
    });

    it('does not return ambiguous when explicit ID present', () => {
      const pending = [makePending(1), makePending(2)];
      const result = route('#Q1: 答案', pending);
      expect(result.kind).toBe('answer');
    });
  });
});
