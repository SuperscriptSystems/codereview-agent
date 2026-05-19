import { createOpencodeClient } from '@opencode-ai/sdk';
const client = createOpencodeClient({ baseUrl: 'http://localhost' });
const p = client.session.prompt;
