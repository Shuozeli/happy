import { HappyClient } from './HappyClient.js';
import type { SessionSnapshot } from './types.js';

export class InterruptController {
    constructor(private readonly client: HappyClient) {}

    async sendMessage(session: SessionSnapshot, message: string): Promise<void> {
        const userMessage = {
            role: 'user',
            content: { type: 'text', text: message },
        };
        await this.client.sendMessages(session.id, session.encryptionKey, session.encryptionVariant, [userMessage]);
    }
}
