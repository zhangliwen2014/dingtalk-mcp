import { DingTransport, InboundMessage } from './ding-transport.js';
import * as proc from '../platform/proc.js';

export class DwsTransport implements DingTransport {
  async sendText(target: string, text: string): Promise<void> {
    const result = await proc.run([
      'dws',
      'chat',
      '+dm',
      '--to',
      target,
      '--content',
      text,
      '--format',
      'json'
    ]);

    if (result.code !== 0) {
      throw new Error(`dws sendText failed: ${result.stderr}`);
    }
  }

  async listen(handler: (message: InboundMessage) => void): Promise<void> {
    // TODO: Implement after V2 verification
    // spawn `dws event +listen-im --kind all-direct --flatten -f ndjson`
    // parse ndjson stream and call handler for each message
    throw new Error('DwsTransport.listen not yet implemented (pending V2 verification)');
  }

  async resolveTarget(name: string): Promise<string> {
    const result = await proc.run([
      'dws',
      'contact',
      'user',
      'search',
      '--query',
      name,
      '--format',
      'json'
    ]);

    if (result.code !== 0) {
      throw new Error(`dws resolveTarget failed: ${result.stderr}`);
    }

    // TODO: Parse JSON output and extract userId
    // For now, return the name as-is (will be refined after V1 verification)
    return name;
  }
}
