import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DaemonServer } from './server.js';
import { FakeTransport } from '../transport/fake-transport.js';
import { Switch } from '../core/switch.js';
import { Registry } from '../core/registry.js';
import { QuestionStatus } from '../core/question.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('DaemonServer', () => {
  let tempDir: string;
  let transport: FakeTransport;
  let switchControl: Switch;
  let registry: Registry;
  let server: DaemonServer;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtmcp-daemon-test-'));
    transport = new FakeTransport();
    switchControl = new Switch(tempDir);
    registry = new Registry(tempDir);

    server = new DaemonServer({
      transport,
      switch: switchControl,
      registry,
      ipcEndpoint: path.join(tempDir, 'test.sock'),
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('hello', () => {
    it('returns version and instance info', async () => {
      const result = await server.rpc('hello', { version: '1.0.0' });
      expect(result).toMatchObject({
        ok: true,
        version: expect.any(String),
      });
    });
  });

  describe('ask (disabled)', () => {
    it('returns blocked when switch is off', async () => {
      await switchControl.set(false);

      const result = await server.rpc('ask', {
        question: 'Test question?',
        target: 'self',
      });

      expect(result).toMatchObject({
        ok: true,
        status: 'blocked',
        reason: 'disabled',
      });
      expect(transport.sentMessages).toHaveLength(0);
    });
  });

  describe('ask (enabled, single question)', () => {
    beforeEach(async () => {
      await switchControl.set(true);
      transport.setResolveTargetResult('user123');
    });

    it('allocates ID, sends to DingTalk, returns pending', async () => {
      const result = await server.rpc('ask', {
        question: '保留备份还是删除?',
        target: 'self',
      });

      expect(result).toMatchObject({
        ok: true,
        status: 'pending',
        id: 1,
      });

      expect(transport.sentMessages).toHaveLength(1);
      expect(transport.sentMessages[0]).toMatchObject({
        target: 'user123',
        text: expect.stringContaining('#Q1: 保留备份还是删除?'),
      });
    });

    it('allocates monotonic IDs', async () => {
      const r1 = await server.rpc('ask', { question: 'Q1?', target: 'self' });
      const r2 = await server.rpc('ask', { question: 'Q2?', target: 'self' });

      expect(r1.id).toBe(1);
      expect(r2.id).toBe(2);
      expect(transport.sentMessages).toHaveLength(2);
    });
  });

  describe('check', () => {
    beforeEach(async () => {
      await switchControl.set(true);
      transport.setResolveTargetResult('user123');
    });

    it('returns answered when question has answer', async () => {
      const askResult = await server.rpc('ask', {
        question: 'Test?',
        target: 'self',
      });
      const id = askResult.id;

      await server.rpc('reply', { text: `#Q${id}: 答案` });

      const checkResult = await server.rpc('check', { id });
      expect(checkResult).toMatchObject({
        ok: true,
        status: 'answered',
        answer: '答案',
        answeredVia: 'phone',
      });
    });

    it('returns pending when no answer yet', async () => {
      const askResult = await server.rpc('ask', {
        question: 'Test?',
        target: 'self',
      });

      const checkResult = await server.rpc('check', { id: askResult.id });
      expect(checkResult).toMatchObject({
        ok: true,
        status: 'pending',
      });
    });
  });

  describe('cancel', () => {
    beforeEach(async () => {
      await switchControl.set(true);
      transport.setResolveTargetResult('user123');
    });

    it('cancels pending question', async () => {
      const askResult = await server.rpc('ask', {
        question: 'Test?',
        target: 'self',
      });

      const cancelResult = await server.rpc('cancel', { id: askResult.id });
      expect(cancelResult).toMatchObject({
        ok: true,
        status: 'cancelled',
      });

      const checkResult = await server.rpc('check', { id: askResult.id });
      expect(checkResult.status).toBe('cancelled');
    });
  });

  describe('status', () => {
    it('returns switch state and pending count', async () => {
      await switchControl.set(true);
      transport.setResolveTargetResult('user123');

      await server.rpc('ask', { question: 'Q1?', target: 'self' });
      await server.rpc('ask', { question: 'Q2?', target: 'self' });

      const result = await server.rpc('status', {});
      expect(result).toMatchObject({
        ok: true,
        enabled: true,
        pendingCount: 2,
      });
    });
  });

  describe('set_switch', () => {
    it('toggles switch on/off', async () => {
      await server.rpc('set_switch', { enabled: true });
      expect(await switchControl.get()).toBe(true);

      await server.rpc('set_switch', { enabled: false });
      expect(await switchControl.get()).toBe(false);
    });
  });

  describe('ingest (phone reply)', () => {
    beforeEach(async () => {
      await switchControl.set(true);
      transport.setResolveTargetResult('user123');
    });

    it('routes reply with explicit ID to correct question', async () => {
      await server.rpc('ask', { question: 'Q1?', target: 'self' });
      const r2 = await server.rpc('ask', { question: 'Q2?', target: 'self' });

      await server.rpc('ingest', { text: `#Q${r2.id}: 选Q2` });

      const check = await server.rpc('check', { id: r2.id });
      expect(check).toMatchObject({
        ok: true,
        status: 'answered',
        answer: '选Q2',
      });
    });

    it('routes reply to single pending question', async () => {
      await server.rpc('ask', { question: 'Only one?', target: 'self' });

      await server.rpc('ingest', { text: '答案' });

      const check = await server.rpc('check', { id: 1 });
      expect(check).toMatchObject({
        ok: true,
        status: 'answered',
        answer: '答案',
      });
    });

    it('handles #开 command', async () => {
      await switchControl.set(false);

      await server.rpc('ingest', { text: '#开' });

      expect(await switchControl.get()).toBe(true);
    });

    it('handles #关 command', async () => {
      await switchControl.set(true);

      await server.rpc('ingest', { text: '#关' });

      expect(await switchControl.get()).toBe(false);
    });

    it('handles #忽略 command', async () => {
      const askResult = await server.rpc('ask', {
        question: 'Test?',
        target: 'self',
      });

      await server.rpc('ingest', { text: `#忽略${askResult.id}` });

      const check = await server.rpc('check', { id: askResult.id });
      expect(check.status).toBe('cancelled');
    });
  });
});
