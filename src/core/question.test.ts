import { describe, it, expect } from 'vitest';
import { Question, QuestionStatus } from './question.js';

describe('core/question', () => {
  describe('Question.create()', () => {
    it('creates a question in draft status', () => {
      const q = Question.create({
        text: 'test question',
        options: ['A', 'B'],
        projectId: 'test-project',
        timeoutMs: 45000
      });
      expect(q.status).toBe(QuestionStatus.DRAFT);
      expect(q.text).toBe('test question');
      expect(q.options).toEqual(['A', 'B']);
    });
  });

  describe('state transitions', () => {
    it('transitions from draft to pending', () => {
      const q = Question.create({
        text: 'test',
        options: [],
        projectId: 'test',
        timeoutMs: 45000
      });
      q.markPending(1);
      expect(q.status).toBe(QuestionStatus.PENDING);
      expect(q.id).toBe(1);
    });

    it('transitions from pending to answered', () => {
      const q = Question.create({
        text: 'test',
        options: [],
        projectId: 'test',
        timeoutMs: 45000
      });
      q.markPending(1);
      const result = q.accept('answer text', 'phone');
      expect(result.accepted).toBe(true);
      expect(q.status).toBe(QuestionStatus.ANSWERED);
      expect(q.answer).toBe('answer text');
      expect(q.answeredVia).toBe('phone');
    });

    it('rejects second answer (first-write wins)', () => {
      const q = Question.create({
        text: 'test',
        options: [],
        projectId: 'test',
        timeoutMs: 45000
      });
      q.markPending(1);
      q.accept('first answer', 'phone');
      
      const result = q.accept('second answer', 'terminal');
      expect(result.accepted).toBe(false);
      expect(result.existingAnswer).toBe('first answer');
      expect(q.answer).toBe('first answer');
    });

    it('cannot transition from answered to pending', () => {
      const q = Question.create({
        text: 'test',
        options: [],
        projectId: 'test',
        timeoutMs: 45000
      });
      q.markPending(1);
      q.accept('answer', 'phone');
      
      expect(() => q.markPending(2)).toThrow();
    });

    it('can transition to cancelled from pending', () => {
      const q = Question.create({
        text: 'test',
        options: [],
        projectId: 'test',
        timeoutMs: 45000
      });
      q.markPending(1);
      q.cancel('no longer needed');
      expect(q.status).toBe(QuestionStatus.CANCELLED);
    });

    it('can transition to expired', () => {
      const q = Question.create({
        text: 'test',
        options: [],
        projectId: 'test',
        timeoutMs: 45000
      });
      q.markPending(1);
      q.expire();
      expect(q.status).toBe(QuestionStatus.EXPIRED);
    });
  });
});
