import { IpcClient } from './dist/daemon/client.js';
import * as ipc from './dist/platform/ipc.js';
import * as identity from './dist/platform/identity.js';

async function main() {
  const instanceId = identity.instanceId();
  const ipcEndpoint = ipc.endpoint(instanceId);

  const client = new IpcClient(ipcEndpoint);
  await client.connect();

  console.log('✓ 连接到 daemon');

  // Send a test question
  console.log('\n发送问题到手机钉钉...');
  const result = await client.request('ask', {
    question: '1+1等于几？',
    target: '016825045624390379',
  });

  console.log('✓ 问题已发送');
  console.log('  Question ID:', result.id);
  console.log('  Status:', result.status);
  console.log('\n请在手机钉钉上回复这个问题');
  console.log('回复格式：#' + result.id + ': 你的答案');
  console.log('\n等待回答中（轮询间隔 3 秒）...');

  // Poll for answer
  let checks = 0;
  while (checks < 20) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    checks++;
    const check = await client.request('check', { id: result.id });
    
    if (check.status === 'answered') {
      console.log('\n✓✓✓ 收到回答！');
      console.log('  答案:', check.answer);
      console.log('  来源:', check.answeredVia);
      console.log('  检查次数:', checks);
      break;
    } else {
      process.stdout.write('.');
    }
  }

  if (checks >= 20) {
    console.log('\n✗ 超时，未收到回答');
  }

  await client.disconnect();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
