import { IpcClient } from './dist/daemon/client.js';
import * as ipc from './dist/platform/ipc.js';
import * as identity from './dist/platform/identity.js';

async function main() {
  const instanceId = identity.instanceId();
  const ipcEndpoint = ipc.endpoint(instanceId);

  const client = new IpcClient(ipcEndpoint);
  await client.connect();

  console.log('Connected to daemon');

  // Send a test question
  const result = await client.request('ask', {
    question: '保留备份还是删除？',
    target: '016825045624390379',
  });

  console.log('Question sent:', result);
  console.log('Question ID:', result.id);
  console.log('\n请在手机钉钉上回复这个问题');
  console.log('回复格式：#Q' + result.id + ': 你的答案');
  console.log('\n等待回答中...');

  // Poll for answer
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const check = await client.request('check', { id: result.id });
    console.log('Status:', check.status);

    if (check.status === 'answered') {
      console.log('\n✓ 收到回答:', check.answer);
      console.log('回答来源:', check.answeredVia);
      break;
    }
  }

  await client.disconnect();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
