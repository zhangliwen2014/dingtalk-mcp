export class FakeTransport {
    sentMessages = [];
    sentGroupMessages = [];
    groupMessages = [];
    resolveTargetResult = 'fake-target';
    async sendText(target, text) {
        this.sentMessages.push({ target, text });
    }
    async sendToGroupChat(chatId, text) {
        this.sentGroupMessages.push({ chatId, text });
    }
    async pollGroupMessages(_chatId) {
        return [...this.groupMessages];
    }
    setGroupMessages(messages) {
        this.groupMessages = messages;
    }
    async resolveTarget(name) {
        return this.resolveTargetResult;
    }
    setResolveTargetResult(target) {
        this.resolveTargetResult = target;
    }
    clear() {
        this.sentMessages = [];
        this.sentGroupMessages = [];
    }
}
//# sourceMappingURL=fake-transport.js.map