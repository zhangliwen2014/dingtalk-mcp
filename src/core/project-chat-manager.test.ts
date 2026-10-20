import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProjectChatManager } from './project-chat-manager.js';
import * as proc from '../platform/proc.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('../platform/proc.js');

describe('core/project-chat-manager', () => {
  let manager: ProjectChatManager;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtmcp-pcm-test-'));
    manager = new ProjectChatManager(tempDir);
    vi.clearAllMocks();
  });

  describe('getOrCreateChat', () => {
    it('creates new chat when not exists', async () => {
      vi.mocked(proc.run)
        .mockResolvedValueOnce({ code: 0, stdout: '{"chats":[]}', stderr: '' })
        .mockResolvedValueOnce({
          code: 0,
          stdout: '{"success":true,"result":{"openConversationId":"cid123"}}',
          stderr: '',
        });

      const chat = await manager.getOrCreateChat('proj-a', '官网重构');

      expect(chat.projectId).toBe('proj-a');
      expect(chat.projectTitle).toBe('官网重构');
      expect(chat.chatId).toBe('cid123');
      expect(chat.questionIds).toEqual([]);
    });

    it('reuses existing chat when found', async () => {
      vi.mocked(proc.run).mockResolvedValueOnce({
        code: 0,
        stdout: '{"chats":[{"name":"官网重构问答","openConversationId":"cid456"}]}',
        stderr: '',
      });

      const chat = await manager.getOrCreateChat('proj-b', '官网重构');

      expect(chat.chatId).toBe('cid456');
      expect(proc.run).toHaveBeenCalledTimes(1);
    });

    it('returns cached chat on second call', async () => {
      vi.mocked(proc.run)
        .mockResolvedValueOnce({ code: 0, stdout: '{"chats":[]}', stderr: '' })
        .mockResolvedValueOnce({
          code: 0,
          stdout: '{"success":true,"result":{"openConversationId":"cid789"}}',
          stderr: '',
        });

      const chat1 = await manager.getOrCreateChat('proj-c', '数据分析');
      const chat2 = await manager.getOrCreateChat('proj-c', '数据分析');

      expect(chat1.chatId).toBe(chat2.chatId);
      expect(proc.run).toHaveBeenCalledTimes(2);
    });
  });

  describe('getProjectByChatId', () => {
    it('finds project by chat ID', async () => {
      vi.mocked(proc.run)
        .mockResolvedValueOnce({ code: 0, stdout: '{"chats":[]}', stderr: '' })
        .mockResolvedValueOnce({
          code: 0,
          stdout: '{"success":true,"result":{"openConversationId":"cidABC"}}',
          stderr: '',
        });

      await manager.getOrCreateChat('proj-d', '移动端');
      const found = manager.getProjectByChatId('cidABC');

      expect(found).toBeDefined();
      expect(found?.projectId).toBe('proj-d');
    });

    it('returns undefined for unknown chat ID', () => {
      const found = manager.getProjectByChatId('unknown');
      expect(found).toBeUndefined();
    });
  });

  describe('listProjectChats', () => {
    it('lists all project chats', async () => {
      vi.mocked(proc.run)
        .mockResolvedValueOnce({ code: 0, stdout: '{"chats":[]}', stderr: '' })
        .mockResolvedValueOnce({
          code: 0,
          stdout: '{"success":true,"result":{"openConversationId":"cid1"}}',
          stderr: '',
        })
        .mockResolvedValueOnce({ code: 0, stdout: '{"chats":[]}', stderr: '' })
        .mockResolvedValueOnce({
          code: 0,
          stdout: '{"success":true,"result":{"openConversationId":"cid2"}}',
          stderr: '',
        });

      await manager.getOrCreateChat('proj-1', '项目一');
      await manager.getOrCreateChat('proj-2', '项目二');

      const list = manager.listProjectChats();
      expect(list).toHaveLength(2);
      expect(list.map((c) => c.projectId)).toEqual(['proj-1', 'proj-2']);
    });
  });

  describe('persistence', () => {
    it('saves and loads chats', async () => {
      vi.mocked(proc.run)
        .mockResolvedValueOnce({ code: 0, stdout: '{"chats":[]}', stderr: '' })
        .mockResolvedValueOnce({
          code: 0,
          stdout: '{"success":true,"result":{"openConversationId":"cid-persist"}}',
          stderr: '',
        });

      await manager.getOrCreateChat('proj-persist', '持久化测试');
      manager.addInboxMessage('proj-persist', 'user1', 'hello', Date.now());

      const newManager = new ProjectChatManager(tempDir);
      newManager.load();

      const chats = newManager.listProjectChats();
      expect(chats).toHaveLength(1);
      expect(chats[0].projectId).toBe('proj-persist');
      expect(chats[0].chatId).toBe('cid-persist');
      expect(chats[0].inbox).toHaveLength(1);
      expect(chats[0].inbox[0].content).toBe('hello');
    });
  });

  describe('durable persistence', () => {
    it('a poisoned temp path makes save fail without damaging the state file', async () => {
      vi.mocked(proc.run)
        .mockResolvedValueOnce({ code: 0, stdout: '{"chats":[]}', stderr: '' })
        .mockResolvedValueOnce({
          code: 0,
          stdout: '{"success":true,"result":{"openConversationId":"cid-a"}}',
          stderr: '',
        });

      const file = path.join(tempDir, 'project-chats.json');
      manager.save();
      const before = fs.readFileSync(file, 'utf8');

      // A tmp+rename writer hits EISDIR here and the real file survives.
      // A direct writer would silently overwrite the state instead.
      fs.mkdirSync(file + '.tmp');
      await expect(manager.getOrCreateChat('proj-x', 'X')).rejects.toThrow();
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
    });

    it('save leaves no temp files behind', () => {
      manager.save();
      expect(
        fs.readdirSync(tempDir).filter((f) => f.includes('.tmp'))
      ).toHaveLength(0);
    });

    it('preserves a corrupt state file instead of silently starting fresh', () => {
      const file = path.join(tempDir, 'project-chats.json');
      fs.writeFileSync(file, '{truncated');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      manager.load();

      const preserved = fs
        .readdirSync(tempDir)
        .filter((f) => f.startsWith('project-chats.json.corrupt'));
      expect(preserved).toHaveLength(1);
      expect(
        fs.readFileSync(path.join(tempDir, preserved[0]), 'utf8')
      ).toBe('{truncated');
      expect(fs.existsSync(file)).toBe(false);
      expect(warn).toHaveBeenCalled();
      expect(manager.listProjectChats()).toEqual([]);
    });

    it('a missing state file loads fresh without preserving anything', () => {
      manager.load();
      expect(fs.readdirSync(tempDir)).toHaveLength(0);
      expect(manager.listProjectChats()).toEqual([]);
    });
  });

  describe('inbox', () => {
    beforeEach(async () => {
      vi.mocked(proc.run)
        .mockResolvedValueOnce({ code: 0, stdout: '{"chats":[]}', stderr: '' })
        .mockResolvedValueOnce({
          code: 0,
          stdout: '{"success":true,"result":{"openConversationId":"cid-inbox"}}',
          stderr: '',
        });
      await manager.getOrCreateChat('proj-inbox', '收件箱测试');
    });

    it('adds inbox messages', () => {
      manager.addInboxMessage('proj-inbox', 'user1', 'message 1', Date.now());
      manager.addInboxMessage('proj-inbox', 'user2', 'message 2', Date.now());

      const unread = manager.getUnreadMessages('proj-inbox');
      expect(unread).toHaveLength(2);
      expect(unread[0].content).toBe('message 1');
      expect(unread[1].content).toBe('message 2');
    });

    it('marks messages as read', () => {
      manager.addInboxMessage('proj-inbox', 'user1', 'msg', Date.now());
      expect(manager.getUnreadCount('proj-inbox')).toBe(1);

      manager.markAsRead('proj-inbox');
      expect(manager.getUnreadCount('proj-inbox')).toBe(0);
    });

    it('claims unread messages once (first claim wins)', () => {
      manager.addInboxMessage('proj-inbox', 'user1', '指令一', Date.now());
      manager.addInboxMessage('proj-inbox', 'user2', '指令二', Date.now());

      const claimed = manager.claimUnread('proj-inbox');
      expect(claimed.map((m) => m.content)).toEqual(['指令一', '指令二']);

      const second = manager.claimUnread('proj-inbox');
      expect(second).toHaveLength(0);
    });

    it('re-claims a message after its 60s lease expires', () => {
      vi.useFakeTimers();
      try {
        manager.addInboxMessage('proj-inbox', 'user1', '会过期的指令', 1);

        const first = manager.claimUnread('proj-inbox');
        expect(first).toHaveLength(1);

        vi.advanceTimersByTime(60_000);
        expect(manager.claimUnread('proj-inbox')).toHaveLength(0);

        vi.advanceTimersByTime(1_000);
        const reclaimed = manager.claimUnread('proj-inbox');
        expect(reclaimed.map((m) => m.content)).toEqual(['会过期的指令']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('acknowledge marks messages read so they are never re-claimed', () => {
      vi.useFakeTimers();
      try {
        manager.addInboxMessage('proj-inbox', 'user1', '已处理的指令', 1);
        const claimed = manager.claimUnread('proj-inbox');

        manager.acknowledge('proj-inbox', claimed.map((m) => m.id));
        expect(manager.getUnreadCount('proj-inbox')).toBe(0);

        vi.advanceTimersByTime(120_000);
        expect(manager.claimUnread('proj-inbox')).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('releaseLease returns a claimed message to the pool immediately', () => {
      manager.addInboxMessage('proj-inbox', 'user1', '写失败的指令', 1);
      const claimed = manager.claimUnread('proj-inbox');

      manager.releaseLease('proj-inbox', claimed.map((m) => m.id));
      const again = manager.claimUnread('proj-inbox');
      expect(again.map((m) => m.content)).toEqual(['写失败的指令']);
    });

    it('returns empty claim for unknown project', () => {
      expect(manager.claimUnread('no-such-project')).toHaveLength(0);
    });

    it('caps inbox at 100 messages', () => {
      for (let i = 0; i < 110; i++) {
        manager.addInboxMessage('proj-inbox', 'user', `msg-${i}`, Date.now());
      }

      const chat = manager.getProjectByChatId('cid-inbox');
      expect(chat?.inbox).toHaveLength(100);
    });
  });

  describe('echo filter', () => {
    beforeEach(async () => {
      vi.mocked(proc.run)
        .mockResolvedValueOnce({ code: 0, stdout: '{"chats":[]}', stderr: '' })
        .mockResolvedValueOnce({
          code: 0,
          stdout: '{"success":true,"result":{"openConversationId":"cid-echo"}}',
          stderr: '',
        });
      await manager.getOrCreateChat('proj-echo', '回显测试');
    });

    it('records and detects self-sent content', () => {
      manager.recordSentContent('你好！');
      expect(manager.wasSentByAgent('你好！')).toBe(true);
      expect(manager.wasSentByAgent('陌生消息')).toBe(false);
    });

    it('matches echoes whose whitespace was reformatted by DingTalk', () => {
      manager.recordSentContent('任务已完成 80%，剩余测试待跑。');
      expect(
        manager.wasSentByAgent('任务已完成 80%，\n 剩余测试待跑。')
      ).toBe(true);
    });

    it('matches a truncated echo of a long sent message', () => {
      manager.recordSentContent(
        '已完成登录模块重构，覆盖单测、集成测试与灰度开关，下一阶段做性能回归。'
      );
      expect(
        manager.wasSentByAgent('已完成登录模块重构，覆盖单测、集成测试与灰度开关')
      ).toBe(true);
    });

    it('does not flag short user messages that merely overlap sent text', () => {
      manager.recordSentContent(
        '已完成登录模块重构，覆盖单测、集成测试与灰度开关，下一阶段做性能回归。'
      );
      expect(manager.wasSentByAgent('重构')).toBe(false);
      expect(manager.wasSentByAgent('继续完成任务')).toBe(false);
    });

    it('getChatByProjectId returns the chat', () => {
      const chat = manager.getChatByProjectId('proj-echo');
      expect(chat?.chatId).toBe('cid-echo');
    });
  });

  describe('workdir binding', () => {
    beforeEach(async () => {
      vi.mocked(proc.run)
        .mockResolvedValueOnce({ code: 0, stdout: '{"chats":[]}', stderr: '' })
        .mockResolvedValueOnce({
          code: 0,
          stdout: '{"success":true,"result":{"openConversationId":"cid-wd"}}',
          stderr: '',
        });
      await manager.getOrCreateChat('proj-wd', '目录绑定');
    });

    it('setWorkdir updates chat and persists', () => {
      manager.setWorkdir('proj-wd', '/Users/me/code/proj');

      expect(manager.getChatByProjectId('proj-wd')?.workdir).toBe(
        '/Users/me/code/proj'
      );

      const reloaded = new ProjectChatManager(tempDir);
      reloaded.load();
      expect(reloaded.getChatByProjectId('proj-wd')?.workdir).toBe(
        '/Users/me/code/proj'
      );
    });

    it('getProjectByWorkdir finds chat by exact workdir match', () => {
      manager.setWorkdir('proj-wd', '/Users/me/code/proj');

      expect(manager.getProjectByWorkdir('/Users/me/code/proj')?.projectId).toBe(
        'proj-wd'
      );
      expect(manager.getProjectByWorkdir('/Users/me/other')).toBeUndefined();
    });

    it('getProjectByWorkdir matches a symlinked dir to its real path', () => {
      const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtmcp-real-'));
      const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), 'dtmcp-link-'));
      const linkPath = path.join(linkParent, 'alias');
      fs.symlinkSync(realDir, linkPath, 'dir');

      manager.setWorkdir('proj-wd', linkPath);

      expect(manager.getProjectByWorkdir(fs.realpathSync(realDir))?.projectId).toBe(
        'proj-wd'
      );

      fs.rmSync(linkParent, { recursive: true, force: true });
      fs.rmSync(realDir, { recursive: true, force: true });
    });

    it('load tolerates old files without workdir field', () => {
      fs.writeFileSync(
        path.join(tempDir, 'project-chats.json'),
        JSON.stringify({
          nextInboxId: 2,
          chats: [
            {
              projectId: 'legacy',
              projectTitle: '旧项目',
              chatId: 'cid-legacy',
              questionIds: [],
              createdAt: 1,
              lastActiveAt: 1,
              inbox: [],
            },
          ],
        })
      );

      const reloaded = new ProjectChatManager(tempDir);
      reloaded.load();

      const chat = reloaded.getChatByProjectId('legacy');
      expect(chat).toBeDefined();
      expect(chat?.workdir).toBeUndefined();
    });
  });
});
