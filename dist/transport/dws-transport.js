import * as proc from '../platform/proc.js';
export class DwsTransport {
    async sendText(target, text) {
        const result = await proc.run([
            'dws',
            'chat',
            '+dm',
            '--to',
            target,
            '--content',
            text,
            '--format',
            'json',
            '--yes'
        ]);
        if (result.code !== 0) {
            throw new Error(`dws sendText failed: ${result.stderr}`);
        }
    }
    async sendToGroupChat(chatId, text) {
        const result = await proc.run([
            'dws',
            'chat',
            '+send-to-group',
            '--group',
            chatId,
            '--content',
            text,
            '--format',
            'json',
            '--yes'
        ]);
        if (result.code !== 0) {
            throw new Error(`dws sendToGroupChat failed: ${result.stderr}`);
        }
    }
    async pollGroupMessages(chatId) {
        const result = await proc.run([
            'dws',
            'chat',
            '+chat-messages',
            '--group',
            chatId,
            '--limit',
            '50',
            '--format',
            'json',
        ]);
        if (result.code !== 0) {
            throw new Error(`dws pollGroupMessages failed: ${result.stderr}`);
        }
        let data;
        try {
            data = JSON.parse(result.stdout);
        }
        catch (err) {
            throw new Error(`dws pollGroupMessages bad JSON: ${String(err)}`);
        }
        const messages = Array.isArray(data.messages) ? data.messages : [];
        return messages.map((m) => ({
            messageId: String(m.messageId),
            content: m.text ?? '',
            senderId: m.senderId ?? 'unknown',
            timestamp: m.createTime ? new Date(m.createTime).getTime() : Date.now(),
            fromAgent: m.messageAiSendFlag === 'DWS',
        }));
    }
    async resolveTarget(name) {
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
//# sourceMappingURL=dws-transport.js.map